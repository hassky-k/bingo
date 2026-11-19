'use strict';
/*
 * WIP & SIP Bingo server.
 * No dependencies. Serves the pages, deals cards, records marks, scores points
 * and pushes live updates to every open browser (server-sent events).
 * All game state lives in memory: restarting the service starts a fresh game
 * and resets any points changed on the admin page back to words.json.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
// Optional. If set, players must type this code to get a card (not case sensitive).
const GAME_CODE = (process.env.GAME_CODE || '').trim().toLowerCase();
// Needed to open /admin and change points. If unset, the admin page is switched off.
const ADMIN_CODE = (process.env.ADMIN_CODE || '').trim();

const CARD_SIZE = 25;
const SLOTS = [3, 12, 21]; // squares the player fills with their own 3 picks
const MAX_PLAYERS = 200;
const MAX_BODY = 4096;
const MIN_POINTS = 5, MAX_POINTS = 50, POINTS_STEP = 5;

function validPoints(n) {
  return Number.isInteger(n) && n >= MIN_POINTS && n <= MAX_POINTS && n % POINTS_STEP === 0;
}

// words.json holds objects like { "text": "AI", "points": 10 }.
// Plain strings are accepted too and get 10 points.
const points = new Map(); // phrase -> points (admin edits change this live)
JSON.parse(fs.readFileSync(path.join(__dirname, 'words.json'), 'utf8')).forEach(function (w) {
  const text = String(typeof w === 'string' ? w : (w && w.text) || '').trim();
  if (!text || points.has(text)) return;
  const pts = typeof w === 'string' || w.points === undefined ? 10 : w.points;
  if (!validPoints(pts)) {
    console.error('words.json: "' + text + '" has points ' + JSON.stringify(pts) +
      '. Use a multiple of ' + POINTS_STEP + ' from ' + MIN_POINTS + ' to ' + MAX_POINTS + '.');
    process.exit(1);
  }
  points.set(text, pts);
});
const WORDS = Array.from(points.keys());
if (WORDS.length < CARD_SIZE) {
  console.error('words.json needs at least ' + CARD_SIZE + ' different phrases (found ' + WORDS.length + ').');
  process.exit(1);
}

const players = new Map();   // id -> { id, token, name, cells, picks, marks:Set, createdAt }
const byToken = new Map();   // token -> id
const clients = new Set();   // open event-stream responses

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function cleanName(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

function scoreOf(p) {
  let s = 0;
  p.marks.forEach(function (i) { s += points.get(p.cells[i]) || 0; });
  return s;
}
function pointsObject() {
  const o = {};
  WORDS.forEach(function (w) { o[w] = points.get(w); });
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

async function join(req, res) {
  const b = await readJson(req);
  if (GAME_CODE && String(b.code == null ? '' : b.code).trim().toLowerCase() !== GAME_CODE) {
    return json(res, 403, { error: 'That game code is not right.' });
  }
  const name = cleanName(b.name);
  if (!name) return json(res, 400, { error: 'Enter your first name to get a card.' });
  const picks = Array.isArray(b.picks) ? b.picks.map(String) : [];
  if (picks.length !== SLOTS.length || new Set(picks).size !== picks.length ||
      !picks.every(function (w) { return points.has(w); })) {
    return json(res, 400, { error: 'Choose 3 different phrases from the list.' });
  }
  if (players.size >= MAX_PLAYERS) return json(res, 409, { error: 'This game is full.' });

  const rest = shuffle(WORDS.filter(function (w) { return picks.indexOf(w) < 0; }))
    .slice(0, CARD_SIZE - SLOTS.length);
  const cells = [];
  let r = 0;
  for (let i = 0; i < CARD_SIZE; i++) {
    const s = SLOTS.indexOf(i);
    cells.push(s >= 0 ? picks[s] : rest[r++]);
  }
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
  if (id) { players.delete(id); byToken.delete(String(b.token)); broadcast(); }
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
async function setPoints(req, res) {
  if (!requireAdmin(req, res)) return;
  const b = await readJson(req);
  const word = String(b.word == null ? '' : b.word);
  if (!points.has(word)) return json(res, 400, { error: 'Unknown phrase.' });
  if (!validPoints(b.points)) {
    return json(res, 400, { error: 'Points must be a multiple of ' + POINTS_STEP + ' from ' + MIN_POINTS + ' to ' + MAX_POINTS + '.' });
  }
  points.set(word, b.points);
  broadcast();
  json(res, 200, { points: pointsObject() });
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
        words: WORDS.map(function (w) { return { text: w, points: points.get(w) }; }),
        pointsMin: MIN_POINTS, pointsMax: MAX_POINTS, pointsStep: POINTS_STEP
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
    if (req.method === 'POST' && p === '/api/admin/points') return await setPoints(req, res);
    send(res, 404, 'Not found');
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: 'Bad request.' });
  }
});

server.listen(PORT, function () {
  console.log('WIP & SIP Bingo running on port ' + PORT +
    (GAME_CODE ? ' (game code required)' : '') +
    (ADMIN_CODE ? ' (admin page on)' : ' (admin page off: set ADMIN_CODE)'));
});
