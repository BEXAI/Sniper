// Remote-player snapshot interpolation at renderTime = serverTime - 100 ms, with
// extrapolation capped at 100 ms (never through walls) on snapshot starvation.
import { BOXES } from '/shared/map.js';
import { lerpAngle } from '/shared/math.js';
import { EXTRAP_CAP_MS } from '/shared/constants.js';

function insideAnyBox(x, y, z) {
  for (const box of BOXES) {
    if (x > box.min[0] && x < box.max[0]
      && y + 0.9 > box.min[1] && y < box.max[1]
      && z > box.min[2] && z < box.max[2]) return true;
  }
  return false;
}

export class Interp {
  constructor() {
    this.players = new Map();     // id -> [{t, x, y, z, yaw, pitch, sc, st, hp}]
  }

  onSnap(t, players) {
    for (const p of players) {
      let buf = this.players.get(p.id);
      if (!buf) { buf = []; this.players.set(p.id, buf); }
      buf.push({ t, ...p });
      while (buf.length && t - buf[0].t > 1000) buf.shift();
    }
    // Drop buffers for players no longer in snapshots (left the room).
    const ids = new Set(players.map((p) => p.id));
    for (const id of this.players.keys()) if (!ids.has(id)) this.players.delete(id);
  }

  // On a spawn event purge older entries so the player doesn't lerp across the map.
  purge(id) { this.players.delete(id); }

  sample(renderTime) {
    const out = new Map();
    for (const [id, buf] of this.players) {
      if (!buf.length) continue;
      let a = null, b = null;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i].t <= renderTime) { a = buf[i]; b = buf[i + 1] || null; break; }
      }
      if (!a) { out.set(id, { ...buf[0] }); continue; }
      if (b) {
        const f = (renderTime - a.t) / (b.t - a.t);
        out.set(id, {
          id,
          x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f,
          yaw: lerpAngle(a.yaw, b.yaw, f), pitch: lerpAngle(a.pitch, b.pitch, f),
          sc: a.sc, st: a.st, hp: a.hp,
        });
      } else {
        // Starvation: extrapolate from the last two snapshots, capped, clamped.
        const prev = buf[buf.length - 2];
        const last = buf[buf.length - 1];
        let x = last.x, y = last.y, z = last.z;
        if (prev && last.t > prev.t) {
          const dtMs = Math.min(EXTRAP_CAP_MS, renderTime - last.t);
          const inv = 1 / (last.t - prev.t);
          const nx = last.x + (last.x - prev.x) * inv * dtMs;
          const ny = last.y + (last.y - prev.y) * inv * dtMs;
          const nz = last.z + (last.z - prev.z) * inv * dtMs;
          if (!insideAnyBox(nx, ny, nz)) { x = nx; y = ny; z = nz; }
        }
        out.set(id, { id, x, y, z, yaw: last.yaw, pitch: last.pitch, sc: last.sc, st: last.st, hp: last.hp });
      }
    }
    return out;
  }
}
