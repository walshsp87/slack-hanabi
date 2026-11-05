'use strict';
/**
 * Pure Hanabi rules engine. No Slack code in here, so it's easy to test.
 *
 * Slot numbering: index 0 is the leftmost / newest card. New cards are drawn
 * into slot 0, which matches how most groups hold their hands.
 */
const crypto = require('crypto');

const BASE_COLORS = ['red', 'yellow', 'green', 'blue', 'white'];
const RAINBOW = 'rainbow';
const RANKS = [1, 2, 3, 4, 5];
const RANK_COPIES = { 1: 3, 2: 2, 3: 2, 4: 2, 5: 1 };
const MAX_CLUES = 8;
const MAX_FUSES = 3;

class GameError extends Error {}

const colorsFor = (variant) => (variant === 'rainbow' ? [...BASE_COLORS, RAINBOW] : [...BASE_COLORS]);
const handSizeFor = (n) => (n <= 3 ? 5 : 4);

function buildDeck(colors) {
  const deck = [];
  let id = 0;
  for (const color of colors) {
    for (const rank of RANKS) {
      for (let i = 0; i < RANK_COPIES[rank]; i++) deck.push({ id: id++, color, rank });
    }
  }
  return deck;
}

function shuffle(items, rng = Math.random) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Only direct clue marks are tracked (like tilting a card at the table).
// Negative information ("not blue") is left for players to remember.
const toHandCard = (card) => ({ ...card, knownColor: null, knownRank: null });
const publicCard = (c) => ({ color: c.color, rank: c.rank });

function createGame({ channel, players, variant = 'standard', rng = Math.random, id }) {
  const unique = [...new Set(players)];
  if (unique.length < 2 || unique.length > 5) throw new GameError('Hanabi needs 2 to 5 players.');
  const colors = colorsFor(variant);
  const game = {
    id: id || crypto.randomUUID(),
    channel,
    variant,
    colors,
    players: shuffle(unique, rng), // random seating / first player
    hands: {},
    deck: shuffle(buildDeck(colors), rng),
    fireworks: Object.fromEntries(colors.map((c) => [c, 0])),
    discards: [],
    clues: MAX_CLUES,
    fuses: 0,
    turn: 0,
    current: 0,
    finalTurnsLeft: null,
    status: 'active', // active | won | finished | lost | abandoned
    log: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  for (const p of game.players) game.hands[p] = [];
  const size = handSizeFor(unique.length);
  for (let i = 0; i < size; i++) {
    for (const p of game.players) game.hands[p].unshift(toHandCard(game.deck.pop()));
  }
  return game;
}

const currentPlayer = (g) => g.players[g.current];
const maxScore = (g) => g.colors.length * 5;
const rawScore = (g) => Object.values(g.fireworks).reduce((a, b) => a + b, 0);
const score = (g) => (g.status === 'lost' ? 0 : rawScore(g));

function assertTurn(g, user) {
  if (g.status !== 'active') throw new GameError('This game is over.');
  if (!g.players.includes(user)) throw new GameError("You're not a player in this game.");
  if (currentPlayer(g) !== user) throw new GameError("It's not your turn.");
}

function takeCard(g, user, slot) {
  const hand = g.hands[user];
  if (!Number.isInteger(slot) || slot < 0 || slot >= hand.length) throw new GameError('There is no card in that slot.');
  return hand.splice(slot, 1)[0];
}

function draw(g, user) {
  if (g.deck.length) g.hands[user].unshift(toHandCard(g.deck.pop()));
}

function endTurn(g, event) {
  event.turn = g.turn;
  // Final round: once the last card is drawn, every player (including the
  // one who drew it) gets exactly one more turn.
  if (g.finalTurnsLeft !== null) g.finalTurnsLeft--;
  else if (g.deck.length === 0) g.finalTurnsLeft = g.players.length;

  if (g.fuses >= MAX_FUSES) g.status = 'lost';
  else if (rawScore(g) === maxScore(g)) g.status = 'won';
  else if (g.finalTurnsLeft === 0) g.status = 'finished';

  g.log.push(event);
  if (g.log.length > 300) g.log.shift();
  g.turn++;
  if (g.status === 'active') g.current = (g.current + 1) % g.players.length;
  g.updatedAt = Date.now();
  return event;
}

function play(g, user, slot) {
  assertTurn(g, user);
  const card = takeCard(g, user, slot);
  const event = { type: 'play', player: user, slot, card: publicCard(card) };
  if (g.fireworks[card.color] === card.rank - 1) {
    g.fireworks[card.color] = card.rank;
    event.success = true;
    if (card.rank === 5 && g.clues < MAX_CLUES) {
      g.clues++;
      event.bonusClue = true;
    }
  } else {
    g.discards.push(publicCard(card));
    g.fuses++;
    event.success = false;
    event.fuses = g.fuses;
  }
  draw(g, user);
  return endTurn(g, event);
}

function discard(g, user, slot) {
  assertTurn(g, user);
  if (g.clues >= MAX_CLUES) {
    throw new GameError("All 8 clue tokens are available, so you can't discard. Give a clue or play a card.");
  }
  const card = takeCard(g, user, slot);
  g.discards.push(publicCard(card));
  g.clues++;
  draw(g, user);
  return endTurn(g, { type: 'discard', player: user, slot, card: publicCard(card) });
}

const matches = (card, kind, value) => (kind === 'color' ? card.color === value : card.rank === value);

/** Clues that would touch at least one card in the target's hand. */
function legalClues(g, target) {
  const hand = g.hands[target] || [];
  return {
    colors: g.colors.filter((c) => hand.some((card) => card.color === c)),
    ranks: RANKS.filter((r) => hand.some((card) => card.rank === r)),
  };
}

function touchedSlots(g, target, kind, value) {
  return (g.hands[target] || []).flatMap((card, i) => (matches(card, kind, value) ? [i] : []));
}

function clue(g, user, target, kind, rawValue) {
  assertTurn(g, user);
  if (target === user) throw new GameError("You can't give yourself a clue.");
  if (!g.players.includes(target)) throw new GameError("That person isn't in this game.");
  if (g.clues <= 0) throw new GameError('No clue tokens left. Play or discard a card instead.');
  const value = kind === 'rank' ? Number(rawValue) : rawValue;
  const valid = kind === 'color' ? g.colors.includes(value) : kind === 'rank' && RANKS.includes(value);
  if (!valid) throw new GameError('That is not a valid clue.');
  const slots = touchedSlots(g, target, kind, value);
  if (!slots.length) throw new GameError('A clue has to point at least one card.');

  for (const i of slots) {
    const card = g.hands[target][i];
    if (kind === 'color') card.knownColor = value;
    else card.knownRank = value;
  }
  g.clues--;
  return endTurn(g, { type: 'clue', player: user, target, kind, value, slots });
}

function abandon(g, user) {
  if (g.status !== 'active') throw new GameError('This game is already over.');
  if (!g.players.includes(user)) throw new GameError('Only players can end the game.');
  g.status = 'abandoned';
  g.updatedAt = Date.now();
  const event = { type: 'abandon', player: user, turn: g.turn };
  g.log.push(event);
  return event;
}

/**
 * Judge a play using ONLY the holder's clue marks and the public fireworks.
 * Never looks at the real card, so whether a warning appears can't leak it.
 *   sure   - the marks prove it plays
 *   unsure - the marks don't prove it either way
 *   bad    - the marks prove it misfires
 */
function assessPlay(g, card) {
  const { knownColor: c, knownRank: r } = card;
  const ready = (color) => g.fireworks[color] === r - 1;
  if (c && r) {
    if (ready(c)) return { level: 'sure' };
    return { level: 'bad', reason: g.fireworks[c] >= r ? 'already-played' : 'too-early', color: c, rank: r, at: g.fireworks[c] };
  }
  if (r) {
    if (g.colors.every(ready)) return { level: 'sure' };
    if (!g.colors.some(ready)) return { level: 'bad', reason: 'no-stack-ready', rank: r };
    return { level: 'unsure' };
  }
  if (c && g.fireworks[c] === 5) return { level: 'bad', reason: 'complete', color: c };
  return { level: 'unsure' };
}

function rating(points, max) {
  const s = (points * 25) / max; // normalise the rainbow variant to the 25-point scale
  if (s >= 25) return 'Legendary! The crowd will never forget it.';
  if (s >= 21) return 'Amazing. They will be talking about this one for a while.';
  if (s >= 16) return 'Excellent. The crowd is thrilled.';
  if (s >= 11) return 'Honorable, but it won’t make history.';
  if (s >= 6) return 'Mediocre. A smattering of polite applause.';
  return 'Horrible. The crowd is booing.';
}

module.exports = {
  BASE_COLORS, RAINBOW, RANKS, MAX_CLUES, MAX_FUSES, GameError,
  createGame, currentPlayer, score, maxScore, play, discard, clue, abandon,
  legalClues, touchedSlots, assessPlay, rating, handSizeFor, buildDeck, colorsFor,
};
