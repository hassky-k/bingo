# WIP & SIP Bingo

Live all-hands bingo. Players enter a first name, pick 3 phrases, get a random 5x5 card and tap squares to put an X on them. Everyone's cards show on a live board that updates as people play. No accounts and no database.

- Game page: `https://YOUR-SERVICE.onrender.com/`
- Standalone live board (read only, good for a shared screen): `https://YOUR-SERVICE.onrender.com/board`

## Put it on Render

1. **Get the files into a Git repo.** Create a new repository on GitHub (private is fine) and upload everything in this folder, keeping the `public` folder as it is. On GitHub: *Add file > Upload files*, drag the files in, then *Commit changes*.
2. **Create the service.** In Render choose *New > Web Service*, connect your GitHub account and pick the repo.
3. **Settings:**
   - Language: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: `Free`
4. **Optional game code.** Under *Environment*, add a variable named `GAME_CODE` with a word of your choice. Players are then asked for it with their name, which keeps strangers out if the link leaks. Leave it out for an open game.
5. Click *Create Web Service*. When the deploy finishes, Render shows your `onrender.com` address. Open it, play a card, and check `/board` in a second tab.

## Good to know

- **Wake it up first.** A free Render service goes to sleep after 15 minutes without traffic and takes about a minute to wake. Open the page a few minutes before the all hands. While anyone has the page open it pings the server every few minutes to keep it awake.
- **Games live in memory.** Restarting or redeploying the service starts a fresh game with no cards. Render can also restart free services at any time. If that happens mid-game, players see a message and tap to get a new card.
- **To reset between sessions**, restart the service from the Render dashboard.
- **Changing the phrases.** Edit `words.json` (keep at least 25 different phrases) and redeploy. Each player picks 3 and gets 22 more at random.
- **Run it on your own computer** with Node 18 or newer: `node server.js`, then open `http://localhost:3000`.
