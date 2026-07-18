// Player entity: one per combatant (human or bot). Holds the authoritative movement
// state, the network input queue with input-debt accounting, and the lag-comp ring.
import { defaultState, step } from '../../shared/movement.js';
import { MAP } from '../../shared/map.js';
import { makeRing, recordPose } from './lagcomp.js';
import {
  BTN, TICK_DT, TICK_MS, MAX_HP, STARVE_NEUTRAL_MS, AFK_REMOVE_MS,
} from '../../shared/constants.js';

// Persistent movement bits re-applied during starvation; fire/reload/jump edges are
// STRIPPED and never replayed (a lagged player must not turn into a turret).
const PERSISTENT_BITS = BTN.FWD | BTN.BACK | BTN.LEFT | BTN.RIGHT | BTN.SCOPE | BTN.BREATH;

export class Player {
  constructor({ id, name, isBot = false, rank = 0, xp = 0, swaySeed = 1 }) {
    this.id = id;
    this.name = name;
    this.isBot = isBot;
    this.rank = rank;
    this.xp = xp;
    this.conn = null;              // set for humans by connection.js

    this.state = defaultState();
    this.hp = MAX_HP;
    this.status = 'DEAD';          // 'ALIVE' | 'DEAD'; spawns via room.spawnPlayer
    this.respawnAt = 0;
    this.protectUntil = 0;
    this.swaySeed = swaySeed;

    this.queue = [];
    this.lastInput = null;
    this.lastYaw = 0;
    this.lastPitch = 0;
    this.lastAckSeq = 0;
    this.guessedSteps = 0;
    this.starvedMs = 0;
    this.lastRealInputAt = Date.now();

    this.ring = makeRing();

    // Match-scoped counters (reset each round).
    this.kills = 0;
    this.deaths = 0;
    this.hs = 0;
    this.streak = 0;
    this.matchXp = 0;
    this.xpItems = { kills: 0, headshots: 0, streaks: 0, place: 0 };
    this.longestKill = 0;
    this.ping = 0;

    // Bot bookkeeping
    this.botCtl = null;
    this.evictDeadline = 0;        // >0 when marked for eviction
  }

  alive() { return this.status === 'ALIVE'; }

  queueInput(input) {
    this.queue.push(input);
    this.lastRealInputAt = Date.now();
  }

  isAfk() {
    return !this.isBot && Date.now() - this.lastRealInputAt > AFK_REMOVE_MS;
  }

  // Drains the input queue for one tick with input-debt accounting (spec §1.2).
  // Returns fire requests captured at input-processing time.
  processTick() {
    const fires = [];
    if (this.queue.length === 0) {
      // Late packet: re-apply only the persistent movement portion of the last
      // input. Do NOT advance the ack. After 1 s of starvation go fully neutral.
      this.starvedMs += TICK_MS;
      let b = 0;
      if (this.starvedMs < STARVE_NEUTRAL_MS && this.lastInput) {
        b = this.lastInput.b & PERSISTENT_BITS;
      }
      if (this.alive()) {
        step(this.state, { b, yaw: this.lastYaw, pitch: this.lastPitch }, TICK_DT, MAP);
      }
      this.guessedSteps++;
    } else {
      this.starvedMs = 0;
      let n = Math.min(2, this.queue.length);
      while (n-- > 0) {
        const input = this.queue.shift();
        this.lastInput = input;
        this.lastYaw = input.yaw;
        this.lastPitch = input.pitch;
        this.lastAckSeq = input.seq;
        // While in debt, the guessed step already consumed this tick's movement:
        // dt=0 resolves fire/reload edges without double-integrating.
        let dt = TICK_DT;
        if (this.guessedSteps > 0) { this.guessedSteps--; dt = 0; }
        if (this.alive()) {
          const ev = step(this.state, input, dt, MAP);
          if (ev.fired && input.fire) {
            const s = this.state;
            fires.push({
              yaw: input.yaw, pitch: input.pitch, tt: input.fire.tt,
              scoped: s.scoped, scopedMs: s.scopedMs,
              swayState: {
                movingScoped: s.scoped && (Math.abs(s.vx) + Math.abs(s.vz) > 0.1),
                breathHeld: s.holding,
                forcedExhale: s.exhaleMs > 0,
                msSinceLanding: s.landMs,
              },
            });
          }
        }
      }
    }
    return fires;
  }

  recordHistory(tick, t) {
    recordPose(this.ring, tick, t, this.state);
  }

  resetForRound() {
    this.kills = 0; this.deaths = 0; this.hs = 0; this.streak = 0;
    this.matchXp = 0;
    this.xpItems = { kills: 0, headshots: 0, streaks: 0, place: 0 };
    this.longestKill = 0;
  }
}
