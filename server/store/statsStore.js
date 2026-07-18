// StatsStore interface + in-memory implementation. NOTHING is ever written to disk —
// Render's filesystem is ephemeral. The reset is sold as a "Boot Season" instead.
import { rankFor, RANKS } from '../../shared/constants.js';

export function rankNameFor(xp) { return RANKS[rankFor(xp)].name; }

export const SEASON = `boot-${new Date().toISOString().slice(0, 16)}Z`;

export function emptyRow(pid, name) {
  return {
    pid, name,
    xp: 0, kills: 0, deaths: 0, headshots: 0,
    bestStreak: 0, longestKill: 0, matches: 0,
    shotsFired: 0, shotsHit: 0,
  };
}

export class MemoryStore {
  constructor() {
    this.rows = new Map();
    this.persistent = false;
    this.mode = 'memory';
  }

  getPlayer(pid) { return this.rows.get(pid) || null; }

  upsertPlayer(pid, name) {
    let row = this.rows.get(pid);
    if (!row) { row = emptyRow(pid, name); this.rows.set(pid, row); }
    else if (name) row.name = name;
    return row;
  }

  setName(pid, name) {
    const row = this.rows.get(pid);
    if (row) row.name = name;
  }

  // deltas: partial counts added onto the row; max-style fields handled explicitly.
  addDeltas(pid, d) {
    const row = this.rows.get(pid);
    if (!row) return;
    if (d.xp) row.xp += d.xp;
    if (d.kills) row.kills += d.kills;
    if (d.deaths) row.deaths += d.deaths;
    if (d.headshots) row.headshots += d.headshots;
    if (d.matches) row.matches += d.matches;
    if (d.shotsFired) row.shotsFired += d.shotsFired;
    if (d.shotsHit) row.shotsHit += d.shotsHit;
    if (d.streak && d.streak > row.bestStreak) row.bestStreak = d.streak;
    if (d.killDist && d.killDist > row.longestKill) row.longestKill = Math.round(d.killDist * 10) / 10;
  }

  leaderboard(by = 'xp', limit = 50) {
    const key = by === 'kills' ? 'kills' : 'xp';
    const rows = [...this.rows.values()]
      .filter((r) => r.xp > 0 || r.kills > 0)
      .sort((a, b) => b[key] - a[key])
      .slice(0, limit);
    return rows.map((r, i) => ({
      // id feeds the client's Name#ab collision discriminator (2 hex chars, §4.3).
      rank: i + 1, id: r.pid, name: r.name, rankName: rankNameFor(r.xp), xp: r.xp,
      kills: r.kills, deaths: r.deaths, headshots: r.headshots,
      bestStreak: r.bestStreak, longestKill: r.longestKill, matches: r.matches,
    }));
  }

  async flush() { /* nothing to persist */ }
}
