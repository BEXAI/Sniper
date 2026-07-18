// "The Ravine" — 200 x 120 m arena. ONE source of truth consumed by client rendering,
// server collision, server occlusion rays, and bot pathing.
//
// Layout (top-down, X east, Z south):
//   z -60..-54  sunken flank trench (floor -2) along the north edge, exit ramps every 40 m
//   z -54..-48  north service road (y 0)
//   z -48..-26  north cliff shelf (solid, top y 6) with 2 nests + NW tower (platform y 9)
//   z -26..26   canyon floor (y 0): staggered rocks, clear east-west lane at |z| < 5
//   z  26..48   south cliff shelf (top y 6) with 2 nests + SE tower
//   z  48..60   south service road (y 0)
//   x ±92..±100 ground-level side corridors linking roads and canyon (flank routes)
// Shelf/tower stairs all face AWAY from the canyon; the bridge (deck y 5.6) crosses at x 0.

export const MAP_VERSION = 1;

const boxes = [];
function B(minX, minY, minZ, maxX, maxY, maxZ, mat = 'rock') {
  boxes.push({ min: [minX, minY, minZ], max: [maxX, maxY, maxZ], mat });
}

// --- Floors ---
B(-100, -3, -54, 100, 0, 60, 'ground');     // main ground, top y=0
B(-100, -3, -60, 100, -2, -54, 'ground');   // trench floor, top y=-2

// --- Boundary walls (top y=8: tower platforms at 9 silhouette above them) ---
B(-102, -3, -62, 102, 8, -60, 'wall');      // north
B(-102, -3, 60, 102, 8, 62, 'wall');        // south
B(-102, -3, -62, -100, 8, 62, 'wall');      // west
B(100, -3, -62, 102, 8, 62, 'wall');        // east

// --- Trench exit ramps (4 x 0.4 m risers rising south into the north road) ---
for (const xc of [-80, -40, 0, 40, 80]) {
  for (let i = 0; i < 4; i++) {
    const top = -0.4 * (i + 1);
    B(xc - 2, -3, -54 - 1.2 * (i + 1), xc + 2, top, -54 - 1.2 * i, 'concrete');
  }
}

// --- Cliff shelves (solid plateaus, top y 6) ---
B(-92, -3, -48, 92, 6, -26, 'rock');        // north shelf
B(-92, -3, 26, 92, 6, 48, 'rock');          // south shelf

// --- Shelf stairs: 15 x 0.4 m risers running 12 m along the road-facing face ---
// dir +1 rises eastward from x0, dir -1 rises westward from x0.
function stair(x0, dir, zLo, zHi) {
  for (let k = 0; k < 15; k++) {
    const xa = x0 + dir * 0.8 * k, xb = x0 + dir * 0.8 * (k + 1);
    B(Math.min(xa, xb), -1, zLo, Math.max(xa, xb), 0.4 * (k + 1), zHi, 'concrete');
  }
}
stair(-66, 1, -50, -48);   // north shelf, west stair (top lands at x -54)
stair(66, -1, -50, -48);   // north shelf, east stair (top at x 54)
stair(-66, 1, 48, 50);     // south shelf, west stair
stair(66, -1, 48, 50);     // south shelf, east stair

// --- Sniper nests: waist-high parapets on the shelf canyon edges at x ±60 ---
function nest(xc, edgeZ, inward) {
  // Front parapet (two segments + central firing gap), 1 m tall on the shelf top.
  const zA = edgeZ, zB = edgeZ + inward * 0.6;
  B(xc - 3, 6, Math.min(zA, zB), xc - 0.6, 7, Math.max(zA, zB), 'concrete');
  B(xc + 0.6, 6, Math.min(zA, zB), xc + 3, 7, Math.max(zA, zB), 'concrete');
  // Side wings, slightly taller, for lateral cover on the shelf.
  const zC = edgeZ, zD = edgeZ + inward * 2.4;
  B(xc - 3.6, 6, Math.min(zC, zD), xc - 3, 7.4, Math.max(zC, zD), 'concrete');
  B(xc + 3, 6, Math.min(zC, zD), xc + 3.6, 7.4, Math.max(zC, zD), 'concrete');
}
nest(-60, -26.6, -1);      // north shelf, west nest (parapet at z -27.2..-26.6)
nest(60, -26.6, -1);       // north shelf, east nest
nest(-60, 26.6, 1);        // south shelf, west nest
nest(60, 26.6, 1);         // south shelf, east nest

// --- Corner towers (platform top y 9, stairs face away from the canyon) ---
function tower(xc, zc, stairDir) {
  B(xc - 1.2, 6, zc - 1.2, xc + 1.2, 8.6, zc + 1.2, 'metal');          // pillar
  B(xc - 2.5, 8.6, zc - 2.5, xc + 2.5, 9, zc + 2.5, 'metal');          // platform
  // Canyon-facing parapets with firing gaps (canyon side = -stairDir).
  const pz = zc - stairDir * 2.5;
  B(xc - 2.5, 9, Math.min(pz, pz - stairDir * 0.4), xc - 0.5, 9.8, Math.max(pz, pz - stairDir * 0.4), 'metal');
  B(xc + 0.5, 9, Math.min(pz, pz - stairDir * 0.4), xc + 2.5, 9.8, Math.max(pz, pz - stairDir * 0.4), 'metal');
  // 7 risers from shelf (6) to platform (9), running outward from the platform edge.
  for (let k = 1; k <= 7; k++) {
    const top = 9 - (3 / 7) * k;
    const zNear = zc + stairDir * (2.5 + 0.8 * (k - 1));
    const zFar = zc + stairDir * (2.5 + 0.8 * k);
    B(xc - 1, 6, Math.min(zNear, zFar), xc + 1, top, Math.max(zNear, zFar), 'metal');
  }
}
tower(-85, -37, -1);       // NW tower on the north shelf, stairs run north
tower(85, 37, 1);          // SE tower on the south shelf, stairs run south

// --- Bridge across the canyon at x 0 (deck y 5.2..5.6, no rails: falling is the risk) ---
B(-2, 5.2, -26.5, 2, 5.6, 26.5, 'metal');

// --- Canyon rocks/pillars (staggered 2-4 s exposure windows; |z| >= 6 keeps the lane clear) ---
const ROCKS = [
  [-80, 10, 3, 2.5, 2.2], [-62, -12, 2.5, 2, 1.8], [-48, 14, 4, 3, 2.6],
  [-30, -9, 2, 2, 1.6], [-18, 16, 3, 2.5, 2.4], [-5, -14, 2.5, 2.5, 2.0],
  [8, 12, 3.5, 2.5, 2.8], [22, -16, 2.5, 2, 1.7], [38, 9, 3, 3, 2.5],
  [55, -11, 2, 2, 1.9], [70, 15, 3, 2.5, 2.3], [88, -8, 2.5, 2, 2.0],
];
for (const [x, z, w, d, h] of ROCKS) B(x - w / 2, 0, z - d / 2, x + w / 2, h, z + d / 2, 'rock');

export const BOXES = boxes;

// --- Spawn points (y = floor top at that spot) ---
// yaw such that forward (-sin yaw, -cos yaw) points from spawn toward the origin:
function spawnFacingCenter(x, y, z) {
  const dx = -x, dz = -z;
  return { x, y, z, yaw: Math.atan2(-dx, -dz) };
}
export const SPAWNS = [
  spawnFacingCenter(-60, -2, -57),   // trench west (between ramps)
  spawnFacingCenter(60, -2, -57),    // trench east
  spawnFacingCenter(-75, 0, -51),    // north road west, behind the stair
  spawnFacingCenter(75, 0, 51),      // south road east
  spawnFacingCenter(-85, 0, 8),      // canyon west, behind rock
  spawnFacingCenter(84, 0, -10),     // canyon east, behind rock
  spawnFacingCenter(-30, 6, -44),    // north shelf back
  spawnFacingCenter(30, 6, 44),      // south shelf back
];

// TEST_MODE pinned spawns: mutually visible along the clear canyon lane, 40 m apart.
export const TEST_SPAWNS = [
  { x: -20, y: 0, z: 0, yaw: -Math.PI / 2 },  // faces +X
  { x: 20, y: 0, z: 0, yaw: Math.PI / 2 },    // faces -X
];

// --- Waypoint graph for bots (elevated = y >= 5 for patrol preference) ---
const WP = [];
const wpIndex = new Map();
function wp(name, x, y, z) {
  wpIndex.set(name, WP.length);
  WP.push({ name, x, y, z, adj: [], elevated: y >= 5 });
}
// Trench (north walkway, clear of the ramp footprints)
wp('t-80', -80, -2, -59.3); wp('t-40', -40, -2, -59.3); wp('t0', 0, -2, -59.3);
wp('t40', 40, -2, -59.3); wp('t80', 80, -2, -59.3);
// North road + corners
wp('rN-80', -80, 0, -51); wp('rN0', 0, 0, -51); wp('rN80', 80, 0, -51);
wp('cNW', -96, 0, -51); wp('cNE', 96, 0, -51);
// Side corridors
wp('w1', -96, 0, -36); wp('w2', -96, 0, 0); wp('w3', -96, 0, 36);
wp('e1', 96, 0, -36); wp('e2', 96, 0, 0); wp('e3', 96, 0, 36);
// South road + corners
wp('cSW', -96, 0, 51); wp('cSE', 96, 0, 51);
wp('rS-80', -80, 0, 51); wp('rS0', 0, 0, 51); wp('rS80', 80, 0, 51);
// Shelf stairs (bottoms on the roads, tops on the shelves)
wp('nbW', -68, 0, -49); wp('ntW', -53, 6, -46);
wp('nbE', 68, 0, -49); wp('ntE', 53, 6, -46);
wp('sbW', -68, 0, 49); wp('stW', -53, 6, 46);
wp('sbE', 68, 0, 49); wp('stE', 53, 6, 46);
// Nests
wp('nnW', -60, 6, -28); wp('nnE', 60, 6, -28);
wp('nsW', -60, 6, 28); wp('nsE', 60, 6, 28);
// Towers (bottom of tower stairs, platform top)
wp('tnB', -85, 6, -46.5); wp('tnT', -85, 9, -37);
wp('tsB', 85, 6, 46.5); wp('tsT', 85, 9, 37);
// Bridge (shelf-side entries at x 0, deck center)
wp('bN', 0, 6, -28); wp('bC', 0, 5.6, 0); wp('bS', 0, 6, 28);
// Canyon floor
wp('cw', -75, 0, 0); wp('c1', -40, 0, -10); wp('c2', -10, 0, 10);
wp('c3', 20, 0, -10); wp('c4', 50, 0, 10); wp('ce', 80, 0, 0);

const EDGES = [
  ['t-80', 't-40'], ['t-40', 't0'], ['t0', 't40'], ['t40', 't80'],
  ['t-80', 'rN-80'], ['t0', 'rN0'], ['t80', 'rN80'],          // trench ramps
  ['rN-80', 'rN0'], ['rN0', 'rN80'],
  ['rN-80', 'cNW'], ['rN80', 'cNE'],
  ['cNW', 'w1'], ['w1', 'w2'], ['w2', 'w3'], ['w3', 'cSW'],
  ['cNE', 'e1'], ['e1', 'e2'], ['e2', 'e3'], ['e3', 'cSE'],
  ['cSW', 'rS-80'], ['rS-80', 'rS0'], ['rS0', 'rS80'], ['rS80', 'cSE'],
  ['rN-80', 'nbW'], ['nbW', 'ntW'], ['rN80', 'nbE'], ['nbE', 'ntE'],
  ['rS-80', 'sbW'], ['sbW', 'stW'], ['rS80', 'sbE'], ['sbE', 'stE'],
  ['ntW', 'nnW'], ['ntE', 'nnE'], ['ntW', 'ntE'], ['nnW', 'nnE'],
  ['ntW', 'tnB'], ['tnB', 'tnT'],
  ['nnW', 'bN'], ['nnE', 'bN'], ['bN', 'bC'], ['bC', 'bS'],
  ['stW', 'nsW'], ['stE', 'nsE'], ['stW', 'stE'], ['nsW', 'nsE'],
  ['stE', 'tsB'], ['tsB', 'tsT'],
  ['nsW', 'bS'], ['nsE', 'bS'],
  ['w2', 'cw'], ['cw', 'c1'], ['c1', 'c2'], ['c2', 'c3'], ['c3', 'c4'], ['c4', 'ce'], ['ce', 'e2'],
];
for (const [a, b] of EDGES) {
  const ia = wpIndex.get(a), ib = wpIndex.get(b);
  WP[ia].adj.push(ib);
  WP[ib].adj.push(ia);
}
export const WAYPOINTS = WP;

export const MAP = { boxes: BOXES };
