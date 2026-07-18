// Bot brain. Its ONLY output is a standard Input object pushed into the same queue
// humans fill from the network — bots can never do anything a human client couldn't.
// Thinks at 5 Hz (staggered by slot); emits exactly one input per tick.
import { WAYPOINTS, BOXES } from '../../../shared/map.js';
import { BTN, EYE_HEIGHT, TICK_DT } from '../../../shared/constants.js';
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
    const dy = (w.y - y) * 3;                 // weight elevation so we don't match across cliffs
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

  onDamaged() {
    if (this.mode !== 'RELOCATE' && this.rng() < 0.7) this.startRelocate();
  }

  onKill() { this.startRelocate(); }

  onDeath() {
    this.releaseNode();
    this.mode = 'PATROL';
    this.goal = this.pickPatrolGoal();
    this.targetId = null;
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

    // Stuck recovery: < 0.5 m of movement across 3 s of thinks -> repath.
    this.posHistory.push({ x: s.x, z: s.z });
    if (this.posHistory.length > 15) this.posHistory.shift();
    if (this.posHistory.length === 15 && this.mode !== 'ENGAGE') {
      const a = this.posHistory[0];
      if (Math.hypot(s.x - a.x, s.z - a.z) < 0.5) {
        this.stuckEvents++;
        this.room.botStuckEvents++;
        const cur = nearestNode(s.x, s.y, s.z);
        const adj = WAYPOINTS[cur].adj;
        if (adj.length) this.goal = adj[Math.floor(this.rng() * adj.length) % adj.length];
        this.posHistory = [];
      }
    }

    const target = this.perceive(combatants);
    if (target) {
      this.lastSeen = { x: target.state.x, y: target.state.y, z: target.state.z, at: now, id: target.id };
      if (this.mode !== 'ENGAGE') this.enterEngage(target);
      this.targetId = target.id;
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
    // Hold at the nearest unoccupied node within 25 m (cover-adjacent stop).
    let best = -1, bestD = Infinity;
    for (let i = 0; i < N; i++) {
      if (this.room.nodeOccupancy.has(i)) continue;
      const w = WAYPOINTS[i];
      const d = dist3(s.x, s.y, s.z, w.x, w.y, w.z);
      if (d < 25 && d < bestD) { bestD = d; best = i; }
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
    if (this.mode === 'INVESTIGATE') {
      const arrived = this.investigatePoint
        && dist3(s.x, s.y, s.z, this.investigatePoint.x, this.investigatePoint.y, this.investigatePoint.z) < 4;
      if (arrived || now - this.investigateSince > 8000 || !this.investigatePoint) {
        this.mode = 'PATROL';
        this.goal = this.pickPatrolGoal();
        this.investigatePoint = null;
      }
    }
    const cur = nearestNode(s.x, s.y, s.z);
    const curW = WAYPOINTS[cur];
    let stepTo = this.goal;
    if (dist3(s.x, s.y, s.z, curW.x, curW.y, curW.z) < 2.5) {
      if (cur === this.goal) {
        if (this.mode === 'RELOCATE' || this.mode === 'PATROL') {
          this.mode = 'PATROL';
          this.goal = this.pickPatrolGoal();
        }
        stepTo = this.goal;
      }
      const hop = nextHop(cur, stepTo);
      stepTo = hop >= 0 ? hop : cur;
    } else {
      // Off-graph (spawn/fall): head to the nearest node first.
      stepTo = cur;
    }
    const w = WAYPOINTS[stepTo];
    const dx = w.x - s.x, dz = w.z - s.z;
    this.desiredYaw = Math.atan2(-dx, -dz);
    // Patrol scan: sweep the eyes +-60 degrees while walking.
    if (this.mode === 'PATROL') {
      this.desiredYaw += Math.sin(now / 1000 * 0.5 * Math.PI * 2 + this.patrolPhase) * 60 * DEG;
    }
    this.desiredPitch = 0;
    this.moveBits = BTN.FWD;
    this.jumpWanted = (w.y - s.y) > 0.5 && (w.y - s.y) < 1.5 && Math.hypot(dx, dz) < 2.5;
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
    dYaw = Math.max(-maxTurn, Math.min(maxTurn, dYaw));
    this.yaw = normalizeAngle(this.yaw + dYaw);
    let dPitch = this.desiredPitch - this.pitch;
    dPitch = Math.max(-maxTurn, Math.min(maxTurn, dPitch));
    this.pitch += dPitch;

    let b = this.moveBits;
    if (this.jumpWanted) b |= BTN.JUMP;
    if (this.wantScope) b |= BTN.SCOPE;
    if (this.wantBreath) b |= BTN.BREATH;

    const input = { seq: ++this.seq, b, yaw: this.yaw, pitch: this.pitch };
    if (this.pendingFire && this.mode === 'ENGAGE') {
      this.pendingFire = false;
      let fy = this.yaw, fp = this.pitch;
      if (this.firstShot) {
        // Guaranteed ranging miss: fixed 1.2 degree offset in a random direction on
        // top of current error — no tier can land the first shot of an engagement.
        const phi = this.rng() * Math.PI * 2;
        fy += 1.2 * DEG * Math.cos(phi);
        fp += 1.2 * DEG * Math.sin(phi);
        this.firstShot = false;
      }
      input.yaw = fy; input.pitch = fp;
      input.b |= BTN.FIRE;
      input.fire = { tt: this.room.serverNow() };
      // Mandatory relocate after 2 shots from within 2 m of the same position.
      const s = this.p.state;
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
