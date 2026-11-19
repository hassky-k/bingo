# WIP & SIP Bingo

Live all-hands bingo. Players enter a first name and build a 5x5 card: place phrases wherever they like, then let the game fill the rest at random (or deal the whole card at random). They tap squares to put an X on them. Every phrase scores points, and a leaderboard ranks everyone live. No accounts and no database.

| Page | Address | Who |
| --- | --- | --- |
| Game | `/` | Players. Join, build their card, play it |
| Leaderboard | `/leaderboard` | Anyone with the link. Everyone ranked by points, top scorer first, re-ordering live |
| Live board | `/board` | Anyone with the link. Read-only view of every card (good for a shared screen) |
| Admin | `/admin` | You. Add, rename and remove phrases and set their points. Needs the admin code |

## Put it on Render

1. **Get the files into a Git repo.** Create a new repository on GitHub (private is fine) and upload everything in this folder, keeping the `public` folder as it is. On GitHub: *Add file > Upload files*, drag the files in, then *Commit changes*.
2. **Create the service.** In Render choose *New > Web Service*, connect your GitHub account and pick the repo.
3. **Settings:**
   - Language: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: `Free`
4. **Environment variables** (under *Environment*):
   - `ADMIN_CODE` (needed to use the admin page). Pick a password only you know. If you leave it out, `/admin` stays switched off.
   - `GAME_CODE` (optional). Players are asked for it when they join, so only people who know it can get a card. Anyone with the link can still watch the boards.
   - `WORDS_FILE` (optional, needs a paid instance). If you attach a Render persistent disk mounted at, say, `/var/data`, set this to `/var/data/words.json` and every change made on `/admin` is saved there and survives restarts and redeploys. Without it, admin changes last until the service restarts.
5. Click *Create Web Service*. When the deploy finishes, Render shows your `onrender.com` address. Open it, play a card, then check `/leaderboard` and `/admin`.

## Points

- Each phrase has a score from 5 to 50 in steps of 5. A player's total is the sum of the phrases they have marked.
- The starting scores are in `words.json` (rarer phrases are worth more). They are placeholders for you to change.
- **Change them live:** open `/admin` and enter the admin code. Add a phrase with its points, click any phrase to rename it (Enter saves), pick a new points value, or remove a phrase. Everything saves straight away and every card, score and the leaderboard update immediately.
- Renaming a phrase also renames it on cards that already have it, and their marks stay. Removing a phrase stops it being dealt on new cards, but cards that already have it keep the square and its points. The list can't drop below 25 phrases.
- **Keep them across restarts:** without `WORDS_FILE`, admin changes live in memory. Press *Copy as words.json*, paste the result over `words.json` in your repo and redeploy. Otherwise a restart goes back to the file.
- The leaderboard ranks by points. Equal points share a rank (1, 1, 3); within a tie, more marks comes first, then names A to Z.

## Good to know

- **Wake it up first.** A free Render service goes to sleep after 15 minutes without traffic and takes about a minute to wake. Open the page a few minutes before the all hands. While anyone has a page open it pings the server every few minutes to keep it awake.
- **Games live in memory.** Restarting or redeploying the service starts a fresh game with no cards, and points go back to `words.json`. Render can also restart free services at any time. If that happens mid-game, players see a message and tap to get a new card.
- **To reset between sessions**, restart the service from the Render dashboard.
- **Changing the phrases.** Edit `words.json` (keep at least 25 different phrases, each with `"text"` and `"points"`) and redeploy. Players place as many as they like and the rest are filled at random. Their own placements get a teal edge.
- **Run it on your own computer** with Node 18 or newer: `ADMIN_CODE=yourcode node server.js`, then open `http://localhost:3000`.
