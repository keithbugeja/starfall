// Celestial bodies: star, planets, moons. Terrain is an equatorial radius profile that doubles
// as the collision surface. Gravity is 1/r^2 clamped, faded to zero at the sphere of influence.
import { clamp, fbm3, lerp, Rng, smoothstep, TAU, type V2 } from '../engine/math';
import type { Fissure } from './walls';
import type { Structure } from './structures';

export type BodyKind = 'star' | 'planet' | 'moon' | 'gas' | 'hull';
export type PlanetType = 'rock' | 'ice' | 'volcanic' | 'desert' | 'gas' | 'star' | 'crystal';

export type PadKind = 'colony' | 'mine' | 'derelict' | 'enemybase' | 'outpost' | 'core' | 'thruster';

export interface Pad {
  id: number;
  body: Body;
  kind: PadKind;
  name: string;
  angle: number;       // centre angle on the equator (sim plane)
  segIndex: number;    // first terrain segment the pad occupies
  segCount: number;    // segments flattened under the pad (finely cut worlds need several for one pad)
  height: number;      // surface radius at the pad
  halfWidth: number;   // half length of the pad in world units
  // gameplay state
  alive: boolean;
  population: number;  // colonies: pods available; mines: ore stock
  stock: number;
  fuel: boolean;       // offers refuel
  repair: boolean;
  visited: boolean;
  lastRaid: number;
  enemyHealth: number; // for enemy bases
  spawnTimer: number;
  discovered: boolean;
  integrity: number;   // 0..100 structural health for colonies and mines
  guns: number;        // enemy bases: sentinels the base keeps
  plant: Structure | null;    // local power plant (null when fed from the body's grid)
  radiator: Structure | null; // sheds the heat of the base's guns
  mast: Structure | null;     // long-range sensor
}

export interface Orbit {
  parent: Body;
  radius: number;
  angularSpeed: number; // rad/s
  phase: number;
}

export interface Body {
  id: number;
  name: string;
  kind: BodyKind;
  type: PlanetType;
  pos: V2;
  vel: V2;             // derived orbital velocity (for landed ships & relative motion)
  radius: number;      // nominal equatorial radius
  mass: number;        // GM
  soi: number;         // gravity fades out here
  surfaceG: number;
  roughness: number;
  segments: number;    // number of equatorial terrain segments
  terrain: Float32Array; // surface radius at each vertex angle i * TAU / segments
  pads: Pad[];
  orbit: Orbit | null;
  palette: { low: number[]; mid: number[]; high: number[]; glow?: number[] };
  oblate: number;
  landable: boolean;
  meshIndex: number;   // filled by the renderer
  seed: number;
  heatRadius: number;  // star: distance within which hull heats
  warmRadius: number;  // star: distance within which weapons run hot
  farMass: number;     // star: the weak field beyond its near zone that the planets' rails obey
  faceParent: boolean; // rails hulls that keep one face toward what they orbit (a vane toward the star)
  secret: boolean;     // unnamed on the map and in the world until the pilot has been there or pinged it
  spin: number;        // visual spin only (gas giants)
  spinAngle: number;
  maxRadius: number;   // cached max terrain radius
  rotates: boolean;    // spinAngle turns terrain, pads and landed ships with the body
  free: boolean;       // integrated under gravity and impulses instead of riding rails
  bodyMass: number;    // inertial mass (free bodies)
  inertia: number;     // moment of inertia (free bodies)
  angVel: number;      // rad/s (free bodies)
  fissures: Fissure[];
  thrusters: Thruster[];
  hollow: boolean;     // answers a ping with an echo
  integrity: number;   // structural health for hulls
  tetherable: boolean; // a cable can latch onto its surface
  flashUntil: number;
}

/** A fixed thruster on a hull: fuelled by transfer, fires while its tank has fuel. */
export interface Thruster {
  name: string;
  pad: Pad;
  dirLocal: V2;    // unit direction of the thrust force in the body's local frame
  force: number;
  fuel: number;
  capacity: number;
  burn: number;    // fuel per second while firing
}

let nextBodyId = 1;
let nextPadId = 1;

export function resetBodyIds(): void { nextBodyId = 1; nextPadId = 1; }

export interface BodySpec {
  name: string;
  kind: BodyKind;
  type: PlanetType;
  radius: number;
  surfaceG: number;
  soiMul?: number;
  roughness?: number;
  orbit?: { parent: Body; radius: number; period: number; phase: number };
  palette: { low: number[]; mid: number[]; high: number[]; glow?: number[] };
  landable?: boolean;
  seed: number;
  oblate?: number;
  free?: boolean;
  rotates?: boolean;
  bodyMass?: number;
  inertia?: number;
  hollow?: boolean;
  tetherable?: boolean;
  faceParent?: boolean;
  secret?: boolean;
  profile?: (angle: number) => number; // custom radius profile (hulls)
  segments?: number;
  spin?: number;       // rad/s for bodies whose terrain turns (day and night)
}

export function createBody(spec: BodySpec): Body {
  const segments = spec.segments ?? (spec.kind === 'star' ? 48 : spec.kind === 'gas' ? 64 : clamp(Math.round(spec.radius / 1.55), 36, 128));
  const b: Body = {
    id: nextBodyId++,
    name: spec.name,
    kind: spec.kind,
    type: spec.type,
    pos: { x: 0, y: 0 },
    vel: { x: 0, y: 0 },
    radius: spec.radius,
    mass: spec.surfaceG * spec.radius * spec.radius,
    soi: spec.radius * (spec.soiMul ?? (spec.kind === 'moon' ? 4.5 : spec.kind === 'star' ? 3.5 : 7)),
    surfaceG: spec.surfaceG,
    roughness: spec.roughness ?? 0,
    segments,
    terrain: new Float32Array(segments),
    pads: [],
    orbit: spec.orbit ? { parent: spec.orbit.parent, radius: spec.orbit.radius, angularSpeed: TAU / spec.orbit.period, phase: spec.orbit.phase } : null,
    palette: spec.palette,
    oblate: spec.oblate ?? (spec.kind === 'star' ? 1 : spec.kind === 'gas' ? 0.45 : 0.32),
    landable: spec.landable ?? (spec.kind === 'planet' || spec.kind === 'moon'),
    meshIndex: -1,
    seed: spec.seed,
    heatRadius: spec.kind === 'star' ? spec.radius * 1.9 : 0,
    warmRadius: spec.kind === 'star' ? spec.radius * 5.2 : 0,
    farMass: 0,
    faceParent: spec.faceParent ?? false,
    secret: spec.secret ?? false,
    spin: spec.spin ?? (spec.kind === 'gas' ? 0.03 : spec.kind === 'star' ? 0.01 : 0),
    spinAngle: 0,
    maxRadius: spec.radius,
    rotates: spec.rotates ?? false,
    free: spec.free ?? false,
    bodyMass: spec.bodyMass ?? 1e9,
    inertia: spec.inertia ?? 1e12,
    angVel: 0,
    fissures: [],
    thrusters: [],
    hollow: spec.hollow ?? false,
    integrity: 100,
    tetherable: spec.tetherable ?? false,
    flashUntil: -1e9,
  };
  for (let i = 0; i < segments; i++) b.terrain[i] = spec.profile ? spec.profile((i / segments) * TAU) : surfaceRadiusRaw(b, (i / segments) * TAU, 0);
  recomputeMaxRadius(b);
  return b;
}

/** Continuous procedural surface radius before pads are carved. lon in radians, lat in [-pi/2, pi/2]. */
export function surfaceRadiusRaw(b: Body, lon: number, lat: number): number {
  if (b.roughness <= 0) return b.radius;
  const cl = Math.cos(lat);
  const x = Math.cos(lon) * cl, y = Math.sin(lon) * cl, z = Math.sin(lat);
  const f = 2.6;
  let n = fbm3(x * f + 3.1, y * f + 1.7, z * f + 9.3, 4, b.seed, 2.2, 0.5);
  // sharpen: ridges
  const ridge = 1 - Math.abs(fbm3(x * f * 2.3 + 11, y * f * 2.3 + 5, z * f * 2.3 + 2, 2, b.seed + 77));
  n = n * 0.75 + (ridge - 0.5) * 0.5;
  return b.radius * (1 + b.roughness * n);
}

/** Surface radius including pad flattening. */
export function surfaceRadius(b: Body, lon: number, lat: number): number {
  let r = surfaceRadiusRaw(b, lon, lat);
  for (const p of b.pads) {
    let d = lon - p.angle;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const arc = Math.abs(d) * b.radius;
    const w = p.halfWidth * 1.9;
    if (arc < w) {
      const latMask = 1 - smoothstep(0.08, 0.32, Math.abs(lat));
      const mask = (1 - smoothstep(p.halfWidth * 0.95, w, arc)) * latMask;
      r = lerp(r, p.height, mask);
    }
  }
  return r;
}

/** Carve a pad into the terrain profile at the given angle. Returns the pad. */
export function addPad(b: Body, kind: PadKind, name: string, angle: number, halfWidth: number): Pad {
  const seg = b.segments;
  // enough whole segments to span the pad's width, snapped so the pad is a run of flat chords
  const arc = (TAU / seg) * b.radius;
  const count = Math.max(1, Math.round((halfWidth * 2) / arc));
  const idx = Math.floor((((angle / TAU) * seg - count / 2 + 0.5) + 1e-6 + seg * 4) % seg);
  const centre = ((idx + count / 2) / seg) * TAU;
  const i0 = idx;
  // pad height: the mean of the vertices it covers, but never in a hole deeper than 14% of R
  let h = 0;
  for (let k = 0; k <= count; k++) h += b.terrain[(i0 + k) % seg];
  h = Math.max(b.radius * 0.86, h / (count + 1));
  const pad: Pad = {
    id: nextPadId++, body: b, kind, name, angle: centre, segIndex: idx, segCount: count, height: h, halfWidth,
    alive: true, population: 0, stock: 0, fuel: false, repair: false, visited: false, lastRaid: -1e9,
    enemyHealth: 0, spawnTimer: 0, discovered: false, integrity: 100,
    guns: 1, plant: null, radiator: null, mast: null,
  };
  b.pads.push(pad);
  for (let k = 0; k <= count; k++) b.terrain[(i0 + k) % seg] = h;
  // keep the neighbours approachable: no cliff taller than 8% of R right beside the pad
  const maxN = h + b.radius * 0.08;
  const im = (i0 - 1 + seg) % seg, ip = (i0 + count + 1) % seg;
  if (b.terrain[im] > maxN) b.terrain[im] = maxN;
  if (b.terrain[ip] > maxN) b.terrain[ip] = maxN;
  recomputeMaxRadius(b);
  return pad;
}

/** Convert a world-frame angle about the body's centre to the body's local frame. */
export function bodyLocalAngle(b: Body, worldAngle: number): number { return b.rotates ? worldAngle - b.spinAngle : worldAngle; }

/** Does a terrain segment index lie under the pad? */
export function padCoversSegment(p: Pad, seg: number): boolean {
  const n = p.body.segments;
  const d = ((seg - p.segIndex) % n + n) % n;
  return d < p.segCount;
}

/** World-frame angle of a pad's centre. */
export function padWorldAngle(p: Pad): number { return p.body.rotates ? p.angle + p.body.spinAngle : p.angle; }

/** World position of a pad's centre at an altitude above it. */
export function padWorldPos(p: Pad, alt = 0): V2 {
  const a = padWorldAngle(p);
  return { x: p.body.pos.x + Math.cos(a) * (p.height + alt), y: p.body.pos.y + Math.sin(a) * (p.height + alt) };
}

/** Velocity of the body's surface at a world point (includes rotation of free hulls). */
export function surfaceVelocity(b: Body, x: number, y: number): V2 {
  const wv = b.rotates ? (b.free ? b.angVel : b.spin) : 0;
  if (wv === 0) return { x: b.vel.x, y: b.vel.y };
  const rx = x - b.pos.x, ry = y - b.pos.y;
  return { x: b.vel.x - wv * ry, y: b.vel.y + wv * rx };
}

/** Surface radius at an arbitrary world angle by linear interpolation of the terrain polygon (chord). */
export function terrainRadiusAt(b: Body, worldAngle: number): number {
  const angle = bodyLocalAngle(b, worldAngle);
  const seg = b.segments;
  const t = ((angle / TAU) * seg % seg + seg) % seg;
  const i0 = Math.floor(t), i1 = (i0 + 1) % seg;
  const f = t - i0;
  // interpolate along the chord (true polygon surface), not the arc
  const a0 = (i0 / seg) * TAU, a1 = ((i0 + 1) / seg) * TAU;
  const r0 = b.terrain[i0], r1 = b.terrain[i1];
  const x0 = Math.cos(a0) * r0, y0 = Math.sin(a0) * r0;
  const x1 = Math.cos(a1) * r1, y1 = Math.sin(a1) * r1;
  const px = x0 + (x1 - x0) * f, py = y0 + (y1 - y0) * f;
  // radial distance of the chord point at the parameter f is close enough to the exact intersection
  return Math.hypot(px, py);
}

/** Outward surface normal (sim plane, world frame) of the terrain segment under the given world angle. */
export function terrainNormalAt(b: Body, worldAngle: number): V2 {
  const angle = bodyLocalAngle(b, worldAngle);
  const seg = b.segments;
  const t = ((angle / TAU) * seg % seg + seg) % seg;
  const i0 = Math.floor(t), i1 = (i0 + 1) % seg;
  const a0 = (i0 / seg) * TAU, a1 = ((i0 + 1) / seg) * TAU;
  const r0 = b.terrain[i0], r1 = b.terrain[i1];
  const x0 = Math.cos(a0) * r0, y0 = Math.sin(a0) * r0;
  const x1 = Math.cos(a1) * r1, y1 = Math.sin(a1) * r1;
  const dx = x1 - x0, dy = y1 - y0;
  const l = Math.hypot(dx, dy) || 1;
  // segment runs counter-clockwise, so outward normal is (dy, -dx)
  if (!b.rotates) return { x: dy / l, y: -dx / l };
  const c = Math.cos(b.spinAngle), s = Math.sin(b.spinAngle);
  const nx = dy / l, ny = -dx / l;
  return { x: nx * c - ny * s, y: nx * s + ny * c };
}

/** Segment index under a world angle. */
export function terrainSegmentAt(b: Body, worldAngle: number): number {
  const angle = bodyLocalAngle(b, worldAngle);
  const seg = b.segments;
  return Math.floor(((angle / TAU) * seg % seg + seg) % seg);
}

/** Maximum terrain radius (for broad-phase). Cached. */
export function maxTerrainRadius(b: Body): number { return b.maxRadius; }

export function recomputeMaxRadius(b: Body): void {
  let m = 0;
  for (let i = 0; i < b.segments; i++) if (b.terrain[i] > m) m = b.terrain[i];
  b.maxRadius = m;
}

/** Update orbital positions. Children must come after parents in the list. */
export function updateOrbits(bodies: Body[], time: number, dt: number): void {
  for (const b of bodies) {
    if (b.free) { b.spinAngle += b.angVel * dt; continue; }
    if (b.orbit) {
      const a = b.orbit.phase + b.orbit.angularSpeed * time;
      const nx = b.orbit.parent.pos.x + Math.cos(a) * b.orbit.radius;
      const ny = b.orbit.parent.pos.y + Math.sin(a) * b.orbit.radius;
      if (dt > 0) { b.vel.x = (nx - b.pos.x) / dt; b.vel.y = (ny - b.pos.y) / dt; }
      b.pos.x = nx; b.pos.y = ny;
      if (b.faceParent) { b.spinAngle = a + Math.PI; continue; }
    }
    b.spinAngle += b.spin * dt;
  }
}

/** Gravity acceleration from one body at a point. Returns 0 outside SOI. */
export function gravityFrom(b: Body, x: number, y: number, out: V2): number {
  if (b.mass <= 0) { out.x = 0; out.y = 0; return 0; }
  const dx = b.pos.x - x, dy = b.pos.y - y;
  const r2 = dx * dx + dy * dy;
  const soi2 = b.soi * b.soi;
  if (r2 >= soi2 && b.farMass <= 0) { out.x = 0; out.y = 0; return 0; }
  const r = Math.sqrt(r2);
  // inside the body (fissures, caves) the pull weakens toward the centre like a uniform sphere
  let a = r < b.radius ? (b.mass / (b.radius * b.radius)) * (r / b.radius) : b.mass / r2;
  // fade to zero over the outer 25% of the SOI so there is no discontinuity
  const fade = r2 >= soi2 ? 0 : 1 - smoothstep(b.soi * 0.75, b.soi, r);
  a *= fade;
  // the star's far field: weak, unfaded, and what every planet's rail obeys, so free things keep station with them
  if (b.farMass > 0) a += b.farMass / r2;
  const inv = r > 1e-6 ? 1 / r : 0;
  out.x = dx * inv * a;
  out.y = dy * inv * a;
  return a;
}

export function makeBodyRng(seed: number, salt: number): Rng { return new Rng((seed ^ (salt * 2654435761)) >>> 0); }
