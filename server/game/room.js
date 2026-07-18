// One Room = one running match simulation. Everything authoritative happens here:
// input drain, movement, lag-compensated fire resolution, kills, respawns, match
// lifecycle, bot population, and the per-tick snapshot broadcast.
import { Player } from './player.js';
import { BotController } from './bots/controller.js';
import { BOT_NAMES, BOT_TIERS, DEFAULT_FILL, BOT_RANKS } from './bots/names.js';
import { resolveFire } from './lagcomp.js';
import { pickSpawn } from './spawns.js';
import { qp, qa, spliceSnapFrame } from '../net/protocol.js';
import { defaultState } from '../../shared/movement.js';
import { BOXES, MAP_VERSION } from '../../shared/map.js';
import { mulberry32, dist3 } from '../../shared/math.js';
import {
  TICK_RATE, INTERP_DELAY_MS, MAX_HP, DMG_HEAD, DMG_BODY, DEATH_CAM_MS,
  SPAWN_PROTECT_MS, MATCH_MS, INTERMISSION_MS, MIN_COMBATANTS, MAX_COMBATANTS,
  BOT_REFILL_MIN_MS, BOT_REFILL_MAX_MS, BOT_EVICT_DEADLINE_MS,
  BACKPRESSURE_BYTES, XP_KILL, XP_HEADSHOT, XP_STREAK_PER, XP_STREAK_CAP,
  XP_PLACE, RANKS, rankFor, MAX_SPECTATORS_PER_ROOM,
} from '../../shared/constants.js';

const TEST_MODE = process.env.TEST_MODE === '1';

export class Room {
  constructor(id, store, seed, { botFill = true } = {}) {
    this.id = id;
    this.store = store;
    this.rng = mulberry32(seed >>> 0);
    this.combatants = [];
    this.spectators = [];            // conn objects
    this.nodeOccupancy = new Set();
    this.botStuckEvents = 0;
    this.botFill = botFill;
    this.events = [];
    this.nextEventId = 1;
    this.botSlot = 0;
    this.pendingRefillAt = 0;
    this.emptySince = 0;             // overflow-room destroy timer (manager reads this)
    this.now = 0;
    this.matchState = 'LIVE';
    this.matchEndsAt = 0;            // set on first step
    this.started = false;
    this.usedBotNames = new Set();
  }

  serverNow() { return this.now; }

  humans() { return this.combatants.filter((p) => !p.isBot); }
  bots() { return this.combatants.filter((p) => p.isBot); }

  pushEvent(ev) { ev.id = this.nextEventId++; this.events.push(ev); return ev; }

  // --- Join / leave -------------------------------------------------------

  hasFreeSlotForHuman() {
    if (this.combatants.length < MAX_COMBATANTS) return true;
    return this.bots().length > 0;   // a bot can be despawned immediately to admit
  }

  addHuman(conn, { pid, name, rank, xp }) {
    if (this.combatants.length >= MAX_COMBATANTS) {
      const bot = this.bots()[0];
      if (bot) this.removeCombatant(bot);
    }
    const p = new Player({ id: pid, name, isBot: false, rank, xp });
    p.conn = conn;
    this.combatants.push(p);
    this.pushEvent({ e: 'join', who: p.id, name: p.name, rank: p.rank });
    if (this.matchState === 'LIVE') this.spawnPlayer(p);
    else { p.status = 'DEAD'; p.respawnAt = this.matchEndsAt; }
    this.rebalanceBots();
    return p;
  }

  addSpectator(conn) {
    if (this.spectators.length >= MAX_SPECTATORS_PER_ROOM) return false;
    this.spectators.push(conn);
    return true;
  }

  removeSpectator(conn) {
    const i = this.spectators.indexOf(conn);
    if (i >= 0) this.spectators.splice(i, 1);
  }

  removeCombatant(p) {
    const i = this.combatants.indexOf(p);
    if (i < 0) return;
    this.combatants.splice(i, 1);
    if (p.botCtl) p.botCtl.releaseNode();
    this.pushEvent({ e: 'leave', who: p.id });
    this.rebalanceBots();
  }

  // --- Bots ---------------------------------------------------------------

  addBot(tierName) {
    if (tierName === 'random' || !tierName) {
      const tiers = ['easy', 'medium', 'hard'];
      tierName = tiers[Math.floor(this.rng() * 3) % 3];
    }
    const available = BOT_NAMES.filter((n) => !this.usedBotNames.has(n));
    const name = available.length
      ? available[Math.floor(this.rng() * available.length) % available.length]
      : `Unit-${Math.floor(this.rng() * 900 + 100)}`;
    this.usedBotNames.add(name);
    // Bot ids look exactly like human pids — no tells on the wire.
    let pid = '';
    for (let i = 0; i < 16; i++) pid += '0123456789abcdef'[Math.floor(this.rng() * 16) % 16];
    const rank = BOT_RANKS[tierName] ?? 2;
    const xp = RANKS[rank].xp + Math.floor(this.rng() * 800);
    const p = new Player({ id: pid, name, isBot: true, rank, xp });
    p.ping = 30 + Math.floor(this.rng() * 41);
    p.botCtl = new BotController(p, tierName, this, this.botSlot++);
    this.combatants.push(p);
    this.pushEvent({ e: 'join', who: p.id, name: p.name, rank: p.rank });
    if (this.matchState === 'LIVE') this.spawnPlayer(p);
    return p;
  }

  // Mark/unmark bots for eviction so combatants converge on max(MIN, humans).
  rebalanceBots() {
    const humans = this.humans().length;
    const bots = this.bots();
    const target = Math.max(0, MIN_COMBATANTS - humans);
    const excess = bots.length - target;
    let marked = bots.filter((b) => b.evictDeadline > 0);
    if (excess <= 0) {
      for (const b of marked) b.evictDeadline = 0;   // demand dropped — no churn
      return;
    }
    // Mark exactly `excess` bots, preferring already-marked ones.
    let need = excess - marked.length;
    for (const b of bots) {
      if (need <= 0) break;
      if (b.evictDeadline === 0) { b.evictDeadline = this.now + BOT_EVICT_DEADLINE_MS; need--; }
    }
    while (marked.length > excess) {
      marked[marked.length - 1].evictDeadline = 0;
      marked = bots.filter((b) => b.evictDeadline > 0);
    }
  }

  checkPopulation() {
    if (!this.botFill) return;
    // Evictions past deadline despawn immediately via the normal leave path.
    for (const b of this.bots()) {
      if (b.evictDeadline > 0 && this.now >= b.evictDeadline) this.removeCombatant(b);
    }
    // Refill: schedule ONE bot join 3-8 s out so it reads as a human joining.
    if (this.combatants.length < MIN_COMBATANTS) {
      if (this.pendingRefillAt === 0) {
        this.pendingRefillAt = this.now + BOT_REFILL_MIN_MS
          + this.rng() * (BOT_REFILL_MAX_MS - BOT_REFILL_MIN_MS);
      } else if (this.now >= this.pendingRefillAt) {
        this.pendingRefillAt = 0;
        const idx = Math.min(this.bots().length, DEFAULT_FILL.length - 1);
        this.addBot(DEFAULT_FILL[idx]);
      }
    } else {
      this.pendingRefillAt = 0;
    }
  }

  // Intermission difficulty pass: mutate presets IN PLACE on existing bots — no
  // join/leave churn, identity and stats continuity preserved.
  rubberBand() {
    const humans = this.humans().filter((h) => h.kills + h.deaths > 0);
    if (!humans.length) return;
    const bots = this.bots();
    const count = (t) => bots.filter((b) => b.botCtl.tierName === t).length;
    const swap = (from, to) => {
      const b = bots.find((x) => x.botCtl.tierName === from);
      if (!b) return;
      b.botCtl.tierName = to;
      b.botCtl.tier = BOT_TIERS[to];
    };
    const kd = (h) => h.kills / Math.max(1, h.deaths);
    if (humans.some((h) => kd(h) < 0.5) && count('hard') > 0 && count('easy') < bots.length) {
      swap('hard', 'easy');
    } else if (humans.every((h) => kd(h) > 2.0) && count('easy') > 1 && count('hard') < 2) {
      swap('easy', 'hard');
    }
  }

  // --- Spawning / combat --------------------------------------------------

  spawnPlayer(p) {
    const enemies = this.combatants.filter((o) => o !== p && o.alive())
      .map((o) => ({ x: o.state.x, y: o.state.y, z: o.state.z }));
    const occupied = this.combatants.filter((o) => o !== p && o.status !== 'GONE')
      .map((o) => ({ x: o.state.x, y: o.state.y, z: o.state.z }));
    const sp = pickSpawn(enemies, occupied, this.rng);
    p.state = defaultState(sp.x, sp.y, sp.z);
    p.state.grounded = true;
    p.lastYaw = sp.yaw;
    p.lastPitch = 0;
    p.hp = MAX_HP;
    p.status = 'ALIVE';
    p.protectUntil = this.now + SPAWN_PROTECT_MS;
    p.swaySeed = Math.floor(this.rng() * 0x7fffffff);
    p.guessedSteps = 0;
    p.ring.fill(null);
    this.pushEvent({
      e: 'spawn', who: p.id,
      x: qp(sp.x), y: qp(sp.y), z: qp(sp.z), yaw: qa(sp.yaw), swaySeed: p.swaySeed,
    });
  }

  resolveFires(fireList) {
    for (const { p: shooter, fire } of fireList) {
      // Firing ends spawn protection early.
      if (shooter.protectUntil > this.now) shooter.protectUntil = this.now;
      if (!shooter.isBot) this.store.addDeltas(shooter.id, { shotsFired: 1 });

      const victims = this.combatants.filter((v) =>
        v !== shooter && v.alive() && v.protectUntil <= this.now);
      const res = resolveFire(shooter, fire, victims, this.now, BOXES, this.rng);
      const shotEv = this.pushEvent({
        e: 'shot', by: shooter.id,
        o: res.origin.map(qp), end: res.end.map(qp),
        hit: res.hit ? res.hit.id : null, part: res.part,
      });
      for (const b of this.bots()) {
        if (b.alive() && b !== shooter) b.botCtl.onShotEvent(res.origin);
      }
      if (!res.hit) continue;

      const victim = res.hit;
      const dmg = res.part === 'head' ? DMG_HEAD : DMG_BODY;
      victim.hp -= dmg;
      if (!shooter.isBot) this.store.addDeltas(shooter.id, { shotsHit: 1 });

      if (victim.hp > 0) {
        if (victim.isBot) victim.botCtl.onDamaged();
        continue;
      }

      // --- Kill ---
      victim.hp = 0;
      victim.status = 'DEAD';
      victim.deaths++;
      victim.streak = 0;
      victim.respawnAt = this.now + DEATH_CAM_MS;
      if (victim.isBot) victim.botCtl.onDeath();
      else this.store.addDeltas(victim.id, { deaths: 1 });

      shooter.kills++;
      shooter.streak++;
      const head = res.part === 'head';
      if (head) shooter.hs++;
      const dist = Math.round(res.t * 10) / 10;
      if (dist > shooter.longestKill) shooter.longestKill = dist;
      const streakBonus = Math.min(XP_STREAK_CAP, XP_STREAK_PER * (shooter.streak - 1));
      const killXp = XP_KILL + (head ? XP_HEADSHOT : 0) + streakBonus;
      shooter.matchXp += killXp;
      shooter.xp += killXp;
      shooter.xpItems.kills += XP_KILL;
      if (head) shooter.xpItems.headshots += XP_HEADSHOT;
      shooter.xpItems.streaks += streakBonus;
      if (!shooter.isBot) {
        this.store.addDeltas(shooter.id, {
          kills: 1, headshots: head ? 1 : 0, xp: killXp,
          streak: shooter.streak, killDist: dist,
        });
      }
      this.pushEvent({
        e: 'kill', shotId: shotEv.id, by: shooter.id, victim: victim.id,
        part: res.part, dist, streak: shooter.streak, killerHp: shooter.hp,
      });
      if (shooter.isBot) shooter.botCtl.onKill();

      // Marked-for-eviction bots leave at their next death.
      if (victim.isBot && victim.evictDeadline > 0) this.removeCombatant(victim);
    }
  }

  // --- Match lifecycle ----------------------------------------------------

  endMatch() {
    this.matchState = 'INTERMISSION';
    this.matchEndsAt = this.now + INTERMISSION_MS;
    const humans = this.humans();
    const placed = [...humans].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    placed.forEach((p, i) => {
      if (i < XP_PLACE.length && p.kills > 0) {
        p.xpItems.place = XP_PLACE[i];
        p.matchXp += XP_PLACE[i];
        p.xp += XP_PLACE[i];
        this.store.addDeltas(p.id, { xp: XP_PLACE[i] });
      }
      this.store.addDeltas(p.id, { matches: 1 });
    });
    const scoreboard = [...this.combatants]
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
      .map((p) => ({ id: p.id, n: p.name, rank: p.rank, k: p.kills, d: p.deaths, hs: p.hs, ping: p.ping }));
    for (const p of humans) {
      const oldRank = p.rank;
      p.rank = rankFor(p.xp);
      const msg = {
        type: 'matchEnd',
        scoreboard,
        you: {
          k: p.kills,
          place: placed.indexOf(p) + 1,
          xpGain: p.matchXp,
          xpItems: [
            ['kills', p.xpItems.kills], ['headshots', p.xpItems.headshots],
            ['streaks', p.xpItems.streaks], ['place', p.xpItems.place],
          ].filter(([, v]) => v > 0),
          ...(p.rank > oldRank ? { rankUp: { from: RANKS[oldRank].name, to: RANKS[p.rank].name } } : {}),
        },
        nextIn: INTERMISSION_MS,
      };
      if (p.conn) p.conn.send(msg);
    }
    for (const conn of this.spectators) {
      conn.send({ type: 'matchEnd', scoreboard, you: null, nextIn: INTERMISSION_MS });
    }
    // Bots update their visible rank too.
    for (const b of this.bots()) b.rank = rankFor(b.xp);
    this.rubberBand();
    this.store.flush().catch(() => {});
  }

  startRound() {
    this.matchState = 'LIVE';
    this.matchEndsAt = this.now + MATCH_MS;
    for (const p of this.combatants) {
      p.resetForRound();
      this.spawnPlayer(p);
    }
    this.pushEvent({ e: 'match', state: 'LIVE', endsAt: this.matchEndsAt });
  }

  // --- The per-tick pipeline ---------------------------------------------

  step(tick, now) {
    this.now = now;
    if (!this.started) {
      this.started = true;
      this.matchEndsAt = now + MATCH_MS;
    }

    // 1a. Bots push one input each into the same queue humans fill.
    for (const p of this.combatants) {
      if (p.isBot && p.alive()) {
        const input = p.botCtl.update(tick, this.combatants);
        if (input) p.queueInput(input);
      }
    }

    // 1b. Drain queues with input-debt accounting; collect fire requests.
    const fireList = [];
    const afk = [];
    for (const p of this.combatants) {
      const fires = p.processTick();
      for (const f of fires) fireList.push({ p, fire: f });
      // Scoping ends spawn protection early.
      if (p.protectUntil > now && p.state.scoped) p.protectUntil = now;
      if (p.isAfk()) afk.push(p);
    }

    // 2. Respawns.
    if (this.matchState === 'LIVE') {
      for (const p of this.combatants) {
        if (!p.alive() && now >= p.respawnAt) this.spawnPlayer(p);
      }
    }

    // 3. Fire resolution (combat only while LIVE).
    if (this.matchState === 'LIVE') this.resolveFires(fireList);

    // 4. Lag-comp history.
    for (const p of this.combatants) {
      if (p.alive()) p.recordHistory(tick, now);
    }

    // 5. Match clock.
    if (now >= this.matchEndsAt) {
      if (this.matchState === 'LIVE') this.endMatch();
      else this.startRound();
    }

    // 6. Population maintenance.
    this.checkPopulation();

    // 7. AFK removals through the normal disconnect path.
    for (const p of afk) {
      if (p.conn) p.conn.kick('AFK');
      else this.removeCombatant(p);
    }

    // 8. 1 Hz score rows — the sole live scoreboard source.
    if (tick % TICK_RATE === 0) {
      this.pushEvent({
        e: 'score',
        rows: this.combatants.map((p) => [
          p.id, p.kills, p.deaths, p.streak,
          p.isBot ? p.ping + Math.floor(this.rng() * 11) - 5 : p.ping,
        ]),
      });
    }

    // 9. Snapshot broadcast: shared portion serialized once, ack+you spliced per client.
    this.broadcast(tick, now);
    this.events = [];
  }

  selfStateJson(p) {
    const s = p.state;
    return JSON.stringify({
      x: qp(s.x), y: qp(s.y), z: qp(s.z),
      vx: qp(s.vx), vy: qp(s.vy), vz: qp(s.vz),
      hp: p.hp, ammo: s.ammo,
      breath: Math.round(s.breath * 100) / 100,
      exhaleMs: Math.round(s.exhaleMs), scopedMs: Math.round(s.scopedMs),
      boltMs: Math.round(s.boltMs), reloadMs: Math.round(s.reloadMs),
      landMs: Math.round(s.landMs), grounded: s.grounded ? 1 : 0,
      state: p.status,
      protectMs: Math.max(0, Math.round(p.protectUntil - this.now)),
    });
  }

  broadcast(tick, now) {
    const players = this.combatants.map((p) => ({
      id: p.id,
      x: qp(p.state.x), y: qp(p.state.y), z: qp(p.state.z),
      yaw: qa(p.lastYaw), pitch: qa(p.lastPitch),
      hp: p.hp, sc: p.state.scoped ? 1 : 0, st: p.status,
    }));
    const shared = JSON.stringify({ t: now, tick, players, events: this.events });
    for (const p of this.combatants) {
      if (!p.conn) continue;
      if (p.conn.ws.bufferedAmount > BACKPRESSURE_BYTES) { p.conn.kick('BACKPRESSURE'); continue; }
      p.conn.sendRaw(spliceSnapFrame(p.lastAckSeq, this.selfStateJson(p), shared));
    }
    for (const conn of this.spectators) {
      if (conn.ws.bufferedAmount > BACKPRESSURE_BYTES) { conn.kick('BACKPRESSURE'); continue; }
      conn.sendRaw(spliceSnapFrame(0, 'null', shared));
    }
  }

  buildWelcome(p, now, tick) {
    return {
      type: 'welcome',
      pid: p ? p.id : null,
      tick, t: now,
      tickRate: TICK_RATE, interpDelay: INTERP_DELAY_MS, mapVersion: MAP_VERSION,
      room: this.id,
      match: this.matchState === 'LIVE'
        ? { state: 'LIVE', endsAt: this.matchEndsAt }
        : { state: 'INTERMISSION', nextIn: Math.max(0, Math.round(this.matchEndsAt - now)) },
      you: p ? { rank: p.rank, xp: p.xp } : null,
      roster: this.combatants.map((o) => ({
        id: o.id, name: o.name, rank: o.rank,
        k: o.kills, d: o.deaths, streak: o.streak, ping: o.ping,
      })),
    };
  }
}
