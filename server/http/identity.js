// Guest identity: pid + stateless HMAC token. Identity survives a stats-store wipe
// because the token verifies against the server secret, not stored state.
import crypto from 'node:crypto';
import { NAME_RE } from '../../shared/constants.js';
import { BOT_NAMES } from '../game/bots/names.js';

export const SERVER_SECRET = process.env.SERVER_SECRET || (() => {
  const s = crypto.randomBytes(32).toString('hex');
  console.warn('[identity] SERVER_SECRET not set — generated an ephemeral secret; tokens will not survive restarts');
  return s;
})();

const PROFANITY = [
  'fuck', 'shit', 'bitch', 'cunt', 'asshole', 'nigger', 'nigga', 'faggot', 'fag',
  'retard', 'whore', 'slut', 'dick', 'cock', 'pussy', 'twat', 'wank', 'prick',
  'nazi', 'hitler', 'rape', 'rapist', 'kike', 'spic',
];
const RESERVED = new Set(BOT_NAMES.map((n) => n.toLowerCase()));

export function mintPid() {
  return crypto.randomBytes(8).toString('hex');
}

export function mintToken(pid) {
  const mac = crypto.createHmac('sha256', SERVER_SECRET).update(pid).digest('hex').slice(0, 24);
  return `${pid}.${mac}`;
}

export function verifyToken(pid, token) {
  if (typeof pid !== 'string' || typeof token !== 'string') return false;
  if (!/^[0-9a-f]{16}$/.test(pid)) return false;
  const expected = mintToken(pid);
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Returns { ok: true, name } with the trimmed name, or { ok: false, reason }.
export function validateName(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'name required' };
  const name = raw.trim();
  if (!NAME_RE.test(name)) return { ok: false, reason: '1-16 chars: letters, digits, _ - space' };
  const lower = name.toLowerCase();
  if (RESERVED.has(lower)) return { ok: false, reason: 'that name is reserved' };
  for (const w of PROFANITY) if (lower.includes(w)) return { ok: false, reason: 'name not allowed' };
  return { ok: true, name };
}
