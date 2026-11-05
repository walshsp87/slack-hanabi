'use strict';
/**
 * File-based store: one JSON file per game (data/games/<uuid>.json) plus a
 * small lobbies file. A move only rewrites its own game's file. Many games can
 * run across different conversations, but only one per conversation.
 * Everything is also kept in memory, so reads never touch disk.
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.HANABI_DATA_DIR || path.join(__dirname, '..', 'data');
const GAMES_DIR = path.join(DIR, 'games');
const LOBBIES_FILE = path.join(DIR, 'lobbies.json');
const KEEP_MS = 14 * 24 * 60 * 60 * 1000; // forget finished games / stale lobbies after 2 weeks

const games = new Map();
let lobbies = {};

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

const gameFile = (id) => path.join(GAMES_DIR, `${id}.json`);

function load() {
  const cutoff = Date.now() - KEEP_MS;
  fs.mkdirSync(GAMES_DIR, { recursive: true });
  for (const name of fs.readdirSync(GAMES_DIR)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(GAMES_DIR, name);
    try {
      const g = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (g.status !== 'active' && (g.updatedAt || 0) < cutoff) fs.unlinkSync(file);
      else games.set(g.id, g);
    } catch (e) {
      console.error(`Skipping unreadable game file ${name}:`, e.message);
    }
  }
  try {
    lobbies = JSON.parse(fs.readFileSync(LOBBIES_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not read lobbies:', e.message);
  }
  for (const [id, l] of Object.entries(lobbies)) if ((l.createdAt || 0) < cutoff) delete lobbies[id];
}

const getGame = (id) => games.get(id) || null;

function putGame(g) {
  games.set(g.id, g);
  writeAtomic(gameFile(g.id), g);
}

const byRecent = (a, b) => b.updatedAt - a.updatedAt;
const activeGames = () => [...games.values()].filter((g) => g.status === 'active');
const activeGamesIn = (channel) => activeGames().filter((g) => g.channel === channel).sort(byRecent);
const activeGameIn = (channel) => activeGamesIn(channel)[0] || null;
const activeGamesFor = (user) => activeGames().filter((g) => g.players.includes(user)).sort(byRecent);

const getLobby = (id) => lobbies[id] || null;
function putLobby(l) {
  lobbies[l.id] = l;
  writeAtomic(LOBBIES_FILE, lobbies);
}

module.exports = { load, getGame, putGame, activeGamesIn, activeGameIn, activeGamesFor, getLobby, putLobby };
