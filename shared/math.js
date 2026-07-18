// Deterministic math helpers shared by client and server.

// mulberry32 — seeded RNG for spread rolls and tests.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }

// Shortest-arc angle lerp (radians).
export function lerpAngle(a, b, t) {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

export function normalizeAngle(a) {
  a = a % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

// yaw/pitch -> unit direction vector. Convention: yaw 0 faces -Z (Three.js camera default),
// positive pitch looks up.
export function dirFromAngles(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}

export function dist3(ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Ray vs AABB (slab method). o, d arrays [x,y,z]; box {min:[...], max:[...]}.
// Returns entry t >= 0 or Infinity.
export function rayVsAABB(o, d, box) {
  let tmin = 0, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < box.min[i] || o[i] > box.max[i]) return Infinity;
    } else {
      const inv = 1 / d[i];
      let t1 = (box.min[i] - o[i]) * inv;
      let t2 = (box.max[i] - o[i]) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return Infinity;
    }
  }
  return tmin;
}

// Nearest wall hit along ray among boxes, capped at maxT. Returns t or Infinity.
export function rayVsBoxes(o, d, boxes, maxT = Infinity) {
  let best = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const t = rayVsAABB(o, d, boxes[i]);
    if (t < best && t <= maxT) best = t;
  }
  return best;
}

// Ray vs sphere. Returns nearest t >= 0 or Infinity.
export function raySphere(o, d, cx, cy, cz, r) {
  const ox = o[0] - cx, oy = o[1] - cy, oz = o[2] - cz;
  const b = ox * d[0] + oy * d[1] + oz * d[2];
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;                    // d is unit length -> a == 1
  if (disc < 0) return Infinity;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  if (t0 >= 0) return t0;
  const t1 = -b + s;
  return t1 >= 0 ? t1 : Infinity;            // origin inside sphere still counts
}

// Ray vs vertical capsule: axis from (cx, y0, cz) to (cx, y1, cz), radius r.
// Our capsules are always vertical, so this solves the 2D circle in xz for the
// cylinder body plus the two cap spheres. Returns nearest t >= 0 or Infinity.
export function rayVsVerticalCapsule(o, d, cx, cz, y0, y1, r) {
  let best = Infinity;
  // Infinite cylinder in xz
  const ox = o[0] - cx, oz = o[2] - cz;
  const a = d[0] * d[0] + d[2] * d[2];
  if (a > 1e-12) {
    const b = ox * d[0] + oz * d[2];
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      for (const t of [(-b - s) / a, (-b + s) / a]) {
        if (t >= 0 && t < best) {
          const y = o[1] + d[1] * t;
          if (y >= y0 && y <= y1) best = t;
        }
      }
    }
  } else {
    // Vertical ray: inside the circle?
    if (ox * ox + oz * oz <= r * r) {
      // hits a cap; handled below
    }
  }
  const tc0 = raySphere(o, d, cx, y0, cz, r);
  if (tc0 < best) best = tc0;
  const tc1 = raySphere(o, d, cx, y1, cz, r);
  if (tc1 < best) best = tc1;
  return best;
}
