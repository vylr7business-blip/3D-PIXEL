// Voxel Rampage server: serves the game and a wallet-signed leaderboard.
// No dependencies: Node's built-in http, fs and crypto (ed25519) do everything.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'leaderboard.json');
const PUBLIC = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });
let board = {};
try { board = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { board = {}; }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(board));
    fs.renameSync(tmp, DB_FILE);
  }, 200);
}

// ---- base58 (Solana addresses) ----
const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  if (typeof s !== 'string' || !s.length || s.length > 64) return null;
  let n = 0n;
  for (const c of s) { const i = ALPHA.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
function verifySig(walletB58, message, sigB64) {
  const pub = b58decode(walletB58);
  if (!pub || pub.length !== 32) return false;
  let sig;
  try { sig = Buffer.from(sigB64, 'base64'); } catch (e) { return false; }
  if (sig.length !== 64) return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, pub]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch (e) { return false; }
}

// ---- game sessions (time-based plausibility check) ----
const sessions = new Map();
setInterval(() => { const cut = Date.now() - 3 * 3600e3; for (const [k, v] of sessions) if (v.start < cut) sessions.delete(k); }, 600e3);

// ---- simple per-IP rate limit ----
const hits = new Map();
function limited(ip, max) {
  const now = Date.now(), w = hits.get(ip) || [];
  const recent = w.filter(t => now - t < 60e3); recent.push(now); hits.set(ip, recent);
  return recent.length > max;
}

function scoreMessage(d) {
  return `Voxel Rampage score\nscore:${d.score}\nwave:${d.wave}\nkills:${d.kills}\nsession:${d.sid}`;
}
function top(n) {
  return Object.entries(board)
    .map(([wallet, r]) => ({ wallet, score: r.score, wave: r.wave, kills: r.kills, at: r.at }))
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, n);
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((ok, bad) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 4096) { bad(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { bad(e); } });
  });
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
      return send(res, 200, { entries: top(50), players: Object.keys(board).length });
    }
    if (url.pathname === '/api/start' && req.method === 'POST') {
      if (limited(ip, 30)) return send(res, 429, { error: 'Too many games started. Wait a minute.' });
      const sid = crypto.randomBytes(12).toString('hex');
      sessions.set(sid, { start: Date.now(), used: false });
      return send(res, 200, { sid });
    }
    if (url.pathname === '/api/score' && req.method === 'POST') {
      if (limited(ip, 20)) return send(res, 429, { error: 'Too many submissions. Wait a minute.' });
      const d = await readBody(req);
      const score = d.score | 0, wave = d.wave | 0, kills = d.kills | 0;
      if (score !== d.score || wave !== d.wave || kills !== d.kills || score < 0 || wave < 0 || kills < 0)
        return send(res, 400, { error: 'Bad score data.' });
      const s = sessions.get(d.sid);
      if (!s) return send(res, 400, { error: 'This game session expired. Play another round to submit.' });
      if (s.used) return send(res, 400, { error: 'This round was already submitted.' });
      const secs = (Date.now() - s.start) / 1000;
      // plausibility: points/kills/waves can't outpace real play time
      if (score > secs * 120 + 600 || kills > secs * 1.5 + 5 || wave > secs / 6 + 2 || score > kills * 300)
        return send(res, 400, { error: 'That score does not match the time played.' });
      if (!verifySig(d.wallet, scoreMessage({ score, wave, kills, sid: d.sid }), d.sig))
        return send(res, 401, { error: 'Wallet signature did not check out.' });
      s.used = true;
      const prev = board[d.wallet];
      let improved = false;
      if (!prev || score > prev.score) { board[d.wallet] = { score, wave, kills, at: Date.now() }; improved = true; save(); }
      const list = top(1e9), rank = list.findIndex(e => e.wallet === d.wallet) + 1;
      return send(res, 200, { ok: true, improved, best: board[d.wallet].score, rank });
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

    // static files
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  } catch (e) {
    send(res, 400, { error: 'Bad request.' });
  }
}).listen(PORT, () => console.log('Voxel Rampage on :' + PORT));
