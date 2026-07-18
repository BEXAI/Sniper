// Spawn selection: best of the fixed spawn points scored by
// distToNearestEnemy + 40 x (no line-of-sight to any enemy), rejecting any point
// with a player (or corpse-in-cam) within 2 m — there is no player-player
// collision, so overlapped spawns must be prevented HERE.
import { SPAWNS, TEST_SPAWNS, BOXES } from '../../shared/map.js';
import { EYE_HEIGHT, SPAWN_MIN_DIST } from '../../shared/constants.js';
import { rayVsBoxes, dist3 } from '../../shared/math.js';

const TEST_MODE = process.env.TEST_MODE === '1';

// enemies / occupied: arrays of {x, y, z}.
export function pickSpawn(enemies, occupied, rng) {
  if (TEST_MODE) {
    // Deterministic by construction: first unoccupied pinned point.
    for (const sp of TEST_SPAWNS) {
      let blocked = false;
      for (const o of occupied) {
        if (dist3(sp.x, sp.y, sp.z, o.x, o.y, o.z) < SPAWN_MIN_DIST) { blocked = true; break; }
      }
      if (!blocked) return sp;
    }
    return TEST_SPAWNS[0];
  }
  const list = SPAWNS;
  let best = null, bestScore = -Infinity;
  const candidates = [];
  for (const sp of list) {
    let blocked = false;
    for (const o of occupied) {
      if (dist3(sp.x, sp.y, sp.z, o.x, o.y, o.z) < SPAWN_MIN_DIST) { blocked = true; break; }
    }
    if (blocked) continue;
    candidates.push(sp);
    let minDist = Infinity, anyLos = false;
    for (const e of enemies) {
      const d = dist3(sp.x, sp.y, sp.z, e.x, e.y, e.z);
      if (d < minDist) minDist = d;
      const eye = [sp.x, sp.y + EYE_HEIGHT, sp.z];
      const dx = e.x - eye[0], dy = e.y + EYE_HEIGHT - eye[1], dz = e.z - eye[2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const wallT = rayVsBoxes(eye, [dx / len, dy / len, dz / len], BOXES, len);
      if (wallT >= len) anyLos = true;
    }
    const score = (enemies.length ? minDist : 0) + (enemies.length && !anyLos ? 40 : 0);
    if (score > bestScore) { bestScore = score; best = sp; }
  }
  if (!best) {
    // Every point was crowded — fall back to a random fixed point.
    const all = list;
    return all[Math.floor(rng() * all.length) % all.length];
  }
  if (!enemies.length && candidates.length) {
    return candidates[Math.floor(rng() * candidates.length) % candidates.length];
  }
  return best;
}
