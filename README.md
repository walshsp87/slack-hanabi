# 🎆 Hanabi for Slack

Play the cooperative card game Hanabi with 2–5 people in any Slack channel or group DM.

The hard part of Hanabi in chat is hidden information: you must see everyone's cards *except your own*. This bot handles that with a private modal per player. The channel only ever shows what's public (fireworks, tokens, discards, and what each player has been told through clues).

## How it plays

1. Someone runs `/hanabi new` (optionally `/hanabi new @alex @sam rainbow`). A lobby appears with **Join / Leave / Start / Cancel**.
2. On **Start**, the bot posts a live **board** message. Seating and first player are random.
3. Anyone taps **🃏 Open my table** to get a private modal showing:
   - your own hand with direct clue marks only (`🔴?`, `❔3`),
   - your teammates, next player on top, with hands **hidden by default** so a glance at your screen gives nothing away. Tap **👁 Show** on one hand or **Show all**; your choice sticks while the table is open and resets the next time you open it,
   - on your turn: **Play** / **Discard** buttons per slot, and clue buttons per teammate (only for revealed hands, and only clues that touch at least one card). Clues and discards ask for confirmation. Plays ask only when your clue marks don't prove the card fits (see below).
4. Each move updates the board in place and posts a line in the board's thread that @mentions the next player. The final score is broadcast to the channel.

**Clue marks, not deductions.** A clue marks the cards it touches, like tilting them at a real table, and the mark stays with the card. The bot never records or shows negative information: if a "Blue" clue skips your slot 2, nothing tells you slot 2 isn't blue. Remembering and reasoning about that is part of the puzzle. The full clue history is in the board's thread for anyone who wants to scroll back.

**Play warnings.** If your clue marks prove a card plays (say it's marked 🔴3 and red is at 2, or it's a marked 1 and every firework is empty), it plays with one tap. Otherwise you get an "are you sure?" that says why: unproven ("marked ❔3, your clues don't prove it fits"), or a certain misfire ("marked 🔴3, but red is already at 3"). It warns again if this would be the third fuse. The check only ever looks at your clue marks and the public table, never the real card, so whether a warning appears can't tip you off.

**Out of clues.** At 0 clue tokens the clue buttons disappear and the table says you must play or discard; the engine rejects clues too.

Slot `1` is the leftmost card; newly drawn cards go into slot 1 and push the rest right.

### Commands

| Command | What it does |
|---|---|
| `/hanabi new [@players…] [rainbow]` | Open a lobby (mentioned people are pre-joined) |
| `/hanabi table` | Open your private table (same as the board button) |
| `/hanabi games` | List your active games with links to their boards |
| `/hanabi board` | Repost the board at the bottom of the conversation |
| `/hanabi rules` | Rules summary |
| `/hanabi end` | Abandon the current game (players only) |

### Rules implemented

Standard Hanabi: 50 cards (per color: three 1s, two 2s/3s/4s, one 5), hand size 5 for 2–3 players and 4 for 4–5, 8 clue tokens, 3 fuses. Clues name one color or one number and must touch at least one card. You can't discard with all 8 clue tokens available. Playing a 5 returns a clue token. The game ends on the 3rd fuse (score 0), a perfect display, or after the final round (everyone, including whoever drew the last card, gets one more turn). The **Rainbow** option adds a sixth color clued as its own color (max 30).

## Setup (about 5 minutes)

You need Node 18+ and permission to install apps in your workspace.

1. **Create the app.** Go to https://api.slack.com/apps → *Create New App* → *From a manifest*, pick your workspace, and paste `manifest.yml`.
2. **Install it** to the workspace (*Install App*). Copy the **Bot User OAuth Token** (`xoxb-…`).
3. **Create an app-level token.** *Basic Information → App-Level Tokens → Generate*, add the `connections:write` scope. Copy it (`xapp-…`).
4. **Run it:**
   ```bash
   cp .env.example .env    # paste both tokens in
   npm install
   npm start               # "🎆 Hanabi bot is running"
   ```
5. In Slack: `/hanabi new`.

It uses **Socket Mode**, so there's no public URL, ngrok, or load balancer. It just needs outbound internet. Run it on anything always-on (a small VM, a Raspberry Pi, a container). Each game is saved to its own file (`data/games/<uuid>.json`) after every move, so restarts don't lose games. Each conversation runs one game at a time (two boards side by side would be too easy to mix up), but different channels and group DMs can each have their own game going, and you can be in several. `/hanabi games` lists yours.

Run the tests with `npm test`.

## Where games happen

- **Public channels:** the board posts right there (the `chat:write.public` scope means no invite needed).
- **Private channels:** `/invite @Hanabi` first and the game stays in the channel.
- **Group DMs, or private channels without the bot:** Slack doesn't let bots post into conversations they aren't part of. The lobby still works there, and on **Start** the bot opens a new group DM containing all the players plus itself and runs the game in it. The lobby message links to it.

## Notes and limits

- **Spectators:** non-players who open the table see all hands with no buttons. That's handy for kibitzers, but it means a player could ask a non-player to peek. Same honor system as at a real table.
- **Stale views:** if someone moves while your modal is open, your next button press is rejected with "the table changed" and the modal refreshes. Nothing gets double-applied.
- **Storage:** one small JSON file per game, cached in memory. Dozens of concurrent games (across conversations) are fine. Running more than one copy of the bot at once would need a shared database instead; `src/store.js` is the only file to change.

## Layout

```
src/game.js    rules engine (pure, no Slack)
src/render.js  Block Kit for board, lobby, private table, rules
src/store.js   JSON persistence
src/app.js     Bolt wiring: slash command, buttons, modals
test/          engine rules, randomized stress test, Block Kit limit checks
manifest.yml   Slack app manifest (scopes, slash command, Socket Mode)
```
