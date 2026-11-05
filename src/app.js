'use strict';
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const { App, LogLevel } = require('@slack/bolt');
const E = require('./game');
const R = require('./render');
const store = require('./store');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: process.env.LOG_LEVEL || LogLevel.INFO,
});

store.load();

const rid = () => crypto.randomBytes(5).toString('hex');
const parseMentions = (text) => [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]);
const ephemeral = (respond, text) => respond({ response_type: 'ephemeral', replace_original: false, text });

/** The game a command refers to: this conversation's game, else your most recent one. */
const findGame = (channel, user) => store.activeGameIn(channel) || store.activeGamesFor(user)[0] || null;

const ONE_PER_CONVO = 'There’s already a Hanabi game in this conversation. Use `/hanabi board` to find it or `/hanabi end` to stop it.';

const permalink = (client, g) =>
  client.chat
    .getPermalink({ channel: g.channel, message_ts: g.boardTs })
    .then((r) => r.permalink)
    .catch(() => null);

/** Ui state for the private table lives in the modal itself, per view. */
function uiFrom(view) {
  try {
    const meta = JSON.parse(view?.private_metadata || '{}');
    return { shown: Array.isArray(meta.shown) ? meta.shown : [] };
  } catch {
    return { shown: [] };
  }
}

// Errors from Slack that mean "the bot can't post in this conversation".
const CANT_POST = new Set(['not_in_channel', 'channel_not_found', 'is_archived', 'restricted_action']);

async function postBoard(client, game) {
  const res = await client.chat.postMessage({
    channel: game.channel,
    text: R.boardFallback(game),
    blocks: R.boardBlocks(game),
  });
  game.boardTs = res.ts;
  return res;
}

async function refreshBoard(client, game) {
  if (!game.boardTs) return;
  try {
    await client.chat.update({
      channel: game.channel,
      ts: game.boardTs,
      text: R.boardFallback(game),
      blocks: R.boardBlocks(game),
    });
  } catch (err) {
    console.error('Board update failed:', err.data?.error || err);
  }
}

async function startGame(client, lobby) {
  // One game per conversation: two boards side by side are too easy to mix up.
  if (store.activeGameIn(lobby.channel)) throw new E.GameError(ONE_PER_CONVO);
  const game = E.createGame({ channel: lobby.channel, players: lobby.players, variant: lobby.variant });
  try {
    await postBoard(client, game);
  } catch (err) {
    if (!CANT_POST.has(err.data?.error)) throw err;
    // Bot isn't in this conversation (e.g. a group DM or a private channel):
    // open a group DM with all the players plus the bot and play there.
    const opened = await client.conversations.open({ users: game.players.join(',') });
    game.channel = opened.channel.id;
    if (store.activeGameIn(game.channel)) {
      throw new E.GameError('These players already have a game going in their group DM with me. Finish or `/hanabi end` that one first.');
    }
    lobby.movedTo = game.channel;
    await postBoard(client, game);
  }
  store.putGame(game);
  const order = game.players.map((p) => `<@${p}>`).join(' → ');
  await client.chat.postMessage({
    channel: game.channel,
    thread_ts: game.boardTs,
    text: `Game on! Turn order: ${order}\n👉 <@${E.currentPlayer(game)}>, you're first. Tap *Open my table* on the board to see everyone's cards and take your turn. Moves get logged in this thread.`,
  });
  return game;
}

async function announce(client, game, event) {
  let text = R.describeEvent(game, event);
  if (game.status === 'active') {
    text += `\n👉 <@${E.currentPlayer(game)}>, you're up.`;
    const note = R.finalRoundNote(game);
    if (note) text += ` ${note}`;
  } else {
    text += `\n\n${R.gameOverText(game)}`;
  }
  await refreshBoard(client, game);
  await client.chat.postMessage({
    channel: game.channel,
    thread_ts: game.boardTs,
    text,
    reply_broadcast: game.status !== 'active', // shout the final score into the channel
  });
}

// ---------------- slash command ----------------

app.command('/hanabi', async ({ command, ack, respond, client }) => {
  await ack();
  const text = (command.text || '').trim();
  const sub = (text.split(/\s+/)[0] || 'help').toLowerCase();
  const user = command.user_id;
  const channel = command.channel_id;

  try {
    switch (sub) {
      case 'new':
      case 'start':
      case 'play': {
        if (store.activeGameIn(channel)) return ephemeral(respond, ONE_PER_CONVO);
        const invited = parseMentions(text).filter((u) => u !== user);
        const lobby = {
          id: rid(),
          channel,
          host: user,
          players: [user, ...new Set(invited)].slice(0, 5),
          variant: /\brainbow\b/i.test(text) ? 'rainbow' : 'standard',
          status: 'open',
          createdAt: Date.now(),
        };
        store.putLobby(lobby);
        // response_url posting works even where the bot isn't a member (group DMs).
        return respond({ response_type: 'in_channel', text: 'Hanabi lobby', blocks: R.lobbyBlocks(lobby) });
      }

      case 'table':
      case 'hand':
      case 'view': {
        const game = findGame(channel, user);
        if (!game) return ephemeral(respond, 'No active Hanabi game found. Start one with `/hanabi new`.');
        return client.views.open({ trigger_id: command.trigger_id, view: R.modalView(game, user) });
      }

      case 'board': {
        const game = findGame(channel, user);
        if (!game) return ephemeral(respond, 'No active Hanabi game found.');
        const oldTs = game.boardTs;
        await postBoard(client, game);
        store.putGame(game);
        if (oldTs) {
          client.chat
            .update({ channel: game.channel, ts: oldTs, text: 'Board moved', blocks: [R.context('_This board moved further down ⬇️_')] })
            .catch(() => {});
        }
        if (game.channel !== channel) return ephemeral(respond, `Reposted the board in <#${game.channel}>.`);
        return;
      }

      case 'end':
      case 'quit':
      case 'abandon': {
        const game = findGame(channel, user);
        if (!game) return ephemeral(respond, 'No active Hanabi game found.');
        if (!game.players.includes(user)) return ephemeral(respond, 'Only players can end a game.');
        const event = E.abandon(game, user);
        store.putGame(game);
        await announce(client, game, event);
        return;
      }

      case 'games':
      case 'list': {
        const mine = store.activeGamesFor(user);
        if (!mine.length) return ephemeral(respond, 'You’re not in any active games. Start one with `/hanabi new`.');
        const lines = await Promise.all(
          mine.map(async (g) => {
            const link = await permalink(client, g);
            const turn = E.currentPlayer(g) === user ? '👉 *your turn*' : `waiting on <@${E.currentPlayer(g)}>`;
            const who = g.players.filter((p) => p !== user).map((p) => `<@${p}>`).join(', ');
            return `• ${link ? `<${link}|Game>` : 'Game'} in <#${g.channel}> with ${who}: ${turn} (score ${E.score(g)})`;
          }),
        );
        return ephemeral(respond, `*Your Hanabi games*\n${lines.join('\n')}`);
      }

      case 'rules':
        return client.views.open({ trigger_id: command.trigger_id, view: R.rulesView() });

      default:
        return ephemeral(respond, R.HELP);
    }
  } catch (err) {
    if (err instanceof E.GameError) return ephemeral(respond, `⚠️ ${err.message}`);
    console.error(err);
    return ephemeral(respond, `⚠️ Something went wrong: ${err.data?.error || err.message}`);
  }
});

// ---------------- lobby buttons ----------------

app.action(/^hanabi_lobby_(join|leave|start|cancel)$/, async ({ ack, body, action, respond, client }) => {
  await ack();
  const lobby = store.getLobby(action.value);
  const user = body.user.id;
  if (!lobby || lobby.status !== 'open') return ephemeral(respond, 'That lobby is closed.');
  const kind = action.action_id.split('_').pop();

  try {
    if (kind === 'join') {
      if (lobby.players.includes(user)) return ephemeral(respond, 'You’re already in.');
      if (lobby.players.length >= 5) return ephemeral(respond, 'The table is full (5 players max).');
      lobby.players.push(user);
    } else if (kind === 'leave') {
      lobby.players = lobby.players.filter((p) => p !== user);
      if (!lobby.players.length) lobby.status = 'cancelled';
      else if (lobby.host === user) lobby.host = lobby.players[0];
    } else if (kind === 'cancel') {
      if (user !== lobby.host) return ephemeral(respond, 'Only the host can cancel the lobby.');
      lobby.status = 'cancelled';
    } else if (kind === 'start') {
      if (!lobby.players.includes(user)) return ephemeral(respond, 'Join the game before starting it.');
      if (lobby.players.length < 2) return ephemeral(respond, 'You need at least 2 players.');
      await startGame(client, lobby);
      lobby.status = 'started';
    }
  } catch (err) {
    if (err instanceof E.GameError) return ephemeral(respond, `⚠️ ${err.message}`);
    console.error(err);
    return ephemeral(respond, `⚠️ Couldn't start: ${err.data?.error || err.message}`);
  }

  store.putLobby(lobby);
  await respond({ replace_original: true, text: 'Hanabi lobby', blocks: R.lobbyBlocks(lobby) });
});

// ---------------- board buttons ----------------

app.action('hanabi_open', async ({ ack, body, action, client }) => {
  await ack();
  const game = store.getGame(action.value);
  if (!game) return;
  await client.views.open({ trigger_id: body.trigger_id, view: R.modalView(game, body.user.id) });
});

app.action('hanabi_rules', async ({ ack, body, client }) => {
  await ack();
  await client.views.open({ trigger_id: body.trigger_id, view: R.rulesView() });
});

// ---------------- modal buttons ----------------

app.action('hanabi_refresh', async ({ ack, body, action, client }) => {
  await ack();
  const game = store.getGame(action.value);
  if (!game) return;
  await client.views.update({ view_id: body.view.id, view: R.modalView(game, body.user.id, null, uiFrom(body.view)) });
});

// Show / hide teammates' hands (per view; hidden by default each time you open the table).
app.action(/^hanabi_toggle_/, async ({ ack, body, action, client }) => {
  await ack();
  const meta = JSON.parse(action.value);
  const game = store.getGame(meta.g);
  if (!game) return;
  const ui = uiFrom(body.view);
  const shown = new Set(ui.shown);
  if (meta.all === 'show') game.players.forEach((p) => shown.add(p));
  else if (meta.all === 'hide') shown.clear();
  else if (shown.has(meta.p)) shown.delete(meta.p);
  else shown.add(meta.p);
  await client.views.update({ view_id: body.view.id, view: R.modalView(game, body.user.id, null, { shown: [...shown] }) });
});

const MOVES = {
  play: (g, u, m) => E.play(g, u, m.s),
  discard: (g, u, m) => E.discard(g, u, m.s),
  clue: (g, u, m) => E.clue(g, u, m.to, m.k, m.v),
};

app.action(/^hanabi_(play|discard|clue)_/, async ({ ack, body, action, client }) => {
  await ack();
  const kind = action.action_id.split('_')[1];
  const meta = JSON.parse(action.value);
  const user = body.user.id;
  const game = store.getGame(meta.g);
  if (!game) return;

  let notice;
  let event;
  try {
    // Reject buttons from a view drawn before the latest move.
    if (meta.t !== game.turn) throw new E.GameError('The table changed since this view was drawn. Here’s the latest.');
    event = MOVES[kind](game, user, meta);
    store.putGame(game);
    notice = `✅ ${R.describeEvent(game, event)}`;
  } catch (err) {
    if (!(err instanceof E.GameError)) throw err;
    notice = `⚠️ ${err.message}`;
  }

  await client.views.update({ view_id: body.view.id, view: R.modalView(game, user, notice, uiFrom(body.view)) });
  if (event) await announce(client, game, event);
});

(async () => {
  await app.start();
  console.log('🎆 Hanabi bot is running (Socket Mode)');
})();
