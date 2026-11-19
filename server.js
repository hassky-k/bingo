'use strict';
/*
 * WIP & SIP Bingo server.
 * No dependencies. Serves the pages, deals cards, records marks, scores points
 * and pushes live updates to every open browser (server-sent events).
 * All game state lives in memory: restarting the service starts a fresh game.
 * Phrase changes made on /admin also live in memory, unless WORDS_FILE points
 * at a file on a persistent disk, in which case they are saved there.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
// Optional. If set, players must type this code to get a card (not case sensitive).
const GAME_CODE = (process.env.GAME_CODE || '').trim().toLowerCase();
// Needed to open /admin and add, edit or remove phrases. If unset, the admin page is switched off.
const ADMIN_CODE = (process.env.ADMIN_CODE || '').trim();
// Optional. A file path (for example on a Render persistent disk) where admin changes are saved.
const WORDS_FILE = (process.env.WORDS_FILE || '').trim();

const CARD_SIZE = 25;
const MAX_PLAYERS = 200;
const MAX_BODY = 8192;
const MAX_WORD = 40;
const MIN_POINTS = 5, MAX_POINTS = 50, POINTS_STEP = 5;

function validPoints(n) {
  return Number.isInteger(n) && n >= MIN_POINTS && n <= MAX_POINTS && n % POINTS_STEP === 0;
}
function cleanText(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/* ---------- phrases ----------
 * pool:   the phrases new cards are made from, in admin order.
 * points: phrase -> points. Also holds phrases removed from the pool that are
 *         still on someone's card, so those squares keep scoring.            */
const pool = [];
const points = new Map();

function loadWords() {
  let file = path.join(__dirname, 'words.json');
  if (WORDS_FILE && fs.existsSync(WORDS_FILE)) file = WORDS_FILE;
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  list.forEach(function (w) {
    const text = cleanText(typeof w === 'string' ? w : w && w.text, MAX_WORD);
    if (!text || findKey(text)) return;
    const pts = typeof w === 'string' || w.points === undefined ? 10 : w.points;
    if (!validPoints(pts)) {
      console.error(path.basename(file) + ': "' + text + '" has points ' + JSON.stringify(pts) +
        '. Use a multiple of ' + POINTS_STEP + ' from ' + MIN_POINTS + ' to ' + MAX_POINTS + '.');
      process.exit(1);
    }
    pool.push(text);
    points.set(text, pts);
  });
  if (pool.length < CARD_SIZE) {
    console.error(path.basename(file) + ' needs at least ' + CARD_SIZE + ' different phrases (found ' + pool.length + ').');
    process.exit(1);
  }
  console.log('Loaded ' + pool.length + ' phrases from ' + file);
}
// Case-insensitive lookup so "AI" and "ai" can't both exist.
function findKey(text) {
  const t = text.toLowerCase();
  for (const k of points.keys()) if (k.toLowerCase() === t) return k;
  return null;
}
function poolList() {
  return pool.map(function (w) { return { text: w, points: points.get(w) }; });
}
function saveWords() {
  if (!WORDS_FILE) return;
  const text = '[\n' + poolList().map(function (w) { return '  ' + JSON.stringify(w); }).join(',\n') + '\n]\n';
  const tmp = WORDS_FILE + '.tmp';
  fs.writeFile(tmp, text, function (err) {
    if (err) return console.error('Could not save ' + WORDS_FILE + ': ' + err.message);
    fs.rename(tmp, WORDS_FILE, function (e) { if (e) console.error('Could not save ' + WORDS_FILE + ': ' + e.message); });
  });
}

const players = new Map();   // id -> { id, token, name, cells, picks, marks:Set, createdAt }
const byToken = new Map();   // token -> id
const clients = new Set();   // open event-stream responses

function cardsUsing(text) {
  let n = 0;
  players.forEach(function (p) { if (p.cells.indexOf(text) >= 0) n++; });
  return n;
}
// Forget points for removed phrases once no card uses them any more.
function prune() {
  Array.from(points.keys()).forEach(function (k) {
    if (pool.indexOf(k) < 0 && cardsUsing(k) === 0) points.delete(k);
  });
}

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function scoreOf(p) {
  let s = 0;
  p.marks.forEach(function (i) { s += points.get(p.cells[i]) || 0; });
  return s;
}
function pointsObject() {
  const o = {};
  points.forEach(function (v, k) { o[k] = v; });
  return o;
}
function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    cells: p.cells,
    picks: p.picks,
    marks: Array.from(p.marks).sort(function (a, b) { return a - b; }),
    score: scoreOf(p),
    createdAt: p.createdAt
  };
}
function publicState() {
  return {
    words: poolList(),
    points: pointsObject(),
    players: Array.from(players.values())
      .sort(function (a, b) { return a.createdAt - b.createdAt; })
      .map(publicPlayer)
  };
}
function broadcast() {
  const msg = 'data: ' + JSON.stringify(publicState()) + '\n\n';
  clients.forEach(function (res) {
    try { res.write(msg); } catch (e) { clients.delete(res); }
  });
}
setInterval(function () {
  clients.forEach(function (res) {
    try { res.write(': ping\n\n'); } catch (e) { clients.delete(res); }
  });
}, 20000).unref();

function send(res, status, body, type, extra) {
  res.writeHead(status, Object.assign({
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, extra || {}));
  res.end(body);
}
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function readJson(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function stream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff'
  });
  res.write('retry: 3000\n\n');
  res.write('data: ' + JSON.stringify(publicState()) + '\n\n');
  clients.add(res);
  req.on('close', function () { clients.delete(res); });
}

/* ---------- players ---------- */
async function join(req, res) {
  const b = await readJson(req);
  if (GAME_CODE && String(b.code == null ? '' : b.code).trim().toLowerCase() !== GAME_CODE) {
    return json(res, 403, { error: 'That game code is not right.' });
  }
  const name = cleanText(b.name, 24);
  if (!name) return json(res, 400, { error: 'Enter your first name to get a card.' });

  // cells: 25 entries, each a phrase or null. Empty squares are filled at random here.
  const given = Array.isArray(b.cells) ? b.cells.slice(0, CARD_SIZE) : [];
  while (given.length < CARD_SIZE) given.push(null);
  const chosen = given.filter(function (w) { return w != null && w !== ''; }).map(String);
  if (new Set(chosen).size !== chosen.length) {
    return json(res, 400, { error: 'Each phrase can only go on your card once.' });
  }
  if (!chosen.every(function (w) { return pool.indexOf(w) >= 0; })) {
    return json(res, 400, { error: 'The host just changed the phrase list. Check your card and tap Done again.' });
  }
  if (players.size >= MAX_PLAYERS) return json(res, 409, { error: 'This game is full.' });

  const rest = shuffle(pool.filter(function (w) { return chosen.indexOf(w) < 0; }));
  let r = 0;
  const cells = given.map(function (w) { return w != null && w !== '' ? String(w) : rest[r++]; });
  // picks: the phrases the player placed by hand (shown with a teal edge).
  const picks = (Array.isArray(b.picks) ? b.picks.map(String) : [])
    .filter(function (w, i, a) { return chosen.indexOf(w) >= 0 && a.indexOf(w) === i; });

  const p = {
    id: crypto.randomBytes(6).toString('hex'),
    token: crypto.randomBytes(16).toString('hex'),
    name: name, cells: cells, picks: picks,
    marks: new Set(), createdAt: Date.now()
  };
  players.set(p.id, p);
  byToken.set(p.token, p.id);
  broadcast();
  json(res, 200, { id: p.id, token: p.token, player: publicPlayer(p) });
}

async function mark(req, res) {
  const b = await readJson(req);
  const p = players.get(byToken.get(String(b.token)));
  if (!p) return json(res, 404, { error: 'Card not found.' });
  const i = b.index;
  if (!Number.isInteger(i) || i < 0 || i >= CARD_SIZE) return json(res, 400, { error: 'Bad square.' });
  if (b.on === true) p.marks.add(i); else p.marks.delete(i);
  broadcast();
  const pub = publicPlayer(p);
  json(res, 200, { marks: pub.marks, score: pub.score });
}

async function leave(req, res) {
  const b = await readJson(req);
  const id = byToken.get(String(b.token));
  if (id) { players.delete(id); byToken.delete(String(b.token)); prune(); broadcast(); }
  json(res, 200, { ok: true });
}

/* ---------- admin ---------- */
const failures = new Map(); // ip -> { n, until }
function clientIp(req) {
  const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return f || req.socket.remoteAddress || 'unknown';
}
function sameCode(given) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_CODE).digest();
  return crypto.timingSafeEqual(a, b);
}
// Returns true when the request may continue; otherwise it has already replied.
function requireAdmin(req, res) {
  if (!ADMIN_CODE) {
    json(res, 503, { error: 'The admin page is switched off. Set ADMIN_CODE on the server to turn it on.' });
    return false;
  }
  const ip = clientIp(req);
  const f = failures.get(ip);
  if (f && f.n >= 10 && Date.now() < f.until) {
    json(res, 429, { error: 'Too many wrong codes. Wait a minute and try again.' });
    return false;
  }
  if (!sameCode(req.headers['x-admin-code'] || '')) {
    const cur = f && Date.now() < f.until ? f : { n: 0, until: Date.now() + 60000 };
    cur.n++;
    failures.set(ip, cur);
    json(res, 401, { error: 'That admin code is not right.' });
    return false;
  }
  failures.delete(ip);
  return true;
}

// Renames a phrase everywhere: the pool, the points and every card it is on.
// Marks are stored by square number, so they stay put.
function renameEverywhere(from, to) {
  if (from === to) return;
  const i = pool.indexOf(from);
  if (i >= 0) pool[i] = to;
  points.set(to, points.get(from));
  points.delete(from);
  players.forEach(function (p) {
    p.cells = p.cells.map(function (w) { return w === from ? to : w; });
    p.picks = p.picks.map(function (w) { return w === from ? to : w; });
  });
}

async function adminWords(req, res) {
  if (!requireAdmin(req, res)) return;
  const b = await readJson(req);
  const action = String(b.action || '');
  const pointsError = 'Points must be a multiple of ' + POINTS_STEP + ' from ' + MIN_POINTS + ' to ' + MAX_POINTS + '.';
  const done = function () {
    saveWords();
    broadcast();
    json(res, 200, { words: poolList() });
  };

  if (action === 'add') {
    const text = cleanText(b.text, MAX_WORD);
    if (!text) return json(res, 400, { error: 'Type the phrase to add.' });
    if (!validPoints(b.points)) return json(res, 400, { error: pointsError });
    const existing = findKey(text);
    if (existing && pool.indexOf(existing) >= 0) {
      return json(res, 400, { error: '"' + existing + '" is already in the list.' });
    }
    if (existing) {
      // It was removed earlier but is still on some cards: bring it back.
      pool.push(existing);
      renameEverywhere(existing, text);
    } else {
      pool.push(text);
    }
    points.set(text, b.points);
    return done();
  }

  const word = String(b.word == null ? '' : b.word);
  if (pool.indexOf(word) < 0) {
    return json(res, 404, { error: 'That phrase is no longer in the list. It may have just been changed.' });
  }

  if (action === 'edit') {
    let text = word;
    if (b.text !== undefined) {
      text = cleanText(b.text, MAX_WORD);
      if (!text) return json(res, 400, { error: 'A phrase cannot be blank.' });
      const clash = findKey(text);
      if (clash && clash !== word) {
        return json(res, 400, { error: pool.indexOf(clash) >= 0
          ? '"' + clash + '" is already in the list.'
          : '"' + clash + '" was removed but is still on some cards. Add it back instead.' });
      }
    }
    if (b.points !== undefined && !validPoints(b.points)) return json(res, 400, { error: pointsError });
    renameEverywhere(word, text);
    if (b.points !== undefined) points.set(text, b.points);
    return done();
  }

  if (action === 'delete') {
    if (pool.length <= CARD_SIZE) {
      return json(res, 400, { error: 'Keep at least ' + CARD_SIZE + ' phrases so every card can be filled. Add one before removing this.' });
    }
    pool.splice(pool.indexOf(word), 1);
    prune(); // cards that already have it keep the square and its points
    return done();
  }

  json(res, 400, { error: 'Unknown action.' });
}

const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/board': ['index.html', 'text/html; charset=utf-8'],
  '/leaderboard': ['index.html', 'text/html; charset=utf-8'],
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
};

const server = http.createServer(async function (req, res) {
  const p = new URL(req.url, 'http://localhost').pathname;
  try {
    if (req.method === 'GET' && FILES[p]) {
      return fs.readFile(path.join(__dirname, 'public', FILES[p][0]), function (err, data) {
        if (err) return send(res, 500, 'Page missing');
        send(res, 200, data, FILES[p][1]);
      });
    }
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, 'ok');
    if (req.method === 'GET' && p === '/api/config') {
      return json(res, 200, {
        codeRequired: !!GAME_CODE,
        words: poolList(),
        cardSize: CARD_SIZE, maxWord: MAX_WORD,
        pointsMin: MIN_POINTS, pointsMax: MAX_POINTS, pointsStep: POINTS_STEP,
        saved: !!WORDS_FILE
      });
    }
    if (req.method === 'GET' && p === '/api/stream') return stream(req, res);
    if (req.method === 'GET' && p === '/api/admin/check') {
      if (requireAdmin(req, res)) json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && p === '/api/join') return await join(req, res);
    if (req.method === 'POST' && p === '/api/mark') return await mark(req, res);
    if (req.method === 'POST' && p === '/api/leave') return await leave(req, res);
    if (req.method === 'POST' && p === '/api/admin/words') return await adminWords(req, res);
    send(res, 404, 'Not found');
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: 'Bad request.' });
  }
});

loadWords();
server.listen(PORT, function () {
  console.log('WIP & SIP Bingo running on port ' + PORT +
    (GAME_CODE ? ' (game code required)' : '') +
    (ADMIN_CODE ? ' (admin page on)' : ' (admin page off: set ADMIN_CODE)') +
    (WORDS_FILE ? ' (saving phrases to ' + WORDS_FILE + ')' : ''));
});
