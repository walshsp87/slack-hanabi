'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/game');
const R = require('../src/render');

// Deterministic RNG so tests are repeatable.
function seeded(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const PLAYERS = ['U1', 'U2', 'U3', 'U4', 'U5'];
const newGame = (n = 3, seed = 1, variant) =>
  E.createGame({ channel: 'C1', players: PLAYERS.slice(0, n), rng: seeded(seed), variant });

function cardCount(g) {
  const inHands = Object.values(g.hands).reduce((a, h) => a + h.length, 0);
  const played = Object.values(g.fireworks).reduce((a, b) => a + b, 0);
  return inHands + g.deck.length + g.discards.length + played;
}

test('deck composition: 50 cards, 60 with rainbow', () => {
  assert.equal(E.buildDeck(E.colorsFor('standard')).length, 50);
  assert.equal(E.buildDeck(E.colorsFor('rainbow')).length, 60);
  const reds = E.buildDeck(E.colorsFor('standard')).filter((c) => c.color === 'red').map((c) => c.rank);
  assert.deepEqual(reds, [1, 1, 1, 2, 2, 3, 3, 4, 4, 5]);
});

test('hand sizes: 5 cards for 2-3 players, 4 for 4-5', () => {
  for (const [n, size] of [[2, 5], [3, 5], [4, 4], [5, 4]]) {
    const g = newGame(n);
    for (const p of g.players) assert.equal(g.hands[p].length, size);
    assert.equal(cardCount(g), 50);
  }
  assert.throws(() => newGame(1), E.GameError);
});

test('turn order is enforced', () => {
  const g = newGame(3);
  const notMe = g.players[1];
  assert.throws(() => E.play(g, notMe, 0), /not your turn/);
  assert.throws(() => E.play(g, 'UX', 0), /not a player/);
});

test('cannot discard at 8 clues; discarding regains a clue', () => {
  const g = newGame(3);
  const p = E.currentPlayer(g);
  assert.throws(() => E.discard(g, p, 0), /can't discard/);
  const target = g.players[1];
  const color = g.hands[target][0].color;
  E.clue(g, p, target, 'color', color);
  assert.equal(g.clues, 7);
  E.discard(g, g.players[1], 0);
  assert.equal(g.clues, 8);
});

test('clues mark only the touched cards and must touch a card', () => {
  const g = newGame(2);
  const [a, b] = g.players;
  const hand = g.hands[b];
  const color = hand[2].color;
  const missing = g.colors.find((c) => !hand.some((x) => x.color === c));
  if (missing) assert.throws(() => E.clue(g, a, b, 'color', missing), /at least one/);
  assert.throws(() => E.clue(g, a, a, 'color', color), /yourself/);
  const ev = E.clue(g, a, b, 'color', color);
  hand.forEach((c, i) => {
    if (ev.slots.includes(i)) assert.equal(c.knownColor, color);
    else assert.equal(c.knownColor, null); // no "not blue" deductions recorded
    assert.ok(!('notColors' in c));
  });
});

test('no clues left means you cannot clue', () => {
  const g = newGame(2);
  g.clues = 0;
  const [a, b] = g.players;
  assert.throws(() => E.clue(g, a, b, 'rank', g.hands[b][0].rank), /No clue tokens/);
});

test('playing: success, misfire, and 5 returns a clue', () => {
  const g = newGame(2);
  const [a, b] = g.players;
  // Rig a's hand.
  g.hands[a][0] = { ...g.hands[a][0], color: 'red', rank: 1 };
  E.play(g, a, 0);
  assert.equal(g.fireworks.red, 1);
  g.hands[b][0] = { ...g.hands[b][0], color: 'blue', rank: 3 };
  E.play(g, b, 0);
  assert.equal(g.fuses, 1);
  assert.equal(g.discards.at(-1).color, 'blue');
  g.fireworks.green = 4;
  g.clues = 5;
  g.hands[a][0] = { ...g.hands[a][0], color: 'green', rank: 5 };
  const ev = E.play(g, a, 0);
  assert.ok(ev.success && ev.bonusClue);
  assert.equal(g.clues, 6);
});

test('third fuse loses with score 0', () => {
  const g = newGame(2);
  g.fireworks.red = 3;
  g.fuses = 2;
  const p = E.currentPlayer(g);
  g.hands[p][0] = { ...g.hands[p][0], color: 'white', rank: 5 };
  E.play(g, p, 0);
  assert.equal(g.status, 'lost');
  assert.equal(E.score(g), 0);
});

test('final round: everyone, including the last drawer, gets exactly one more turn', () => {
  const g = newGame(3);
  g.deck = g.deck.slice(0, 1); // one card left
  g.clues = 4;
  const order = [];
  // Turn 1 draws the last card.
  order.push(E.currentPlayer(g));
  E.discard(g, E.currentPlayer(g), 0);
  assert.equal(g.deck.length, 0);
  assert.equal(g.finalTurnsLeft, 3);
  while (g.status === 'active') {
    const p = E.currentPlayer(g);
    order.push(p);
    const target = g.players.find((x) => x !== p);
    E.clue(g, p, target, 'rank', g.hands[target][0].rank);
    g.clues = 4;
  }
  assert.equal(g.status, 'finished');
  assert.equal(order.length, 4); // last drawer + 3 final turns
  assert.equal(order[0], order[3]); // the drawer gets the final turn
});

test('perfect game ends immediately as won', () => {
  const g = newGame(2);
  for (const c of g.colors) g.fireworks[c] = 5;
  g.fireworks.white = 4;
  const p = E.currentPlayer(g);
  g.hands[p][0] = { ...g.hands[p][0], color: 'white', rank: 5 };
  E.play(g, p, 0);
  assert.equal(g.status, 'won');
  assert.equal(E.score(g), 25);
});

test('random games always terminate and conserve cards', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rng = seeded(seed * 7);
    const n = 2 + (seed % 4);
    const g = newGame(n, seed, seed % 5 === 0 ? 'rainbow' : 'standard');
    const total = g.variant === 'rainbow' ? 60 : 50;
    let guard = 0;
    while (g.status === 'active') {
      assert.ok(guard++ < 500, 'game did not terminate');
      const p = E.currentPlayer(g);
      const slot = Math.floor(rng() * g.hands[p].length);
      const roll = rng();
      try {
        if (roll < 0.3) E.play(g, p, slot);
        else if (roll < 0.65) E.discard(g, p, slot);
        else {
          const others = g.players.filter((x) => x !== p);
          const t = others[Math.floor(rng() * others.length)];
          E.clue(g, p, t, 'rank', g.hands[t][0].rank);
        }
      } catch (e) {
        assert.ok(e instanceof E.GameError);
        if (g.clues > 0 && g.clues < 8) throw e; // only token limits should block these moves
        if (g.clues >= 8) {
          const t = g.players.find((x) => x !== p);
          E.clue(g, p, t, 'rank', g.hands[t][0].rank);
        } else E.discard(g, p, slot);
      }
      assert.equal(cardCount(g), total);
      assert.ok(g.clues >= 0 && g.clues <= 8);
    }
    assert.ok(['won', 'finished', 'lost'].includes(g.status));
  }
});

test('assessPlay judges from clue marks only, never the real card', () => {
  const g = newGame(2);
  g.fireworks.red = 2;
  const card = (knownColor, knownRank, real = { color: 'blue', rank: 1 }) => ({ id: 0, ...real, knownColor, knownRank });
  assert.equal(E.assessPlay(g, card('red', 3)).level, 'sure');
  assert.equal(E.assessPlay(g, card('red', 2)).reason, 'already-played');
  assert.equal(E.assessPlay(g, card('red', 5)).reason, 'too-early');
  assert.equal(E.assessPlay(g, card(null, 3)).level, 'unsure'); // only red is ready for a 3
  assert.equal(E.assessPlay(g, card(null, 1)).level, 'unsure'); // red isn't ready for a 1
  assert.equal(E.assessPlay(g, card(null, 4)).reason, 'no-stack-ready');
  assert.equal(E.assessPlay(g, card(null, null)).level, 'unsure');
  // The real card is irrelevant: an unmarked card that would play still warns.
  assert.equal(E.assessPlay(g, card(null, null, { color: 'red', rank: 3 })).level, 'unsure');
  const fresh = newGame(2);
  assert.equal(E.assessPlay(fresh, card(null, 1)).level, 'sure'); // every firework is ready for a 1
});

test('play buttons: no confirm when marks prove it, warning otherwise; no clue buttons at 0 clues', () => {
  const g = newGame(2);
  const me = E.currentPlayer(g);
  g.hands[me][0].knownRank = 1; // proven: all fireworks empty
  g.fuses = 2;
  const view = R.modalView(g, me, null, { shown: g.players });
  const play = view.blocks.find((b) => b.block_id === 'hanabi_play_row').elements;
  assert.equal(play[0].confirm, undefined);
  assert.ok(play[1].confirm);
  assert.match(play[1].confirm.text.text, /third fuse/);
  assert.ok(view.blocks.some((b) => b.block_id?.startsWith('hanabi_clue_row_')));

  g.clues = 0;
  const empty = R.modalView(g, me, null, { shown: g.players });
  assert.ok(!empty.blocks.some((b) => b.block_id?.startsWith('hanabi_clue_row_')));
  assert.ok(JSON.stringify(empty.blocks).includes('No clue tokens left'));
});

test('teammate hands are hidden by default, next player first, and revealable', () => {
  const g = newGame(4);
  const me = g.players[2];
  const next = g.players[3];
  const real = /[🔴🟡🟢🔵⚪]\d/u;
  const sections = (v) => v.blocks.filter((b) => b.type === 'section' && b.text).map((b) => b.text.text);

  const hidden = R.modalView(g, me);
  const rows = sections(hidden).filter((t) => t.startsWith('*<@'));
  assert.ok(rows[0].includes(next), 'next player is listed first');
  assert.ok(rows.every((t) => t.includes('_hidden_') && !real.test(t)));
  assert.ok(!hidden.blocks.some((b) => b.block_id?.startsWith('hanabi_clue_row_')), 'no clue buttons for hidden hands');
  assert.deepEqual(JSON.parse(hidden.private_metadata).shown, []);

  const one = R.modalView(g, me, null, { shown: [next] });
  const r1 = sections(one).filter((t) => t.startsWith('*<@'));
  assert.ok(real.test(r1[0]) && r1.slice(1).every((t) => t.includes('_hidden_')));
  assert.deepEqual(JSON.parse(one.private_metadata).shown, [next]);

  // Your own id in "shown" is ignored: your hand never reveals.
  const self = R.modalView(g, me, null, { shown: g.players });
  assert.ok(!JSON.parse(self.private_metadata).shown.includes(me));
});

// ---- Block Kit sanity: limits that make Slack reject a payload ----
function checkBlocks(blocks) {
  assert.ok(blocks.length <= 100, 'too many blocks');
  const ids = new Set();
  for (const b of blocks) {
    if (b.type === 'section') {
      if (b.text) assert.ok(b.text.text.length <= 3000);
      if (b.fields) {
        assert.ok(b.fields.length <= 10, 'too many fields');
        for (const f of b.fields) assert.ok(f.text.length <= 2000);
      }
    }
    if (b.type === 'actions') {
      assert.ok(b.elements.length <= 25);
      for (const el of b.elements) {
        assert.ok(el.text.text.length <= 75);
        assert.ok(!ids.has(el.action_id), `duplicate action_id ${el.action_id}`);
        ids.add(el.action_id);
        assert.ok((el.value || '').length <= 2000);
        if (el.confirm) assert.ok(el.confirm.text.text.length <= 300);
      }
    }
  }
}

test('table grid shows every color with its firework and discards', () => {
  const g = newGame(3, 3, 'rainbow');
  g.fireworks.red = 2;
  g.discards.push({ color: 'red', rank: 4 }, { color: 'red', rank: 1 });
  const fields = R.tableBlocks(g).filter((b) => b.fields).flatMap((b) => b.fields.map((f) => f.text));
  assert.equal(fields.length, 2 + g.colors.length * 2);
  assert.match(fields[2], /🔴 ▰▰▱▱▱ \*2\*/);
  assert.equal(fields[3], '🔴 1  4');
  assert.equal(fields[5], '—');
});

test('views stay within Slack limits and never leak your own cards', () => {
  for (const n of [2, 3, 4, 5]) {
    for (const variant of ['standard', 'rainbow']) {
      const g = newGame(n, n, variant);
      g.clues = 4;
      checkBlocks(R.boardBlocks(g));
      for (const viewer of [...g.players, 'USPECTATOR']) {
        const view = R.modalView(g, viewer, 'hello', { shown: g.players });
        checkBlocks(view.blocks);
        assert.ok(view.title.text.length <= 24);
        if (g.players.includes(viewer)) {
          const mine = view.blocks.find((b) => b.type === 'section' && b.text?.text.startsWith('*Your hand*'));
          // Unclued hand renders as all unknowns.
          assert.ok(!/[🔴🟡🟢🔵⚪🌈][1-5]/u.test(mine.text.text));
          // No button value encodes a card in your hand.
          const json = JSON.stringify(view.blocks.filter((b) => b.type === 'actions'));
          assert.ok(!/"color":|"rank":/.test(json));
        }
      }
    }
  }
});
