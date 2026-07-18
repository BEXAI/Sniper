// REST + traversal-hardened static serving. All /api routes sit behind a per-IP
// token bucket; POST bodies are capped at 4 KB.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintPid, mintToken, verifyToken, validateName } from './identity.js';
import { SEASON, rankNameFor } from '../store/statsStore.js';
import { RANKS, rankFor } from '../../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

const BODY_CAP = 4096;

// Global /api token bucket: 20 requests / 10 s per IP (plus 5/min for /api/guest).
const buckets = new Map();
function allow(ip, key, capacity, refillPerMs) {
  const now = Date.now();
  const k = `${ip}:${key}`;
  let b = buckets.get(k);
  if (!b) { b = { tokens: capacity, last: now }; buckets.set(k, b); }
  b.tokens = Math.min(capacity, b.tokens + (now - b.last) * refillPerMs);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - 120000;
  for (const [k, b] of buckets) if (b.last < cutoff) buckets.delete(k);
}, 60000).unref?.();

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, res) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_CAP) {
        json(res, 413, { error: 'body too large' });
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', () => resolve(null));
  });
}

// Traversal defense: decode -> normalize -> resolve -> prefix check; any dotted
// path segment 404s outright.
function safeResolve(rootDir, rel) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return null; }
  if (decoded.split(/[\\/]/).some((seg) => seg.startsWith('.') && seg.length > 0)) return null;
  const resolved = path.resolve(rootDir, '.' + path.normalize('/' + decoded));
  if (!resolved.startsWith(rootDir + path.sep) && resolved !== rootDir) return null;
  return resolved;
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'method' }); return; }
  let rootDir, rel;
  if (url.pathname === '/' || url.pathname === '/index.html') {
    rootDir = PUBLIC_DIR; rel = 'index.html';
  } else if (url.pathname.startsWith('/shared/')) {
    rootDir = SHARED_DIR; rel = url.pathname.slice('/shared/'.length);
  } else {
    rootDir = PUBLIC_DIR; rel = url.pathname.slice(1);
  }
  const file = safeResolve(rootDir, rel);
  if (!file) { json(res, 404, { error: 'not found' }); return; }
  const ext = path.extname(file).toLowerCase();
  const mime = MIME[ext];
  if (!mime) { json(res, 404, { error: 'not found' }); return; }
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) { json(res, 404, { error: 'not found' }); return; }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

export function createApi({ store, manager, statusProvider }) {
  let lbCache = { key: '', at: 0, body: null };

  return async function handle(req, res) {
    const ip = (req.socket.remoteAddress || '?').replace(/^::ffff:/, '');
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { json(res, 400, { error: 'bad url' }); return; }

    if (!url.pathname.startsWith('/api/')) { await serveStatic(req, res, url); return; }

    // Global REST bucket: 20 / 10 s.
    if (!allow(ip, 'api', 20, 20 / 10000)) { json(res, 429, { error: 'rate limited' }); return; }

    if (url.pathname === '/api/status' && req.method === 'GET') {
      json(res, 200, statusProvider());
      return;
    }

    if (url.pathname === '/api/guest' && req.method === 'POST') {
      if (!allow(ip, 'guest', 5, 5 / 60000)) { json(res, 429, { error: 'rate limited' }); return; }
      if (!/^application\/json/.test(req.headers['content-type'] || '')) {
        json(res, 415, { error: 'application/json required' }); return;
      }
      const body = await readBody(req, res);
      if (body === null) return;
      let data;
      try { data = JSON.parse(body); } catch { json(res, 400, { error: 'bad json' }); return; }
      const v = validateName(data.name);
      if (!v.ok) { json(res, 400, { error: v.reason }); return; }

      if (data.pid && data.token && verifyToken(data.pid, data.token)) {
        // Rename: update the store row and any live entity (last-write-wins).
        store.upsertPlayer(data.pid, v.name);
        for (const room of manager.rooms) {
          for (const p of room.combatants) {
            if (p.id === data.pid) {
              p.name = v.name;
              room.pushEvent({ e: 'join', who: p.id, name: p.name, rank: p.rank });
            }
          }
        }
        json(res, 200, { pid: data.pid, token: mintToken(data.pid), name: v.name });
        return;
      }
      const pid = mintPid();
      store.upsertPlayer(pid, v.name);
      json(res, 200, { pid, token: mintToken(pid), name: v.name });
      return;
    }

    if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
      const by = url.searchParams.get('by') === 'kills' ? 'kills' : 'xp';
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
      const key = `${by}:${limit}`;
      // Rebuilt at most every 5 s — a store scan never rides the hot path.
      if (lbCache.key !== key || Date.now() - lbCache.at > 5000) {
        lbCache = {
          key,
          at: Date.now(),
          body: JSON.stringify({
            persistent: store.persistent,
            season: SEASON,
            rows: store.leaderboard(by, limit),
          }),
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(lbCache.body);
      return;
    }

    const statsMatch = url.pathname.match(/^\/api\/stats\/([0-9a-f]{16})$/);
    if (statsMatch && req.method === 'GET') {
      const row = store.getPlayer(statsMatch[1]);
      if (!row) { json(res, 404, { error: 'unknown pid' }); return; }
      const rank = rankFor(row.xp);
      const next = RANKS[rank + 1] || null;
      json(res, 200, {
        ...row,
        rankName: rankNameFor(row.xp),
        nextRank: next ? { name: next.name, xp: next.xp, remaining: next.xp - row.xp } : null,
        persistent: store.persistent,
        season: SEASON,
      });
      return;
    }

    json(res, 404, { error: 'not found' });
  };
}
