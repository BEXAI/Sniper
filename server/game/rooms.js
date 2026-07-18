// RoomManager: room #0 is created at boot, never destroyed, and always bot-filled
// (except under TEST_MODE) — /api/status always shows a live match and a player is
// never turned away. Overflow rooms are destroyed after 60 s with zero humans.
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Room } from './room.js';
import { DEFAULT_FILL } from './bots/names.js';
import { MAX_ROOMS, OVERFLOW_IDLE_DESTROY_MS } from '../../shared/constants.js';

const TEST_MODE = process.env.TEST_MODE === '1';

export class RoomManager {
  constructor(store) {
    this.store = store;
    this.rooms = [];
    this.roomCounter = 0;
    const r0 = this.createRoom({ botFill: !TEST_MODE });   // room r0, permanent
    // Room #0 is always bot-filled to 6; at boot nobody is watching, so seed
    // immediately instead of the staggered "reads as a human joining" refill.
    if (r0.botFill) {
      for (const tier of DEFAULT_FILL) r0.addBot(tier);
    }
  }

  createRoom({ botFill = true } = {}) {
    const seed = TEST_MODE ? 12345 + this.roomCounter : crypto.randomBytes(4).readUInt32LE(0);
    // Seed the room clock now — on-demand overflow rooms take joins before their
    // first step() tick, and welcome/spawn protection must not see now=0.
    const room = new Room(`r${this.roomCounter++}`, this.store, seed, { botFill, now: performance.now() });
    this.rooms.push(room);
    return room;
  }

  // Quick-join: the room with the MOST humans that has a free slot (players cluster);
  // all full -> spin up an overflow room (max 2 total); beyond that, null (FULL).
  pickRoomForHuman() {
    const open = this.rooms
      .filter((r) => r.hasFreeSlotForHuman())
      .sort((a, b) => b.humans().length - a.humans().length);
    if (open.length) return open[0];
    if (this.rooms.length < MAX_ROOMS) return this.createRoom({ botFill: !TEST_MODE });
    return null;
  }

  pickRoomForSpectator() {
    // Spectate the busiest room with observer space; room #0 always exists.
    const open = this.rooms
      .filter((r) => r.spectators.length < 4)
      .sort((a, b) => b.humans().length - a.humans().length);
    return open.length ? open[0] : null;
  }

  step(tick, now) {
    for (const room of this.rooms) room.step(tick, now);

    // Overflow rooms with 0 humans for 60 s are destroyed; their spectators are
    // migrated to room #0 with a fresh welcome (room #0 always exists).
    for (let i = this.rooms.length - 1; i >= 1; i--) {
      const room = this.rooms[i];
      if (room.humans().length > 0) { room.emptySince = 0; continue; }
      if (room.emptySince === 0) room.emptySince = now;
      else if (now - room.emptySince > OVERFLOW_IDLE_DESTROY_MS) {
        const displaced = [...room.spectators];
        this.rooms.splice(i, 1);
        const home = this.rooms[0];
        for (const conn of displaced) {
          if (home.addSpectator(conn)) {
            conn.room = home;
            conn.send(home.buildWelcome(null, now, tick));
          } else {
            conn.kick('FULL');
          }
        }
      }
    }
  }

  status(now) {
    return this.rooms.map((r) => ({
      id: r.id,
      humans: r.humans().length,
      bots: r.bots().length,
      spectators: r.spectators.length,
      phase: r.matchState,
      endsIn: Math.max(0, Math.round(r.matchEndsAt - now)),
      botStuck: r.botStuckEvents,
    }));
  }
}
