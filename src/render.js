'use strict';
/** Block Kit rendering. Everything that turns game state into Slack UI lives here. */
const E = require('./game');

const EMOJI = { red: '🔴', yellow: '🟡', green: '🟢', blue: '🔵', white: '⚪', rainbow: '🌈' };
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const at = (u) => `<@${u}>`;
const cardText = (c) => `${EMOJI[c.color]}${c.rank}`;
const plain = (text) => ({ type: 'plain_text', text, emoji: true });
const md = (text) => ({ type: 'mrkdwn', text });
const section = (text) => ({ type: 'section', text: md(text) });
const context = (text) => ({ type: 'context', elements: [md(text)] });
const divider = { type: 'divider' };
const slotTag = (i) => `\`${i + 1}\``;

// ---------- small pieces ----------

// Direct clue marks only: no deductions from what a card is *not*.
const knowledge = (card) => `${card.knownColor ? EMOJI[card.knownColor] : '❔'}${card.knownRank || '?'}`;

const knownHand = (g, p) => g.hands[p].map((c, i) => `${slotTag(i)} ${knowledge(c)}`).join('   ');
const actualHand = (g, p) => g.hands[p].map((c, i) => `${slotTag(i)} ${cardText(c)}`).join('   ');
const tokensLine = (g) =>
  `💡 Clues *${g.clues}/${E.MAX_CLUES}*     💣 Fuses *${g.fuses}/${E.MAX_FUSES}*     🂠 Deck *${g.deck.length}*`;

const bar = (n) => '▰'.repeat(n) + '▱'.repeat(5 - n);

/**
 * The shared table as a two-column grid: each color's firework on the left,
 * its discarded cards on the right. Slack caps a section at 10 fields, so
 * longer grids are split across sections (rows stay aligned).
 */
function tableBlocks(g) {
  const fields = [md('*🎆 Fireworks*'), md(`*🗑️ Discards* (${g.discards.length})`)];
  for (const c of g.colors) {
    const n = g.fireworks[c];
    const gone = g.discards.filter((d) => d.color === c).map((d) => d.rank).sort((a, b) => a - b);
    fields.push(md(`${EMOJI[c]} ${bar(n)} *${n}*`), md(gone.length ? `${EMOJI[c]} ${gone.join('  ')}` : '—'));
  }
  const blocks = [];
  for (let i = 0; i < fields.length; i += 10) blocks.push({ type: 'section', fields: fields.slice(i, i + 10) });
  blocks.push(section(tokensLine(g)));
  return blocks;
}

function finalRoundNote(g) {
  if (g.status !== 'active' || g.finalTurnsLeft === null) return '';
  const n = g.finalTurnsLeft;
  return `⏳ Deck is empty: ${n} final turn${n === 1 ? '' : 's'} left.`;
}

function describeEvent(g, e) {
  const who = at(e.player);
  switch (e.type) {
    case 'play':
      return e.success
        ? `${who} played ${cardText(e.card)} from slot ${e.slot + 1} ✨${e.bonusClue ? ' Firework complete, +1 clue!' : ''}`
        : `${who} tried to play ${cardText(e.card)} from slot ${e.slot + 1} 💥 Misfire! (${e.fuses}/${E.MAX_FUSES} fuses)`;
    case 'discard':
      return `${who} discarded ${cardText(e.card)} from slot ${e.slot + 1} (+1 clue)`;
    case 'clue': {
      const slots = e.slots.map((s) => s + 1);
      const many = slots.length > 1;
      const what =
        e.kind === 'color'
          ? `${many ? 'are' : 'is'} ${EMOJI[e.value]} *${cap(e.value)}*`
          : `${many ? 'are' : 'is a'} *${e.value}*${many ? 's' : ''}`;
      return `${who} ➜ ${at(e.target)}: slot${many ? 's' : ''} ${slots.join(', ')} ${what}`;
    }
    case 'abandon':
      return `${who} ended the game.`;
    default:
      return '';
  }
}

function gameOverText(g) {
  const s = E.score(g);
  const m = E.maxScore(g);
  switch (g.status) {
    case 'lost':
      return `💥 *The third fuse blew. The show is ruined: 0 points.*\n_${E.rating(0, m)}_`;
    case 'won':
      return `🎆 *PERFECT SHOW! ${s}/${m}*\n_${E.rating(s, m)}_`;
    case 'finished':
      return `🎇 *The show is over! Final score: ${s}/${m}*\n_${E.rating(s, m)}_`;
    case 'abandoned':
      return `🛑 *Game abandoned* at ${s}/${m}.`;
    default:
      return '';
  }
}

const boardFallback = (g) =>
  g.status === 'active' ? `Hanabi: ${at(E.currentPlayer(g))}'s turn` : `Hanabi: game over (${E.score(g)}/${E.maxScore(g)})`;

// ---------- public board (channel message) ----------

function boardBlocks(g) {
  const active = g.status === 'active';
  const cur = E.currentPlayer(g);
  const blocks = [
    { type: 'header', text: plain(`🎆 Hanabi${g.variant === 'rainbow' ? ' · Rainbow' : ''}`) },
    ...tableBlocks(g),
  ];
  if (active) {
    blocks.push(section(`👉 *${at(cur)}'s turn*${finalRoundNote(g) ? `\n${finalRoundNote(g)}` : ''}`));
  } else {
    blocks.push(section(gameOverText(g)));
  }
  blocks.push(divider);

  for (const p of g.players) {
    const marker = active && p === cur ? '👉 ' : '';
    const hand = active ? knownHand(g, p) : actualHand(g, p);
    blocks.push(section(`${marker}${at(p)}\n${hand}`));
  }
  blocks.push(
    context(
      active
        ? 'Hands above show direct clue marks only; anything else is yours to remember. Tap *Open my table* to see your teammates’ real cards.'
        : 'Final hands revealed.',
    ),
  );
  blocks.push(divider);

  const recent = g.log.slice(-3).map((e) => describeEvent(g, e)).filter(Boolean);
  if (recent.length) blocks.push(context(`*Recent:*\n${recent.join('\n')}`));

  if (active) {
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', text: plain('🃏 Open my table'), action_id: 'hanabi_open', value: g.id },
        { type: 'button', text: plain('📖 Rules'), action_id: 'hanabi_rules', value: g.id },
      ],
    });
  }
  return blocks;
}

// ---------- private table (modal) ----------

const btnValue = (obj) => JSON.stringify(obj);

/** "Are you sure?" for any play the player's own clue marks don't prove. */
function playWarning(g, card, i) {
  const a = E.assessPlay(g, card);
  if (a.level === 'sure') return null;
  const lastFuse = g.fuses === E.MAX_FUSES - 1 ? ' This would be the third fuse and end the game at 0.' : ' A misfire burns a fuse.';
  let title = 'Not certain this plays';
  let why;
  if (a.level === 'bad') {
    title = 'This will misfire';
    if (a.reason === 'already-played') why = `Your marks say ${EMOJI[a.color]}${a.rank}, but ${a.color} is already at ${a.at}.`;
    else if (a.reason === 'too-early') why = `Your marks say ${EMOJI[a.color]}${a.rank}, but ${a.color} is only at ${a.at}.`;
    else if (a.reason === 'no-stack-ready') why = `Your marks say it's a ${a.rank}, but no firework is ready for a ${a.rank}.`;
    else why = `Your marks say ${a.color}, but that firework is complete.`;
  } else {
    why = `Slot ${i + 1} is marked ${knowledge(card)}. Your clues don't prove it fits a firework right now.`;
  }
  return confirm(title, `${why}${lastFuse}`, 'Play anyway');
}
const confirm = (title, text, ok) => ({ title: plain(title), text: plain(text), confirm: plain(ok), deny: plain('Cancel') });

function modalView(g, viewer, notice, ui = { shown: [] }) {
  const active = g.status === 'active';
  const isPlayer = g.players.includes(viewer);
  const cur = E.currentPlayer(g);
  const myTurn = active && cur === viewer;
  const t = g.turn;
  const blocks = [];

  if (notice) blocks.push(section(notice), divider);

  // 1. The table, always on top.
  blocks.push(...tableBlocks(g));
  if (active) {
    const turn = myTurn ? '👉 *It’s your turn.*' : `⏳ Waiting on ${at(cur)}`;
    blocks.push(section([turn, finalRoundNote(g)].filter(Boolean).join('\n')));
  } else {
    blocks.push(section(gameOverText(g)));
  }
  blocks.push(divider);

  // 2. Your hand: clue marks only.
  if (isPlayer) {
    blocks.push(section(active ? `*Your hand* (clue marks)\n${knownHand(g, viewer)}` : `*Your hand was*\n${actualHand(g, viewer)}`));

    if (myTurn) {
      const n = g.hands[viewer].length;
      blocks.push({
        type: 'actions',
        block_id: 'hanabi_play_row',
        elements: g.hands[viewer].map((card, i) => {
          const btn = {
            type: 'button',
            style: 'primary',
            text: plain(`▶ Play ${i + 1}`),
            action_id: `hanabi_play_${i}`,
            value: btnValue({ g: g.id, t, s: i }),
          };
          const warn = playWarning(g, card, i);
          if (warn) btn.confirm = warn; // provably playable cards play with one tap
          return btn;
        }),
      });
      if (g.clues < E.MAX_CLUES) {
        blocks.push({
          type: 'actions',
          block_id: 'hanabi_discard_row',
          elements: Array.from({ length: n }, (_, i) => ({
            type: 'button',
            text: plain(`🗑 Discard ${i + 1}`),
            action_id: `hanabi_discard_${i}`,
            value: btnValue({ g: g.id, t, s: i }),
            confirm: confirm('Discard this card?', `Discard slot ${i + 1} and regain a clue token?`, 'Discard'),
          })),
        });
      } else {
        blocks.push(context('You can’t discard while all 8 clue tokens are available.'));
      }
      if (g.clues === 0) blocks.push(context('No clue tokens left, so you must play or discard.'));
    }
    blocks.push(divider);
  }

  // 3. Teammates, next player first. Hands are hidden by default so a
  //    glance at your screen gives nothing away; reveal one or all.
  const start = isPlayer ? g.players.indexOf(viewer) : g.current - 1;
  const others = g.players
    .map((_, k) => g.players[(start + 1 + k + g.players.length) % g.players.length])
    .filter((p) => p !== viewer);
  const shown = new Set(ui.shown.filter((p) => others.includes(p)));
  const allShown = others.every((p) => shown.has(p));
  const toggle = (label, value, id) => ({ type: 'button', text: plain(label), action_id: id, value: btnValue({ g: g.id, ...value }) });

  blocks.push({
    type: 'section',
    text: md(isPlayer ? '*Teammates*   _next player first_' : '*Players*'),
    accessory: allShown
      ? toggle('🙈 Hide all', { all: 'hide' }, 'hanabi_toggle_all')
      : toggle('👁 Show all', { all: 'show' }, 'hanabi_toggle_all'),
  });

  others.forEach((p, idx) => {
    const next = isPlayer && idx === 0 && active ? '   ⏭ _next_' : '';
    const upNow = active && p === cur ? '   👈 _up now_' : '';
    const visible = shown.has(p) || !active;
    const row = section(`*${at(p)}*${upNow || next}\n${visible ? actualHand(g, p) : `${'🂠 '.repeat(g.hands[p].length)}_hidden_`}`);
    if (active) {
      row.accessory = visible
        ? toggle('🙈 Hide', { p }, `hanabi_toggle_${p}`)
        : toggle('👁 Show', { p }, `hanabi_toggle_${p}`);
    }
    blocks.push(row);
    if (active) blocks.push(context(`Clue marks:   ${knownHand(g, p)}`));

    // Clue buttons only for revealed hands: the buttons themselves reveal cards.
    if (myTurn && g.clues > 0 && visible) {
      const legal = E.legalClues(g, p);
      const mk = (kind, v, label) => {
        const slots = E.touchedSlots(g, p, kind, v).map((x) => x + 1);
        return {
          type: 'button',
          text: plain(label),
          action_id: `hanabi_clue_${p}_${kind}_${v}`,
          value: btnValue({ g: g.id, t, to: p, k: kind, v }),
          confirm: confirm('Give this clue?', `Clue "${label.replace(/^\S+\s/, '')}" touches slot${slots.length > 1 ? 's' : ''} ${slots.join(', ')}. Costs 1 clue token.`, 'Give clue'),
        };
      };
      const elements = [
        ...legal.colors.map((c) => mk('color', c, `${EMOJI[c]} ${cap(c)}`)),
        ...legal.ranks.map((r) => mk('rank', r, `#️⃣ ${r}`)),
      ];
      if (elements.length) blocks.push({ type: 'actions', block_id: `hanabi_clue_row_${p}`, elements });
    } else if (myTurn && g.clues > 0) {
      blocks.push(context('_Show this hand to give a clue._'));
    }
  });

  blocks.push(divider);
  const recent = g.log.slice(-5).map((e) => describeEvent(g, e)).filter(Boolean);
  if (recent.length) blocks.push(context(`*Recent:*\n${recent.join('\n')}`));
  blocks.push({
    type: 'actions',
    elements: [{ type: 'button', text: plain('🔄 Refresh'), action_id: 'hanabi_refresh', value: g.id }],
  });

  return {
    type: 'modal',
    callback_id: 'hanabi_table',
    private_metadata: JSON.stringify({ g: g.id, shown: [...shown] }),
    title: plain(isPlayer ? 'Hanabi: your table' : 'Hanabi (spectating)'),
    close: plain('Close'),
    blocks,
  };
}

// ---------- lobby ----------

function lobbyBlocks(lobby) {
  const variant = lobby.variant === 'rainbow' ? ' (Rainbow variant)' : '';
  if (lobby.status === 'cancelled') return [context('_This Hanabi lobby was closed._')];
  if (lobby.status === 'started') {
    const where = lobby.movedTo ? `in a group DM with the bot (<#${lobby.movedTo}>)` : 'below ⬇️';
    return [section(`🎆 *Hanabi${variant} is underway* with ${lobby.players.map(at).join(', ')}. The board is ${where}.`)];
  }
  const list = lobby.players.length ? lobby.players.map(at).join(', ') : '_nobody yet_';
  return [
    section(`🎆 *${at(lobby.host)} wants to play Hanabi${variant}*\nPlayers (${lobby.players.length}/5): ${list}`),
    context('Cooperative fireworks game for 2–5 players. You see everyone’s cards except your own.'),
    {
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', text: plain('🙋 Join'), action_id: 'hanabi_lobby_join', value: lobby.id },
        { type: 'button', text: plain('Leave'), action_id: 'hanabi_lobby_leave', value: lobby.id },
        { type: 'button', text: plain('🚀 Start game'), action_id: 'hanabi_lobby_start', value: lobby.id },
        { type: 'button', style: 'danger', text: plain('Cancel'), action_id: 'hanabi_lobby_cancel', value: lobby.id },
      ],
    },
  ];
}

// ---------- rules & help ----------

const RULES = [
  '*🎆 Hanabi: the short version*',
  'You’re a team of fireworks makers. Build one firework per color by playing that color’s cards *in order, 1 through 5*.',
  'The catch: you hold your cards facing *away*. You can see every teammate’s cards, never your own.',
  '',
  '*Setup.* 50 cards: each color has three 1s, two each of 2, 3 and 4, and a single 5. Hands are 5 cards with 2–3 players, 4 cards with 4–5. The team shares *8 clue tokens* and *3 fuses*.',
  '',
  '*On your turn, do exactly one thing:*',
  '• *Give a clue* (costs 1 clue token). Pick a teammate and name *one color or one number*; every card of theirs that matches gets pointed out. The clue has to point at least one card.',
  '• *Discard* a card to regain a clue token, then draw. You can’t discard if all 8 tokens are available.',
  '• *Play* a card. If it’s the next number for its color, it joins the firework. If not, it’s discarded and a *fuse burns*. Draw a replacement either way.',
  'Finishing a firework (playing its 5) gives the team a clue token back.',
  '',
  '*The game ends* when the 3rd fuse burns (score 0), when every firework is complete, or after the last card is drawn: everyone, including whoever drew it, gets one final turn.',
  '*Score* = the top card of each firework (max 25, or 30 in Rainbow).',
  '',
  '*Table talk:* the spirit of Hanabi is that the only information you share is through clue tokens. No “hmm, interesting” in the thread. 😉',
  '*Rainbow variant* (`/hanabi new rainbow`): a sixth color, clued as its own color.',
].join('\n');

const HELP = [
  '*Hanabi commands*',
  '`/hanabi new [@players…] [rainbow]` open a lobby (mentioned people are pre-joined)',
  '`/hanabi table` open your private view of the game here',
  '`/hanabi games` list your active games with links',
  '`/hanabi board` repost the board at the bottom of the conversation',
  '`/hanabi rules` show the rules',
  '`/hanabi end` abandon the current game (players only)',
].join('\n');

const rulesView = () => ({
  type: 'modal',
  title: plain('Hanabi rules'),
  close: plain('Got it'),
  blocks: [section(RULES)],
});

module.exports = {
  EMOJI, boardBlocks, boardFallback, modalView, tableBlocks, lobbyBlocks, describeEvent, gameOverText,
  finalRoundNote, rulesView, RULES, HELP, section, context,
};
