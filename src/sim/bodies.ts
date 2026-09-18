// Celestial bodies: star, planets, moons. Terrain is an equatorial radius profile that doubles
// as the collision surface. Gravity is 1/r^2 clamped, faded to zero at the sphere of influence.
import { clamp, fbm3, lerp, Rng, smoothstep, TAU, type V2 } from '../engine/math';

export type BodyKind = 'star' | 'planet' | 'moon' | 'gas';
export type PlanetType = 'rock' | 'ice' | 'volcanic' | 'desert' | 'gas' | 'star' | 'crystal';

export type PadKind = 'colony' | 'mine' | 'derelict' | 'enemybase' | 'outpost' | 'core';

export interface Pad {
  id: number;
  body: Body;
  kind: PadKind;
  name: string;
  angle: number;       // centre angle on the equator (sim plane)
  segIndex: number;    // terrain segment index the pad occupies
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
  spin: number;        // visual spin only (gas giants)
  spinAngle: number;
  maxRadius: number;   // cached max terrain radius
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
}

export function createBody(spec: BodySpec): Body {
  const segments = spec.kind === 'star' ? 48 : spec.kind === 'gas' ? 64 : clamp(Math.round(spec.radius / 1.55), 36, 128);
  const b: Body = {
    id: nextBodyId++,
    name: spec.name,
    kind: spec.kind,
    type: spec.type,
    pos: { x: 0, y: 0 },
    vel: { x: 0, y: 0 },
    radius: spec.radius,
    mass: spec.surfaceG * spec.radius * spec.radius,
    soi: spec.radius * (spec.soiMul ?? (spec.kind === 'moon' ? 4.5 : 7)),
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
    spin: spec.kind === 'gas' ? 0.03 : spec.kind === 'star' ? 0.01 : 0,
    spinAngle: 0,
    maxRadius: spec.radius,
  };
  for (let i = 0; i < segments; i++) b.terrain[i] = surfaceRadiusRaw(b, (i / segments) * TAU, 0);
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
  // snap pad centre to the middle of the nearest terrain segment so the pad is one flat chord
  const idx = Math.floor(((angle / TAU) * seg + 1e-6 + seg) % seg);
  const centre = ((idx + 0.5) / seg) * TAU;
  const i0 = idx, i1 = (idx + 1) % seg;
  // pad height: average of the two endpoints but not lower than 0.9R
  const h = Math.max(b.radius * 0.9, (b.terrain[i0] + b.terrain[i1]) * 0.5);
  const pad: Pad = {
    id: nextPadId++, body: b, kind, name, angle: centre, segIndex: idx, height: h, halfWidth,
    alive: true, population: 0, stock: 0, fuel: false, repair: false, visited: false, lastRaid: -1e9,
    enemyHealth: 0, spawnTimer: 0, discovered: false, integrity: 100,
  };
  b.pads.push(pad);
  b.terrain[i0] = h;
  b.terrain[i1] = h;
  // keep the neighbours approachable: no cliff taller than 8% of R right beside the pad
  const maxN = h + b.radius * 0.08;
  const im = (i0 - 1 + seg) % seg, ip = (i1 + 1) % seg;
  if (b.terrain[im] > maxN) b.terrain[im] = maxN;
  if (b.terrain[ip] > maxN) b.terrain[ip] = maxN;
  recomputeMaxRadius(b);
  return pad;
}

/** Surface radius at an arbitrary angle by linear interpolation of the terrain polygon (chord). */
export function terrainRadiusAt(b: Body, angle: number): number {
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

/** Outward surface normal (sim plane) of the terrain segment under the given angle. */
export function terrainNormalAt(b: Body, angle: number): V2 {
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
  return { x: dy / l, y: -dx / l };
}

/** Segment index under an angle. */
export function terrainSegmentAt(b: Body, angle: number): number {
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
    if (b.orbit) {
      const a = b.orbit.phase + b.orbit.angularSpeed * time;
      const nx = b.orbit.parent.pos.x + Math.cos(a) * b.orbit.radius;
      const ny = b.orbit.parent.pos.y + Math.sin(a) * b.orbit.radius;
      if (dt > 0) { b.vel.x = (nx - b.pos.x) / dt; b.vel.y = (ny - b.pos.y) / dt; }
      b.pos.x = nx; b.pos.y = ny;
    }
    b.spinAngle += b.spin * dt;
  }
}

/** Gravity acceleration from one body at a point. Returns 0 outside SOI. */
export function gravityFrom(b: Body, x: number, y: number, out: V2): number {
  const dx = b.pos.x - x, dy = b.pos.y - y;
  const r2 = dx * dx + dy * dy;
  const soi2 = b.soi * b.soi;
  if (r2 >= soi2) { out.x = 0; out.y = 0; return 0; }
  const r = Math.sqrt(r2);
  const rc = Math.max(r, b.radius * 0.6);
  let a = b.mass / (rc * rc);
  // fade to zero over the outer 25% of the SOI so there is no discontinuity
  const fade = 1 - smoothstep(b.soi * 0.75, b.soi, r);
  a *= fade;
  const inv = r > 1e-6 ? 1 / r : 0;
  out.x = dx * inv * a;
  out.y = dy * inv * a;
  return a;
}

export function makeBodyRng(seed: number, salt: number): Rng { return new Rng((seed ^ (salt * 2654435761)) >>> 0); }
