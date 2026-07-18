// Bot brain. Its ONLY output is a standard Input object pushed into the same queue
// humans fill from the network — bots can never do anything a human client couldn't.
// Thinks at 5 Hz (staggered by slot); emits exactly one input per tick.
import { WAYPOINTS, BOXES } from '../../../shared/map.js';
import { BTN, EYE_HEIGHT, TICK_DT, STEP_UP } from '../../../shared/constants.js';
import { rayVsBoxes, dist3, normalizeAngle } from '../../../shared/math.js';
import { BOT_TIERS } from './names.js';

const DEG = Math.PI / 180;
const TEST_MODE = process.env.TEST_MODE === '1';

// --- Waypoint next-hop table (Floyd–Warshall, built once at module load) ---
const N = WAYPOINTS.length;
const nextHopTable = new Int16Array(N * N).fill(-1);
{
  const dist = new Float64Array(N * N).fill(Infinity);
  for (let i = 0; i < N; i++) {
    dist[i * N + i] = 0;
    nextHopTable[i * N + i] = i;
    for (const j of WAYPOINTS[i].adj) {
      const a = WAYPOINTS[i], b = WAYPOINTS[j];
      dist[i * N + j] = dist3(a.x, a.y, a.z, b.x, b.y, b.z);
      nextHopTable[i * N + j] = j;
    }
  }
  for (let k = 0; k < N; k++) {
    for (let i = 0; i < N; i++) {
      const dik = dist[i * N + k];
      if (dik === Infinity) continue;
      for (let j = 0; j < N; j++) {
        const alt = dik + dist[k * N + j];
        if (alt < dist[i * N + j]) {
          dist[i * N + j] = alt;
          nextHopTable[i * N + j] = nextHopTable[i * N + k];
        }
      }
    }
  }
}
export function nextHop(i, j) { return nextHopTable[i * N + j]; }

export function nearestNode(x, y, z) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < N; i++) {
    const w = WAYPOINTS[i];
    // Weight elevation hard so we never match across a cliff/trench lip: a bot on
    // the trench floor must anchor to a floor node it can walk to, not the rim
    // node 2 m above its head.
    const dy = (w.y - y) * 12;
    const d = (w.x - x) ** 2 + dy * dy + (w.z - z) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

const ELEVATED = WAYPOINTS.map((w, i) => (w.elevated ? i : -1)).filter((i) => i >= 0);

export class BotController {
  constructor(player, tierName, room, slot) {
    this.p = player;
    this.tierName = tierName;
    this.tier = BOT_TIERS[tierName];
    this.room = room;
    this.slot = slot;
    this.rng = room.rng;
    this.seq = 0;
    this.mode = 'PATROL';
    this.goal = this.pickPatrolGoal();
    this.claimedNode = -1;
    this.targetId = null;
    this.lastSeen = null;                     // {x,y,z,at}
    this.targetVisibleAt = 0;                 // room.now of the last think the CURRENT target was visible
    this.investigatePoint = null;
    this.investigateSince = 0;
    this.desiredYaw = 0;
    this.desiredPitch = 0;
    this.yaw = player.lastYaw || 0;
    this.pitch = 0;
    this.moveBits = 0;
    this.wantScope = false;
    this.wantBreath = false;
    this.pendingFire = false;
    this.reactionAt = Infinity;
    this.errDeg = this.tier.sigma0Deg;
    this.errDir = this.rng() * Math.PI * 2;
    this.firstShot = true;
    this.lastShotPos = null;
    this.shotsFromPos = 0;
    this.staticSince = 0;
    this.posHistory = [];
    this.stuckEvents = 0;
    this.escapeTarget = null;                 // stuck recovery steers here directly
    this.escapeUntil = 0;
    this.stepNode = -1;                       // committed next hop (see thinkMove)
    this.stepGoal = -1;
    this.legBestD = Infinity;                 // leg-progress watchdog
    this.legStaleThinks = 0;
    this.patrolPhase = this.rng() * Math.PI * 2;
  }

  gauss() {
    const u = Math.max(1e-9, this.rng()), v = this.rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  pickPatrolGoal() {
    if (ELEVATED.length && this.rng() < 0.6) {
      return ELEVATED[Math.floor(this.rng() * ELEVATED.length) % ELEVATED.length];
    }
    return Math.floor(this.rng() * N) % N;
  }

  releaseNode() {
    if (this.claimedNode >= 0) { this.room.nodeOccupancy.delete(this.claimedNode); this.claimedNode = -1; }
  }

  // A waist-high ray to the target is clear of geometry for its first metres.
  // Two guards keep "clear" honest about what the BODY can actually walk:
  // (a) a net climb beyond STEP_UP is never straight-walkable — the rising waist
  //     ray sneaks over a trench lip the feet can't climb (bots then press into
  //     the 2 m wall below a road node forever); ramps/stairs are graph edges,
  //     so committed hops still climb them riser by riser;
  // (b) the capsule is 0.8 m wide — a zero-width center ray grazes past corners
  //     (nest wing walls) the body wedges on, so both shoulder lines must be
  //     clear too.
  clearWalk(sx, sy, sz, tx, ty, tz) {
    const dx = tx - sx, dy = ty - sy, dz = tz - sz;
    if (dy > STEP_UP) return false;
    const full = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const len = Math.min(24, full);
    if (len < 1e-3) return true;
    const inv = 1 / full;
    const dir = [dx * inv, dy * inv, dz * inv];
    const h = Math.hypot(dx, dz) || 1;
    const px = (-dz / h) * 0.35, pz = (dx / h) * 0.35;
    return rayVsBoxes([sx, sy + 0.9, sz], dir, BOXES, len) >= len
      && rayVsBoxes([sx + px, sy + 0.9, sz + pz], dir, BOXES, len) >= len
      && rayVsBoxes([sx - px, sy + 0.9, sz - pz], dir, BOXES, len) >= len;
  }

  // Nearest node we can walk STRAIGHT at — the plain nearest node is routinely
  // on the far side of a staircase or above a trench lip after falls/detours.
  anchorNode(sx, sy, sz, fallback) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < N; i++) {
      const w = WAYPOINTS[i];
      const dy = (w.y - sy) * 12;
      const d = (w.x - sx) ** 2 + dy * dy + (w.z - sz) ** 2;
      if (d < bestD && this.clearWalk(sx, sy, sz, w.x, w.y, w.z)) { bestD = d; best = i; }
    }
    return best >= 0 ? best : fallback;
  }

  // Wedged against geometry: walk somewhere PROVABLY open for a beat, then
  // re-route. Prefer an adjacent graph node with a clear waist-high line;
  // pockets whose graph exits are all walled off fall back to any open compass
  // heading (this is what actually frees a bot cornered between two faces).
  startEscape(now) {
    const s = this.p.state;
    const cur = nearestNode(s.x, s.y, s.z);
    const adj = [...WAYPOINTS[cur].adj, cur];
    for (let i = adj.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1)) % (i + 1);
      [adj[i], adj[j]] = [adj[j], adj[i]];
    }
    for (const n of adj) {
      const w = WAYPOINTS[n];
      if (this.clearWalk(s.x, s.y, s.z, w.x, w.y, w.z)) {
        this.goal = n === cur ? this.goal : n;
        this.escapeTarget = { x: w.x, y: w.y, z: w.z };
        this.escapeUntil = now + 3000;
        return;
      }
    }
    const base = this.rng() * Math.PI * 2;
    for (let k = 0; k < 8; k++) {
      const a = base + k * Math.PI / 4;
      const tx = s.x + Math.cos(a) * 8, tz = s.z + Math.sin(a) * 8;
      if (this.clearWalk(s.x, s.y, s.z, tx, s.y, tz)) {
        this.escapeTarget = { x: tx, y: s.y, z: tz };
        this.escapeUntil = now + 2000;
        return;
      }
    }
  }

  onDamaged() {
    if (this.mode !== 'RELOCATE' && this.rng() < 0.7) this.startRelocate();
  }

  onKill() { this.startRelocate(); }

  onDeath() {
    this.releaseNode();
    this.mode = 'PATROL';
    this.goal = this.pickPatrolGoal();
    this.targetId = null;
    this.targetVisibleAt = 0;
    this.firstShot = true;
    this.shotsFromPos = 0;
    this.lastShotPos = null;
    this.posHistory = [];
  }

  onShotEvent(origin) {
    if (this.mode === 'ENGAGE' || this.mode === 'RELOCATE') return;
    const s = this.p.state;
    if (dist3(s.x, s.y, s.z, origin[0], origin[1], origin[2]) <= 80) {
      this.investigatePoint = { x: origin[0], y: origin[1], z: origin[2] };
      this.investigateSince = this.room.now;
      this.mode = 'INVESTIGATE';
      this.goal = nearestNode(origin[0], origin[1], origin[2]);
    }
  }

  startRelocate() {
    this.releaseNode();
    const s = this.p.state;
    const far = ELEVATED.filter((i) => {
      const w = WAYPOINTS[i];
      return dist3(s.x, s.y, s.z, w.x, w.y, w.z) >= 40 && !this.room.nodeOccupancy.has(i);
    });
    this.goal = far.length
      ? far[Math.floor(this.rng() * far.length) % far.length]
      : this.pickPatrolGoal();
    this.mode = 'RELOCATE';
    this.wantScope = false;
    this.shotsFromPos = 0;
    this.lastShotPos = null;
  }

  // Visible enemies: within 110 degree FOV and clear LOS.
  perceive(combatants) {
    const s = this.p.state;
    const eye = [s.x, s.y + EYE_HEIGHT, s.z];
    const facing = [-Math.sin(this.yaw), -Math.cos(this.yaw)];
    let best = null, bestD = Infinity;
    for (const other of combatants) {
      if (other === this.p || !other.alive()) continue;
      const o = other.state;
      const dx = o.x - s.x, dz = o.z - s.z;
      const d = dist3(s.x, s.y, s.z, o.x, o.y, o.z);
      if (d < 1e-3) continue;
      const dot = (dx * facing[0] + dz * facing[1]) / (Math.hypot(dx, dz) || 1);
      if (dot < Math.cos(55 * DEG)) continue;
      const dy = o.y + EYE_HEIGHT - eye[1];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const dir = [dx / len, dy / len, dz / len];
      if (rayVsBoxes(eye, dir, BOXES, len) < len) continue;
      if (d < bestD) { bestD = d; best = other; }
    }
    return best;
  }

  think(combatants) {
    const s = this.p.state;
    const now = this.room.now;

    // Stuck recovery: < 0.5 m of movement across 3 s of PATHING thinks -> repath.
    // ENGAGE stands still on purpose once HOLDING — drop its history then so
    // leaving an engagement doesn't instantly read as stuck; the approach leg to
    // the claimed node stays covered, and a wedge there falls back to standing.
    const engageHolding = this.mode === 'ENGAGE' && (this.claimedNode < 0
      || dist3(s.x, s.y, s.z, WAYPOINTS[this.claimedNode].x, WAYPOINTS[this.claimedNode].y,
        WAYPOINTS[this.claimedNode].z) <= 2.5);
    if (engageHolding) {
      this.posHistory = [];
    } else {
      this.posHistory.push({ x: s.x, z: s.z });
      if (this.posHistory.length > 15) this.posHistory.shift();
      if (this.posHistory.length === 15) {
        const a = this.posHistory[0];
        // "Moved < 0.5 m over 3 s" means EVERY sample stayed by the anchor —
        // comparing only newest-vs-oldest false-positives on an ENGAGE<->
        // INVESTIGATE ping-pong that re-walks the same stair at full speed and
        // happens to land back where it was 3 s ago.
        if (this.posHistory.every((q) => Math.hypot(q.x - a.x, q.z - a.z) < 0.5)) {
          this.stuckEvents++;
          this.room.botStuckEvents++;
          if (this.mode === 'ENGAGE') this.releaseNode();   // stand-and-aim fallback
          else this.startEscape(now);
          this.posHistory = [];
        }
      }
    }

    const target = this.perceive(combatants);
    if (target) {
      this.lastSeen = { x: target.state.x, y: target.state.y, z: target.state.z, at: now, id: target.id };
      // Re-peek re-arm: a target that broke LOS for a beat re-appears against a
      // STALE settled aim — restore at least half the entry error and half the
      // reaction delay so the re-acquire reads human (no instant floor-error shot).
      if (this.mode === 'ENGAGE' && target.id === this.targetId
          && this.targetVisibleAt > 0 && now - this.targetVisibleAt > 600) {
        this.errDeg = Math.max(this.errDeg, 0.5 * this.tier.sigma0Deg);
        this.reactionAt = Math.max(this.reactionAt, now + 0.5 * this.tier.reactionMs);
      }
      // HARD RULE (§5.2): a RELOCATE in progress is never cancelled by a visible
      // target — the bot travels, then re-engages from the new position.
      if (this.mode !== 'ENGAGE' && this.mode !== 'RELOCATE') this.enterEngage(target);
      this.targetId = target.id;
      this.targetVisibleAt = now;
    } else if (this.mode === 'ENGAGE') {
      if (!this.lastSeen || now - this.lastSeen.at > 4000) {
        this.releaseNode();
        this.mode = 'INVESTIGATE';
        this.investigatePoint = this.lastSeen ? { x: this.lastSeen.x, y: this.lastSeen.y, z: this.lastSeen.z } : null;
        this.investigateSince = now;
        this.goal = this.investigatePoint
          ? nearestNode(this.investigatePoint.x, this.investigatePoint.y, this.investigatePoint.z)
          : this.pickPatrolGoal();
        this.targetId = null;
        this.wantScope = false;
        this.firstShot = true;
      }
    }

    if (this.mode === 'ENGAGE' && target) this.thinkEngage(target);
    else this.thinkMove(now);
  }

  enterEngage(target) {
    const s = this.p.state;
    this.mode = 'ENGAGE';
    this.firstShot = true;
    const jitter = TEST_MODE ? 0 : this.tier.reactionJitterMs;
    this.reactionAt = this.room.now + this.tier.reactionMs + (this.rng() * 2 - 1) * jitter;
    this.errDeg = Math.abs(this.gauss()) * this.tier.sigma0Deg + this.tier.errFloorDeg;
    this.errDir = this.rng() * Math.PI * 2;
    // Hold at the nearest unoccupied node within 25 m (cover-adjacent stop) —
    // only one we can walk STRAIGHT at, since the approach leg steers blind.
    let best = -1, bestD = Infinity;
    for (let i = 0; i < N; i++) {
      if (this.room.nodeOccupancy.has(i)) continue;
      const w = WAYPOINTS[i];
      const d = dist3(s.x, s.y, s.z, w.x, w.y, w.z);
      if (d < 25 && d < bestD && this.clearWalk(s.x, s.y, s.z, w.x, w.y, w.z)) { bestD = d; best = i; }
    }
    if (best >= 0) {
      this.goal = best;
      this.claimedNode = best;
      this.room.nodeOccupancy.add(best);
    }
    this.staticSince = this.room.now;
  }

  thinkEngage(target) {
    const s = this.p.state;
    // Approach leg: actually WALK to the claimed cover node (unscoped, no error
    // decay — settling starts on arrival, so the tier settle-time tell survives).
    if (this.claimedNode >= 0) {
      const w = WAYPOINTS[this.claimedNode];
      if (dist3(s.x, s.y, s.z, w.x, w.y, w.z) > 2.5) {
        // Re-validate the line from the CURRENT position each think: the approach
        // steers blind and the turn-rate-capped curve can drift off a ramp lane,
        // putting an unclimbable face between bot and node (the trench wall beside
        // an exit ramp). Release and fight from here instead of pressing into the
        // wall until the stuck detector fires.
        if (!this.clearWalk(s.x, s.y, s.z, w.x, w.y, w.z)) {
          this.releaseNode();
        } else {
          const dx = w.x - s.x, dz = w.z - s.z;
          this.desiredYaw = Math.atan2(-dx, -dz);
          this.desiredPitch = 0;
          this.moveBits = BTN.FWD;
          this.jumpWanted = (w.y - s.y) > 0.5 && (w.y - s.y) < 1.5 && Math.hypot(dx, dz) < 2.5;
          this.wantScope = false;
          this.wantBreath = false;
          return;
        }
      }
    }
    const t = target.state;
    // Wobble onto target: exponential error decay with a drifting direction.
    this.errDeg = Math.max(this.tier.errFloorDeg, this.errDeg * Math.exp(-0.2 / this.tier.tauSettleS));
    this.errDir += (this.rng() - 0.5) * 0.6;

    const headshot = this.rng() < this.tier.headshotPref;
    const aimY = t.y + (headshot ? 1.62 : 0.9);
    const dx = t.x - s.x, dy = aimY - (s.y + EYE_HEIGHT), dz = t.z - s.z;
    const horiz = Math.hypot(dx, dz) || 1;
    let yaw = Math.atan2(-dx, -dz);
    let pitch = Math.atan2(dy, horiz);
    yaw += this.errDeg * DEG * Math.cos(this.errDir);
    pitch += this.errDeg * DEG * Math.sin(this.errDir);
    this.desiredYaw = yaw;
    this.desiredPitch = pitch;
    this.moveBits = 0;
    this.jumpWanted = false;         // never inherit a patrol step-up hop into a scoped hold
    this.wantScope = true;
    // Readable tell: breath held only when nearly settled (the final beat before firing).
    this.wantBreath = this.errDeg < this.tier.fireThreshDeg * 2;

    const ready = this.room.now >= this.reactionAt
      && this.errDeg <= this.tier.fireThreshDeg + 1e-9
      && this.p.state.boltMs === 0 && this.p.state.reloadMs === 0 && this.p.state.ammo > 0
      && this.p.state.scopedMs > 260;      // past the quickscope cone: bots scope honestly
    if (ready) this.pendingFire = true;
  }

  thinkMove(now) {
    const s = this.p.state;
    const cur = nearestNode(s.x, s.y, s.z);
    const curW = WAYPOINTS[cur];
    const atNode = dist3(s.x, s.y, s.z, curW.x, curW.y, curW.z) < 2.5;
    if (this.mode === 'INVESTIGATE') {
      const arrived = (this.investigatePoint
        && dist3(s.x, s.y, s.z, this.investigatePoint.x, this.investigatePoint.y, this.investigatePoint.z) < 4)
        || (atNode && cur === this.goal);   // reaching the origin's node counts
      if (arrived || now - this.investigateSince > 8000 || !this.investigatePoint) {
        this.mode = 'PATROL';
        this.goal = this.pickPatrolGoal();
        this.investigatePoint = null;
      }
    }
    let target;
    const escaping = now < this.escapeUntil && this.escapeTarget;
    if (escaping) {
      // Stuck recovery in progress: walk straight at the open spot, then re-route.
      target = this.escapeTarget;
      this.stepNode = -1;
    } else {
      if (atNode && cur === this.goal && (this.mode === 'RELOCATE' || this.mode === 'PATROL')) {
        this.mode = 'PATROL';
        this.goal = this.pickPatrolGoal();
      }
      // Commit to ONE hop at a time and walk it out: re-route only on arrival at
      // the step node, when the goal changed, or when the leg stops making
      // progress (e.g. the step node ended up overhead after a fall) —
      // re-anchoring to the nearest node every think yo-yos the bot around it
      // and it never crosses a long edge.
      const step = this.stepNode >= 0 ? WAYPOINTS[this.stepNode] : null;
      if (!step || this.stepGoal !== this.goal || this.legStaleThinks >= 10
          || dist3(s.x, s.y, s.z, step.x, step.y, step.z) < 2.5) {
        const hop = nextHop(cur, this.goal);
        let next = hop >= 0 ? hop : cur;
        // Off the node when routing: only skip straight to the next hop if the
        // line is provably open — otherwise walk to a REACHABLE anchor node
        // first (cutting the corner is how bots wedge into the trench wall
        // beside a ramp, and the plain nearest node can itself sit behind a
        // staircase).
        if (!atNode) {
          const hw = WAYPOINTS[next];
          if (next === cur || !this.clearWalk(s.x, s.y, s.z, hw.x, hw.y, hw.z)) {
            next = this.anchorNode(s.x, s.y, s.z, cur);
          }
        }
        this.stepNode = next;
        this.stepGoal = this.goal;
        this.legBestD = Infinity;
        this.legStaleThinks = 0;
      }
      target = WAYPOINTS[this.stepNode];
      const legD = dist3(s.x, s.y, s.z, target.x, target.y, target.z);
      if (legD < this.legBestD - 0.25) { this.legBestD = legD; this.legStaleThinks = 0; }
      else this.legStaleThinks++;
    }
    const dx = target.x - s.x, dz = target.z - s.z;
    this.desiredYaw = Math.atan2(-dx, -dz);
    // Patrol scan: sweep the eyes +-60 degrees while walking — but never on a
    // climb leg (stairs/ramps are narrow; weaving walks the bot off the side)
    // or while beelining out of a wedge.
    if (this.mode === 'PATROL' && Math.abs(target.y - s.y) < 0.5 && !escaping) {
      this.desiredYaw += Math.sin(now / 1000 * 0.5 * Math.PI * 2 + this.patrolPhase) * 60 * DEG;
    }
    this.desiredPitch = 0;
    this.moveBits = BTN.FWD;
    this.jumpWanted = ((target.y - s.y) > 0.5 && (target.y - s.y) < 1.5 && Math.hypot(dx, dz) < 2.5)
      // Escaping a wedge while pinned against geometry: hop to clear the lip.
      || (now < this.escapeUntil && s.grounded && Math.abs(s.vx) + Math.abs(s.vz) < 0.5);
    this.wantScope = false;
    this.wantBreath = false;
  }

  // Called EVERY tick; think() runs at 5 Hz staggered by slot.
  update(tick, combatants) {
    if (!this.p.alive()) return null;
    if (tick % 6 === this.slot % 6) this.think(combatants);

    // 12 s static (non-engage) -> relocate.
    if (this.mode !== 'ENGAGE' && this.mode !== 'RELOCATE') {
      const s = this.p.state;
      if (Math.abs(s.vx) + Math.abs(s.vz) > 0.5) this.staticSince = this.room.now;
      else if (this.room.now - this.staticSince > 12000) this.startRelocate();
    }

    // Turn-rate-capped tracking: bots visibly track, never snap.
    const maxTurn = this.tier.turnRateDegS * DEG * TICK_DT;
    let dYaw = normalizeAngle(this.desiredYaw - this.yaw);
    const headingErr = Math.abs(dYaw);
    dYaw = Math.max(-maxTurn, Math.min(maxTurn, dYaw));
    this.yaw = normalizeAngle(this.yaw + dYaw);
    let dPitch = this.desiredPitch - this.pitch;
    dPitch = Math.max(-maxTurn, Math.min(maxTurn, dPitch));
    this.pitch += dPitch;

    let b = this.moveBits;
    // Face before walking: forward motion is applied along the CURRENT yaw, so
    // walking through a large turn-rate-capped correction sweeps a blind arc —
    // which is exactly how bots wander off a road edge into the trench corner
    // and wedge. Stand and turn first; 60 degrees still makes forward progress.
    if (headingErr > 1.05) b &= ~BTN.FWD;
    if (this.jumpWanted) b |= BTN.JUMP;
    if (this.wantScope) b |= BTN.SCOPE;
    if (this.wantBreath) b |= BTN.BREATH;

    const input = { seq: ++this.seq, b, yaw: this.yaw, pitch: this.pitch };
    if (this.pendingFire && this.mode === 'ENGAGE') {
      this.pendingFire = false;
      const s = this.p.state;
      let fy = this.yaw, fp = this.pitch;
      if (this.firstShot) {
        // Guaranteed ranging miss: random-direction offset of at least 1.2 degrees,
        // widened at close range so the shot stays >= ~1.5 m off the target even in
        // trench fights — no tier can land the first shot of an engagement.
        const d = this.lastSeen
          ? dist3(s.x, s.y, s.z, this.lastSeen.x, this.lastSeen.y, this.lastSeen.z)
          : Infinity;
        const off = Math.max(1.2 * DEG, Math.atan2(1.5, d));
        const phi = this.rng() * Math.PI * 2;
        fy += off * Math.cos(phi);
        fp += off * Math.sin(phi);
        this.firstShot = false;
      }
      input.yaw = fy; input.pitch = fp;
      input.b |= BTN.FIRE;
      input.fire = { tt: this.room.serverNow() };
      // Mandatory relocate after 2 shots from within 2 m of the same position.
      if (this.lastShotPos && Math.hypot(s.x - this.lastShotPos.x, s.z - this.lastShotPos.z) < 2) {
        this.shotsFromPos++;
      } else {
        this.shotsFromPos = 1;
        this.lastShotPos = { x: s.x, z: s.z };
      }
      if (this.shotsFromPos >= 2) this.startRelocate();
    }
    return input;
  }
}
