// Postgres-backed StatsStore, used iff DATABASE_URL is set. Write-behind: dirty rows
// flush every 30 s, at match end, and on SIGTERM. Any pg error degrades to memory
// semantics — the game never dies because the DB did.
import { MemoryStore } from './statsStore.js';

export class PgStore extends MemoryStore {
  constructor() {
    super();
    this.persistent = true;
    this.mode = 'postgres';
    this.dirty = new Set();
    this.pool = null;
    this.broken = false;
  }

  static async create(databaseUrl) {
    const store = new PgStore();
    const { default: pg } = await import('pg');
    store.pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 3,
      ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false },
    });
    await store.pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        pid TEXT PRIMARY KEY, name TEXT NOT NULL,
        xp INT DEFAULT 0, kills INT DEFAULT 0, deaths INT DEFAULT 0, headshots INT DEFAULT 0,
        best_streak INT DEFAULT 0, longest_kill REAL DEFAULT 0, matches INT DEFAULT 0,
        shots_fired INT DEFAULT 0, shots_hit INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT now(), last_seen TIMESTAMPTZ DEFAULT now())`);
    // Warm the in-memory mirror with the WHOLE table (boot-season scale is small):
    // getPlayer/upsertPlayer only consult the mirror, and a miss on an existing
    // player would create a zeroed row and flush it over their real stats.
    const { rows } = await store.pool.query(
      'SELECT * FROM players ORDER BY xp DESC');
    for (const r of rows) {
      store.rows.set(r.pid, {
        pid: r.pid, name: r.name, xp: r.xp, kills: r.kills, deaths: r.deaths,
        headshots: r.headshots, bestStreak: r.best_streak, longestKill: r.longest_kill,
        matches: r.matches, shotsFired: r.shots_fired, shotsHit: r.shots_hit,
      });
    }
    store.timer = setInterval(() => { store.flush().catch(() => {}); }, 30000);
    store.timer.unref();
    return store;
  }

  upsertPlayer(pid, name) {
    const row = super.upsertPlayer(pid, name);
    this.dirty.add(pid);
    return row;
  }

  setName(pid, name) { super.setName(pid, name); this.dirty.add(pid); }

  addDeltas(pid, d) { super.addDeltas(pid, d); this.dirty.add(pid); }

  async flush() {
    if (this.broken || !this.pool || this.dirty.size === 0) return;
    const pids = [...this.dirty];
    this.dirty.clear();
    try {
      for (const pid of pids) {
        const r = this.rows.get(pid);
        if (!r) continue;
        await this.pool.query(`
          INSERT INTO players (pid, name, xp, kills, deaths, headshots, best_streak,
                               longest_kill, matches, shots_fired, shots_hit, last_seen)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
          ON CONFLICT (pid) DO UPDATE SET
            name=$2, xp=$3, kills=$4, deaths=$5, headshots=$6, best_streak=$7,
            longest_kill=$8, matches=$9, shots_fired=$10, shots_hit=$11, last_seen=now()`,
          [r.pid, r.name, r.xp, r.kills, r.deaths, r.headshots, r.bestStreak,
            r.longestKill, r.matches, r.shotsFired, r.shotsHit]);
      }
    } catch (err) {
      if (!this.broken) console.error('[pgStore] flush failed, degrading to memory:', err.message);
      this.broken = true;
    }
  }
}

export async function createStore() {
  const url = process.env.DATABASE_URL;
  if (!url) return new MemoryStore();
  try {
    const store = await PgStore.create(url);
    console.log('[pgStore] connected — persistent stats enabled');
    return store;
  } catch (err) {
    console.error('[pgStore] init failed, using memory store:', err.message);
    return new MemoryStore();
  }
}
