// Planetary geography: a world's equatorial profile cut as an arcade level, and passages under it.
// Terrain motifs (valleys, ridges, craters, canyons, shelves, excavations, fissures, shafts, tunnels,
// overhangs) are laid along the circumference from a per-world catalogue; each motif offers sockets
// that authored and generated content fill (a colony wants a crater floor, a mine wants a canyon, a
// mast wants a crest). Caves are grown from mouths by a small grammar: an entry, chambers, junctions,
// branches, and sometimes a second way out. Nothing here is a quest: it is a place with things in it.
import { angleDiff, clamp, TAU, type Rng, type V2 } from '../engine/math';
import { addInteriorPad, addPad, makeBodyRng, padCoversSegment, recomputeMaxRadius, surfaceVelocity, terrainRadiusAt, type Body, type Pad } from '../sim/bodies';
import { equipInteriorBase } from '../sim/installations';
import { createAsteroid, spawnPickup } from '../sim/physics';
import { addPowerSource, spawnCore } from '../sim/power';
import { addStructure, addStructureAt } from '../sim/structures';
import { bodyToWorld, circleVsWalls, edgeOpen, fissureFromPolyline, markOpenings, notchTerrain, outlineSimple, pointInPolygon, worldToBody, type Fissure } from '../sim/walls';
import type { Asteroid, Pickup, World } from '../sim/world';
import type { Namer } from './names';

export type WorldRole = 'home' | 'inner' | 'mid' | 'gas' | 'enemy';
export type MotifKind = 'valley' | 'ridge' | 'crater' | 'canyon' | 'shelf' | 'excavation' | 'fissure' | 'shaft' | 'tunnel' | 'overhang';
export type SocketKind = 'colony' | 'settlement' | 'depot' | 'mine' | 'works' | 'hiddenpad' | 'wreckfield' | 'installation' | 'machinery' | 'mast' | 'beacon' | 'gun' | 'cavemouth' | 'shaftmouth' | 'tunnel' | 'overhang';

export interface Motif { kind: MotifKind; s0: number; length: number; params: Record<string, number>; }
export interface Socket { kinds: SocketKind[]; angle: number; motif: Motif; used: boolean; to?: number; dir?: number; }
export interface Room { centre: V2; hw: number; fissure: Fissure; depth: number; }
/** A chamber: a blob of void with a flat shelf on its deep side. */
export interface Chamber { id: number; centre: V2; r: number; kind: 'room' | 'hall' | 'cut' | 'shelter'; outline: V2[]; floorA: V2; floorB: V2; floorN: V2; fissure: Fissure | null; depth: number; content: string; }
/** A passage between two chambers. */
export interface Link { a: number; b: number; hw: number; narrow: boolean; fissure: Fissure | null; pts: V2[]; }
export interface Geography {
  body: Body; role: WorldRole; rng: Rng;
  motifs: Motif[]; sockets: Socket[];
  mouths: number[];           // local angles of every cave mouth
  keepOut: { angle: number; hw: number }[]; // surface content a mouth must not open under (structures, wreck fields, recorders)
  networks: Network[];
  placed: string[];           // what the dressing put where (for the harness and the report)
}
export interface Network { name: string; kind: 'complex' | 'shaft' | 'tunnel' | 'shelter'; fissures: Fissure[]; chambers: Chamber[]; links: Link[]; rooms: Room[]; points: { p: V2; hw: number; fissure: Fissure }[]; mouths: number[]; entry: V2[]; blocked: Link[]; }

/** Placed rocks (rubble in chambers, boulders on canyon floors) carry this field id so the belt culls leave them alone. */
export const PLACED_ROCK = 4;

/** The geography of every sculpted body, for the harness and the tests. */
export const GEOGRAPHY = new WeakMap<Body, Geography>();

// ------------------------------------------------------------------ helpers

const rot = (v: V2, a: number): V2 => { const c = Math.cos(a), s = Math.sin(a); return { x: v.x * c - v.y * s, y: v.x * s + v.y * c }; };
const unit = (v: V2): V2 => { const l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; };
const angOf = (v: V2): number => Math.atan2(v.y, v.x);
/** Surface radius under a local angle (the polygon chord, like the collision code). */
function rimAt(b: Body, localAngle: number): number { return terrainRadiusAt(b, localAngle + (b.rotates ? b.spinAngle : 0)); }
function depthOf(b: Body, p: V2): number { return rimAt(b, angOf(p)) - Math.hypot(p.x, p.y); }
/** Depth of a point under the lowest ground across a passage of half width hw centred on it. */
function depthAcross(b: Body, p: V2, hw: number): number {
  const r = Math.hypot(p.x, p.y) || 1, a = angOf(p);
  let rim = Infinity;
  for (let k = -2; k <= 2; k++) rim = Math.min(rim, rimAt(b, a + (k / 2) * (hw + 1.5) / r));
  return rim - r;
}
function arcTo(b: Body, a: number, c: number, r = b.radius): number { return Math.abs(angleDiff(a, c)) * r; }

// ------------------------------------------------------------------ 1. the profile

interface Weighted { kind: MotifKind; w: number; max: number }
const CATALOGUE: Record<WorldRole, Weighted[]> = {
  home: [
    { kind: 'valley', w: 3, max: 3 }, { kind: 'ridge', w: 3, max: 4 }, { kind: 'crater', w: 2.5, max: 3 }, { kind: 'canyon', w: 2, max: 2 },
    { kind: 'shelf', w: 3, max: 3 }, { kind: 'excavation', w: 2.5, max: 2 }, { kind: 'fissure', w: 2, max: 2 }, { kind: 'shaft', w: 1.5, max: 2 },
    { kind: 'tunnel', w: 1.5, max: 1 }, { kind: 'overhang', w: 1, max: 1 },
  ],
  inner: [
    { kind: 'valley', w: 1.5, max: 2 }, { kind: 'ridge', w: 3, max: 4 }, { kind: 'crater', w: 3, max: 3 }, { kind: 'canyon', w: 2.5, max: 2 },
    { kind: 'shelf', w: 1.5, max: 2 }, { kind: 'excavation', w: 1, max: 1 }, { kind: 'fissure', w: 2.5, max: 2 }, { kind: 'shaft', w: 1, max: 1 },
    { kind: 'tunnel', w: 1.5, max: 1 }, { kind: 'overhang', w: 2.5, max: 2 },
  ],
  mid: [
    { kind: 'valley', w: 2, max: 2 }, { kind: 'ridge', w: 3, max: 4 }, { kind: 'crater', w: 3, max: 3 }, { kind: 'canyon', w: 2, max: 2 },
    { kind: 'shelf', w: 2, max: 2 }, { kind: 'excavation', w: 1, max: 1 }, { kind: 'fissure', w: 1.5, max: 2 }, { kind: 'shaft', w: 1, max: 1 },
    { kind: 'tunnel', w: 1, max: 1 }, { kind: 'overhang', w: 1, max: 1 },
  ],
  gas: [],
  enemy: [
    { kind: 'valley', w: 1, max: 1 }, { kind: 'ridge', w: 3, max: 4 }, { kind: 'crater', w: 2, max: 2 }, { kind: 'canyon', w: 2, max: 2 },
    { kind: 'shelf', w: 1, max: 1 }, { kind: 'excavation', w: 3, max: 3 }, { kind: 'fissure', w: 2, max: 2 }, { kind: 'shaft', w: 2, max: 2 },
    { kind: 'tunnel', w: 1, max: 1 }, { kind: 'overhang', w: 0.5, max: 1 },
  ],
};

function motifLength(kind: MotifKind, rng: Rng): number {
  switch (kind) {
    case 'valley': return 36 + rng.next() * 34;
    case 'ridge': return 16 + rng.next() * 14;
    case 'crater': return 28 + rng.next() * 16;
    case 'canyon': return 12 + rng.next() * 8;
    case 'shelf': return 22 + rng.next() * 18;
    case 'excavation': return 22 + rng.next() * 8;
    case 'fissure': return 16 + rng.next() * 4;
    case 'shaft': return 13;
    case 'tunnel': return 42 + rng.next() * 26;
    case 'overhang': return 18 + rng.next() * 6;
  }
}

/** Offset (units, + up) and flatness (0..1) of a motif at u units into it. */
function shape(m: Motif, u: number): { off: number; flat: number } {
  const L = m.length, P = m.params;
  const ramp = (x: number, w: number): number => clamp(x / w, 0, 1);
  switch (m.kind) {
    case 'valley': {
      const off = -P.depth * (0.5 - 0.5 * Math.cos(TAU * u / L));
      const flat = clamp(1 - Math.abs(u - L / 2) / (L * 0.28), 0, 1);
      return { off, flat };
    }
    case 'ridge': {
      const pL = P.peak * L;
      const x = u < pL ? u / pL : (L - u) / (L - pL);
      return { off: P.height * Math.pow(clamp(x, 0, 1), P.sharp), flat: 0 };
    }
    case 'crater': {
      const wr = P.rim;
      const d = Math.min(u, L - u);
      if (d < wr) return { off: P.height * Math.sin(Math.PI * d / wr) * (d < wr * 0.5 ? 1 : 1) - P.depth * ramp(d - wr * 0.75, wr * 0.25), flat: ramp(d - wr * 0.75, wr * 0.25) };
      return { off: -P.depth, flat: 1 };
    }
    case 'canyon': {
      const d = Math.min(u, L - u);
      const t = ramp(d, 2.2);
      return { off: -P.depth * t, flat: t };
    }
    case 'shelf': {
      const v = P.side > 0 ? u : L - u;   // the step is at the start when side > 0
      if (v < 3) return { off: P.height * ramp(v, 3), flat: ramp(v, 3) };
      if (v > L - 7) return { off: P.height * ramp(L - v, 7), flat: ramp(L - v, 7) };
      return { off: P.height, flat: 1 };
    }
    case 'excavation': {
      const d = Math.min(u, L - u);
      const t = ramp(d, 1.8);
      let depth = P.depth;
      if (P.stepped > 0 && u < L * 0.42) depth = P.depth * 0.5;
      else if (P.stepped > 0 && u < L * 0.42 + 1.8) depth = P.depth * 0.5 + P.depth * 0.5 * ramp(u - L * 0.42, 1.8);
      return { off: -depth * t, flat: t };
    }
    case 'fissure': { const d = Math.min(u, L - u); return { off: -2.6 * ramp(d, 1.5), flat: ramp(d, 1.5) }; }
    case 'shaft': { const d = Math.min(u, L - u); return { off: -1.8 * ramp(d, 1.5), flat: ramp(d, 1.5) }; }
    case 'tunnel': {
      const d = Math.min(u, L - u);
      if (d < 7) return { off: -2.6 * ramp(d, 1.2), flat: 1 };
      const x = (u - 10) / (L - 20);
      if (x <= 0 || x >= 1) return { off: 0, flat: 0.5 };
      return { off: P.height * Math.pow(Math.sin(Math.PI * x), 1.3), flat: 0 };
    }
    case 'overhang': {
      const v = P.dir > 0 ? u : L - u;   // the mouth is at the start when dir > 0
      if (v < 7) return { off: -2.6 * ramp(v, 1.2), flat: 1 };
      return { off: 1 * ramp(v - 7, 2), flat: 1 };
    }
  }
}

/** Cut the equatorial profile of a world into motifs. Call right after createBody, before any pad. */
export function sculptPlanet(b: Body, role: WorldRole, seed: number): Geography {
  const rng = makeBodyRng(seed, 900 + b.id);
  const R = b.radius, C = TAU * R, seg = b.segments;
  const geo: Geography = { body: b, role, rng, motifs: [], sockets: [], mouths: [], keepOut: [], networks: [], placed: [] };
  const cat = CATALOGUE[role];
  if (!cat.length) return geo;
  const counts = new Map<MotifKind, number>();
  const amp = role === 'inner' ? 1.2 : role === 'enemy' ? 1.15 : 1;
  // lay motifs along the circumference with plain ground between
  let s = rng.next() * C;
  const start = s;
  let laid = 0;
  const maxDepthPad = R * 0.13; // pads must not sit in holes deeper than this
  while (laid < C - 30) {
    const pool = cat.filter(c => (counts.get(c.kind) ?? 0) < c.max);
    let total = 0; for (const c of pool) total += c.w;
    let r = rng.next() * total, kind: MotifKind = pool[0].kind;
    for (const c of pool) { r -= c.w; if (r <= 0) { kind = c.kind; break; } }
    const L = motifLength(kind, rng);
    if (L > C - 30 - laid) break;
    const params: Record<string, number> = {};
    switch (kind) {
      case 'valley': params.depth = (4 + rng.next() * 4) * amp; break;
      case 'ridge': params.height = (7 + rng.next() * 6) * amp; params.peak = 0.3 + rng.next() * 0.4; params.sharp = 1.2 + rng.next(); break;
      case 'crater': params.depth = Math.min(maxDepthPad * 0.6, 3 + rng.next() * 2.5); params.height = (4 + rng.next() * 3) * amp; params.rim = Math.min(9, L * 0.24); break;
      case 'canyon': params.depth = Math.min(maxDepthPad, (9 + rng.next() * 5) * amp); params.cave = rng.chance(0.4) ? 1 : 0; break;
      case 'shelf': params.height = (3 + rng.next() * 3) * amp; params.side = rng.sign(); break;
      case 'excavation': params.depth = Math.min(maxDepthPad, 5 + rng.next() * 3); params.stepped = rng.chance(0.5) ? 1 : 0; break;
      case 'tunnel': params.height = (6 + rng.next() * 4) * amp; break;
      case 'overhang': params.dir = rng.sign(); break;
    }
    const m: Motif = { kind, s0: s % C, length: L, params };
    geo.motifs.push(m);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const gap = 5 + rng.next() * 10;
    s += L + gap; laid += L + gap;
  }
  void start;
  // apply: base roughness softened, motif offsets added, floors flattened
  const off = new Float64Array(seg), flat = new Float64Array(seg);
  for (const m of geo.motifs) {
    for (let i = 0; i < seg; i++) {
      const si = (i / seg) * C;
      let u = si - m.s0; u = ((u % C) + C) % C;
      if (u >= m.length) continue;
      const sh = shape(m, u);
      off[i] += sh.off; flat[i] = Math.max(flat[i], sh.flat);
    }
  }
  for (let i = 0; i < seg; i++) {
    const base = R + (b.terrain[i] - R) * 0.55 * (1 - flat[i]);
    let r = base + off[i];
    // ridges and plains keep a little grit
    if (flat[i] < 0.5) r += (rng.next() - 0.5) * 0.9 * (1 - flat[i]);
    b.terrain[i] = clamp(r, R * 0.72, R * 1.28);
  }
  recomputeMaxRadius(b);
  // sockets
  const socket = (m: Motif, u: number, kinds: SocketKind[], extra: Partial<Socket> = {}): Socket => {
    const sk: Socket = { kinds, angle: ((m.s0 + u) % C) / R, motif: m, used: false, ...extra };
    geo.sockets.push(sk);
    return sk;
  };
  for (const m of geo.motifs) {
    const L = m.length;
    switch (m.kind) {
      case 'valley': socket(m, L / 2, role === 'inner' ? ['colony', 'wreckfield', 'depot'] : role === 'home' ? ['settlement', 'colony', 'depot', 'wreckfield'] : ['colony', 'wreckfield', 'gun']); break;
      case 'ridge': socket(m, m.params.peak * L, role === 'home' || role === 'inner' ? ['mast', 'beacon'] : ['gun', 'mast']); break;
      case 'crater': socket(m, L / 2, role === 'inner' ? ['colony', 'installation', 'wreckfield'] : role === 'home' ? ['colony', 'wreckfield', 'installation', 'settlement'] : ['colony', 'gun', 'wreckfield']); break;
      case 'canyon': if (m.params.cave) socket(m, L / 2, ['cavemouth']); else socket(m, L / 2, ['mine', 'hiddenpad', 'works']); break;
      case 'shelf': socket(m, L / 2, role === 'inner' ? ['depot', 'machinery'] : ['settlement', 'depot', 'machinery']); break;
      case 'excavation': socket(m, L * 0.24, ['machinery']); socket(m, L * 0.74, ['works', 'mine']); break;
      case 'fissure': socket(m, L / 2, ['cavemouth']); break;
      case 'shaft': socket(m, L / 2, ['shaftmouth']); break;
      case 'tunnel': socket(m, 3.5, ['tunnel'], { to: ((m.s0 + L - 3.5) % C) / R }); break;
      case 'overhang': socket(m, m.params.dir > 0 ? 3.5 : L - 3.5, ['overhang'], { dir: m.params.dir }); break;
    }
  }
  return geo;
}

/** Take the first free socket offering one of the wanted kinds (in order of preference), or null. */
export function takeSocket(geo: Geography, wanted: SocketKind[]): Socket | null {
  for (const k of wanted) for (const s of geo.sockets) if (!s.used && s.kinds.includes(k)) { s.used = true; return s; }
  return null;
}

/** A pad angle: a fitting socket, else the clearest stretch of plain ground. */
export function padAngleFor(geo: Geography, wanted: SocketKind[], halfWidth: number): number {
  const sk = takeSocket(geo, wanted);
  if (sk) return sk.angle;
  const b = geo.body;
  let best = 0, bestScore = -1;
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * TAU;
    let score = Math.PI * b.radius;
    for (const p of b.pads) score = Math.min(score, arcTo(b, p.angle, a));
    for (const s of geo.sockets) if (!s.used) score = Math.min(score, arcTo(b, s.angle, a));
    // prefer flat, low ground
    const r = rimAt(b, a);
    score -= Math.abs(r - b.radius) * 2 + halfWidth;
    if (score > bestScore) { bestScore = score; best = a; }
  }
  return best;
}

// ------------------------------------------------------------------ 2. the underground: chambers, links, ways in and out

interface Ctx { w: World; geo: Geography; b: Body; rng: Rng; floorY: number; }

/** Dimensions from the ship: a reversal from eight units a second costs about ten units of room, a towed rock spans about eleven with the cable. */
const BROAD_HW = [6.5, 9];      // most passages: room to turn, brake, tow and fight
const NARROW_HW = [3.3, 4.2];   // the exception: a squeeze a Kestrel fits through, a boulder does not
const ROOM_R = [11, 16];
const HALL_R = [17, 26];
const ROOF = 6;                 // rock kept above any void

function mouthClear(ctx: Ctx, angle: number, hw: number): boolean {
  const b = ctx.b;
  for (const p of b.pads) if (!p.interior && arcTo(b, p.angle, angle) < p.halfWidth + hw + 6) return false;
  for (const m of ctx.geo.mouths) if (arcTo(b, m, angle) < hw * 2 + 9) return false;
  for (const k of ctx.geo.keepOut) if (arcTo(b, k.angle, angle) < k.hw + hw + 4) return false;
  // no notch over a shallow chamber or passage that is already there
  for (const net of ctx.geo.networks) {
    for (const ch of net.chambers) if (ch.depth - ch.r < 14 && arcTo(b, angOf(ch.centre), angle, Math.hypot(ch.centre.x, ch.centre.y)) < hw + ch.r + 6) return false;
    for (const pt of net.points) if (depthOf(b, pt.p) < 13 && arcTo(b, angOf(pt.p), angle, Math.hypot(pt.p.x, pt.p.y)) < hw + pt.hw + 6) return false;
  }
  return true;
}

/** A centreline point is sound when it is well under the ground, not too deep, and not under a pad. */
function pointOk(ctx: Ctx, q: V2, hw: number, margin = ROOF): boolean {
  const b = ctx.b;
  const r = Math.hypot(q.x, q.y);
  if (r < b.radius * 0.3) return false;
  const d = depthAcross(b, q, hw);
  if (d < hw + margin) return false;
  if (d - hw < 12) for (const p of b.pads) if (!p.interior && arcTo(b, p.angle, angOf(q), r) < p.halfWidth + hw + 4) return false;
  return true;
}

/** Room for a chamber disc: roof above it, floor of the world below it, no pad over it, no other network against it. */
function chamberOk(ctx: Ctx, net: Network, c: V2, r: number): boolean {
  const b = ctx.b;
  const rc = Math.hypot(c.x, c.y);
  if (rc - r < b.radius * 0.3) return false;
  // the roof across the chamber's whole span
  const a = angOf(c);
  let rim = Infinity;
  for (let k = -3; k <= 3; k++) rim = Math.min(rim, rimAt(b, a + (k / 3) * (r + 2) / rc));
  if (rim - (rc + r) < ROOF) return false;
  if (rim - (rc + r) < 9) for (const p of b.pads) if (!p.interior && arcTo(b, p.angle, a, rc + r) < p.halfWidth + r + 2) return false;
  for (const other of ctx.geo.networks) {
    for (const ch of other.chambers) if (Math.hypot(ch.centre.x - c.x, ch.centre.y - c.y) < ch.r + r + 9) return false;
    for (const pt of other.points) if (Math.hypot(pt.p.x - c.x, pt.p.y - c.y) < pt.hw + r + 9) return false;
  }
  for (const ch of net.chambers) if (Math.hypot(ch.centre.x - c.x, ch.centre.y - c.y) < ch.r + r + 5) return false;
  for (const pt of net.points) if (Math.hypot(pt.p.x - c.x, pt.p.y - c.y) < pt.hw + r + 4) return false;
  return true;
}

/** A chamber outline: a rough blob whose deep side is cut flat, so every chamber has a shelf to land on. Squat chambers are cut long and low like a worked bench. */
function chamberOutline(c: V2, r: number, rng: Rng, floorFrac: number, squat: boolean): { outline: V2[]; floorA: V2; floorB: V2; floorN: V2 } {
  const n = Math.max(14, Math.round(r * 1.3));
  const na = 5 + rng.int(3);
  const amps: number[] = [];
  for (let k = 0; k < na; k++) amps.push(0.8 + rng.next() * 0.32);
  const radiusAt = (t: number): number => {
    const u = (t / TAU) * na;
    const i0 = Math.floor(u) % na, i1 = (i0 + 1) % na, f = u - Math.floor(u);
    const s = 0.5 - 0.5 * Math.cos(f * Math.PI);
    return r * (amps[i0] * (1 - s) + amps[i1] * s);
  };
  const inward = unit({ x: -c.x, y: -c.y });
  const along = { x: -inward.y, y: inward.x };
  const floorDist = r * floorFrac;
  const raw: V2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU;
    let dx = Math.cos(t) * radiusAt(t), dy = Math.sin(t) * radiusAt(t);
    if (squat) {
      // stretch along the ground, flatten toward it
      const u = dx * along.x + dy * along.y, v = dx * inward.x + dy * inward.y;
      const u2 = u * 1.45, v2 = v * 0.72;
      dx = along.x * u2 + inward.x * v2; dy = along.y * u2 + inward.y * v2;
    }
    const proj = dx * inward.x + dy * inward.y;
    if (proj > floorDist) { dx -= inward.x * (proj - floorDist); dy -= inward.y * (proj - floorDist); }
    raw.push({ x: c.x + dx, y: c.y + dy });
  }
  let area = 0;
  for (let i = 0; i < n; i++) { const a = raw[i], d = raw[(i + 1) % n]; area += a.x * d.y - d.x * a.y; }
  const outline = area < 0 ? raw.reverse() : raw;
  // the shelf: the extreme points of the flat run
  let lo = Infinity, hi = -Infinity, A = outline[0], B = outline[0];
  for (const v of outline) {
    const proj = (v.x - c.x) * inward.x + (v.y - c.y) * inward.y;
    if (proj < floorDist - 0.05) continue;
    const u = (v.x - c.x) * along.x + (v.y - c.y) * along.y;
    if (u < lo) { lo = u; A = v; }
    if (u > hi) { hi = u; B = v; }
  }
  return { outline, floorA: A, floorB: B, floorN: { x: -inward.x, y: -inward.y } };
}

function addPolygon(ctx: Ctx, net: Network, name: string, outline: V2[]): Fissure | null {
  if (!outlineSimple(outline)) return null;
  const f: Fissure = { name, body: ctx.b, outline, floorY: ctx.floorY, flashUntil: -1e9, fragile: false, openEdge: -1, open: [], depth: [] };
  ctx.b.fissures.push(f);
  net.fissures.push(f);
  return f;
}

function addPassage(ctx: Ctx, net: Network, name: string, pts: V2[], hws: number[], openStart: boolean, openEnd: boolean): Fissure | null {
  const f = fissureFromPolyline(ctx.b, name, pts, hws, ctx.floorY, false, openStart, openEnd);
  if (f) net.fissures.push(f);
  return f;
}

let chamberIds = 0;
function addChamber(ctx: Ctx, net: Network, c: V2, r: number, kind: Chamber['kind']): Chamber | null {
  const { rng } = ctx;
  let floorFrac = kind === 'cut' ? 0.42 : 0.42 + rng.next() * 0.16;
  let shape = chamberOutline(c, r, rng, floorFrac, kind === 'cut');
  for (let t = 0; t < 3 && Math.hypot(shape.floorB.x - shape.floorA.x, shape.floorB.y - shape.floorA.y) < Math.max(8, r * 0.9); t++) { floorFrac -= 0.1; shape = chamberOutline(c, r, rng, floorFrac, kind === 'cut'); }
  const f = addPolygon(ctx, net, `${net.name} ${kind === 'hall' ? 'HALL' : kind === 'cut' ? 'BENCH' : 'ROOM'} ${net.chambers.length + 1}`, shape.outline);
  if (!f) return null;
  const ch: Chamber = { id: chamberIds++, centre: c, r, kind, outline: shape.outline, floorA: shape.floorA, floorB: shape.floorB, floorN: shape.floorN, fissure: f, depth: depthOf(ctx.b, c), content: '' };
  net.chambers.push(ch);
  net.rooms.push({ centre: c, hw: r, fissure: f, depth: ch.depth });
  return ch;
}

/** A passage between two chambers, sometimes with one bend; broad by default, narrow as a deliberate squeeze. */
function linkChambers(ctx: Ctx, net: Network, a: Chamber, b: Chamber, narrow: boolean): Link | null {
  const { rng } = ctx;
  const hw = narrow ? NARROW_HW[0] + rng.next() * (NARROW_HW[1] - NARROW_HW[0]) : BROAD_HW[0] + rng.next() * (BROAD_HW[1] - BROAD_HW[0]);
  const pts: V2[] = [a.centre];
  const dx = b.centre.x - a.centre.x, dy = b.centre.y - a.centre.y;
  const len = Math.hypot(dx, dy) || 1;
  if (rng.chance(0.5) && len > a.r + b.r + 14) {
    const off = (rng.next() - 0.5) * 0.5 * len;
    const mid = { x: (a.centre.x + b.centre.x) / 2 - dy / len * off, y: (a.centre.y + b.centre.y) / 2 + dx / len * off };
    if (pointOk(ctx, mid, hw)) pts.push(mid);
  }
  pts.push(b.centre);
  // the straight stretches between the chambers must stay under the ground
  for (let i = 0; i + 1 < pts.length; i++) {
    for (let t = 0.2; t < 1; t += 0.2) {
      const q = { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t };
      if (Math.hypot(q.x - a.centre.x, q.y - a.centre.y) < a.r || Math.hypot(q.x - b.centre.x, q.y - b.centre.y) < b.r) continue;
      if (!pointOk(ctx, q, hw)) return null;
    }
  }
  const hws = pts.map(() => hw);
  const f = addPassage(ctx, net, `${net.name} ${narrow ? 'SQUEEZE' : 'WAY'} ${net.links.length + 1}`, pts, hws, false, false);
  if (!f) return null;
  const link: Link = { a: a.id, b: b.id, hw, narrow, fissure: f, pts };
  net.links.push(link);
  for (const p of pts) net.points.push({ p, hw, fissure: f });
  return link;
}

/** Straight up from a chamber to the ground at a given angle: a second way in, if the ground there is clear. */
function rimAcross(b: Body, angle: number, half: number): number {
  let rim = 0;
  for (let k = -3; k <= 3; k++) rim = Math.max(rim, rimAt(b, angle + (k / 3) * half / b.radius));
  return rim;
}

function exitFrom(ctx: Ctx, net: Network, ch: Chamber, angle: number, hw: number): boolean {
  const b = ctx.b;
  if (!mouthClear(ctx, angle, hw + 1)) return false;
  const rim = rimAcross(b, angle, hw + 3);
  const u = { x: Math.cos(angle), y: Math.sin(angle) };
  const throat = { x: u.x * (rim - hw - 3), y: u.y * (rim - hw - 3) };
  const len = Math.hypot(throat.x - ch.centre.x, throat.y - ch.centre.y);
  if (len > ch.r + 34) return false;
  for (let t = 0.15; t < 0.8; t += 0.16) {
    const q = { x: ch.centre.x + (throat.x - ch.centre.x) * t, y: ch.centre.y + (throat.y - ch.centre.y) * t };
    if (Math.hypot(q.x - ch.centre.x, q.y - ch.centre.y) < ch.r) continue;
    if (!pointOk(ctx, q, hw, 3.5)) return false;
  }
  const pts = [ch.centre, throat, { x: u.x * rim, y: u.y * rim }, { x: u.x * (rim + 6), y: u.y * (rim + 6) }];
  const hws = [hw, hw, hw + 1, hw + 2.5];
  const f = addPassage(ctx, net, `${net.name} WAY OUT`, pts, hws, false, true);
  if (!f) return false;
  net.points.push({ p: throat, hw, fissure: f });
  net.mouths.push(angle);
  ctx.geo.mouths.push(angle);
  notchTerrain(b, angle, hw + 4, 2.6);
  return true;
}

/** The way in: from a mouth on the rim down a throat to the first chamber. */
function entryFrom(ctx: Ctx, net: Network, mouth: number, hw: number, first: Chamber): Fissure | null {
  const b = ctx.b;
  const rim = rimAcross(b, mouth, hw + 3);
  const u = { x: Math.cos(mouth), y: Math.sin(mouth) };
  const pts = [{ x: u.x * (rim + 6), y: u.y * (rim + 6) }, { x: u.x * rim, y: u.y * rim }, { x: u.x * (rim - hw - 3), y: u.y * (rim - hw - 3) }, first.centre];
  const hws = [hw + 2.5, hw + 1, hw, hw];
  const f = addPassage(ctx, net, `${net.name} WAY IN`, pts, hws, true, false);
  if (!f) return null;
  net.entry = pts.slice(0, 3);
  net.points.push({ p: pts[2], hw, fissure: f });
  return f;
}

function newNetwork(name: string, kind: Network['kind'], mouth: number): Network {
  return { name, kind, fissures: [], chambers: [], links: [], mouths: [mouth], entry: [], points: [], rooms: [], blocked: [] };
}

/** A complex: an entry chamber, then rooms and halls grown sideways and down, a spanning tree of links, a loop or two, and a second way out when the ground allows. */
function growComplex(ctx: Ctx, mouth: number, name: string, budget: number, kind: 'complex' | 'tunnel' | 'shelter', exitTo?: number): Network | null {
  const { b, rng } = ctx;
  const net = newNetwork(name, kind, mouth);
  const R = b.radius;
  const rMax = Math.max(9, Math.min(HALL_R[1], 0.35 * R - 4));
  const hwIn = kind === 'shelter' ? 5.5 + rng.next() : 6.5 + rng.next() * 1.5;
  const rim = rimAcross(b, mouth, hwIn + 3);
  const u = { x: Math.cos(mouth), y: Math.sin(mouth) };
  // the first chamber sits under the throat
  let first: Chamber | null = null;
  const r0max = kind === 'shelter' ? 11 : Math.min(ROOM_R[1], rMax);
  const side0 = { x: -u.y, y: u.x };
  for (const extra of kind === 'shelter' ? [2, 6] : [2, 6, 12, 18]) for (const lat of [0, 6, -6]) for (let r = r0max; r >= 8 && !first; r -= 1) {
    const d = rim - hwIn - 4 - r - extra;
    const c = { x: u.x * d + side0.x * lat, y: u.y * d + side0.y * lat };
    if (chamberOk(ctx, net, c, r)) first = addChamber(ctx, net, c, r, kind === 'shelter' ? 'shelter' : 'room');
  }
  if (!first) { ctx.geo.placed.push(`(${name}: no room for a first chamber)`); return null; }
  if (!entryFrom(ctx, net, mouth, hwIn, first)) { ctx.geo.placed.push(`(${name}: no way in)`); return null; }
  // growth
  let tries = 0;
  const exitDir = exitTo !== undefined ? { x: Math.cos(exitTo), y: Math.sin(exitTo) } : null;
  while (net.chambers.length < budget && tries++ < 140) {
    const parent = rng.chance(0.55) ? net.chambers[net.chambers.length - 1] : rng.pick(net.chambers);
    const hall = kind === 'complex' && rng.chance(ctx.geo.role === 'inner' ? 0.25 : 0.35);
    let r = hall ? HALL_R[0] + rng.next() * (HALL_R[1] - HALL_R[0]) : ROOM_R[0] + rng.next() * (ROOM_R[1] - ROOM_R[0]);
    r = Math.min(r, rMax);
    const inward = unit({ x: -parent.centre.x, y: -parent.centre.y });
    let dir: V2;
    if (exitDir) {
      // a tunnel works its way toward its far mouth
      const toward = unit({ x: exitDir.x * (rim - 20) - parent.centre.x, y: exitDir.y * (rim - 20) - parent.centre.y });
      dir = rot(toward, (rng.next() - 0.5) * 0.8);
    } else {
      const side = tries % 2 === 0 ? 1 : -1;
      dir = rot(inward, side * (0.5 + rng.next() * 1.1));
      if (parent.depth - parent.r > 0.32 * R) dir = rot(inward, side * (1.2 + rng.next() * 0.9)); // deep already: go sideways or up
    }
    const gap = 7 + rng.next() * 13;
    const c = { x: parent.centre.x + dir.x * (parent.r + r + gap), y: parent.centre.y + dir.y * (parent.r + r + gap) };
    if (!chamberOk(ctx, net, c, r)) { if (hall && chamberOk(ctx, net, c, r * 0.7)) r *= 0.7; else continue; }
    // a squeeze never comes first, never twice off one chamber, and never outnumbers the broad ways
    const narrow = rng.chance(0.25) && gap < 17 && net.links.length >= 1 && !net.links.some(l => l.narrow && (l.a === parent.id || l.b === parent.id)) && (net.links.filter(l => l.narrow).length + 1) * 2 <= net.links.length + 1;
    const before = b.fissures.length;
    const ch = addChamber(ctx, net, c, r, hall ? 'hall' : 'room');
    if (!ch) continue;
    const link = linkChambers(ctx, net, parent, ch, narrow);
    if (!link) {
      // no clean passage: drop the chamber again
      net.chambers.pop(); net.rooms.pop(); net.fissures.pop(); b.fissures.length = before;
      continue;
    }
  }
  if (kind !== 'shelter' && net.chambers.length < 2) { net.kind = 'shelter'; ctx.geo.placed.push(`(${name}: only one chamber would fit)`); }
  else if (net.chambers.length < budget) ctx.geo.placed.push(`(${name}: ${net.chambers.length} of ${budget} chambers)`);
  // loops: a second passage between chambers that are close and not yet joined
  let loops = 0;
  const chs = net.chambers;
  for (let i = 0; i < chs.length && loops < 2; i++) for (let j = i + 1; j < chs.length && loops < 2; j++) {
    if (net.links.some(l => (l.a === chs[i].id && l.b === chs[j].id) || (l.a === chs[j].id && l.b === chs[i].id))) continue;
    const d = Math.hypot(chs[i].centre.x - chs[j].centre.x, chs[i].centre.y - chs[j].centre.y) - chs[i].r - chs[j].r;
    if (d < 6 || d > 32) continue;
    // nothing between
    let clear = true;
    for (const o of chs) {
      if (o === chs[i] || o === chs[j]) continue;
      const t = ((o.centre.x - chs[i].centre.x) * (chs[j].centre.x - chs[i].centre.x) + (o.centre.y - chs[i].centre.y) * (chs[j].centre.y - chs[i].centre.y)) / ((chs[j].centre.x - chs[i].centre.x) ** 2 + (chs[j].centre.y - chs[i].centre.y) ** 2 || 1);
      if (t <= 0 || t >= 1) continue;
      const px = chs[i].centre.x + (chs[j].centre.x - chs[i].centre.x) * t, py = chs[i].centre.y + (chs[j].centre.y - chs[i].centre.y) * t;
      if (Math.hypot(px - o.centre.x, py - o.centre.y) < o.r + 4) { clear = false; break; }
    }
    if (!clear || !rng.chance(0.65)) continue;
    const before = b.fissures.length;
    if (linkChambers(ctx, net, chs[i], chs[j], rng.chance(0.3) && (net.links.filter(l => l.narrow).length + 1) * 2 <= net.links.length + 1)) loops++; else b.fissures.length = before;
  }
  // a second way out: for a tunnel at its far mouth, for a complex from its shallowest far chamber when the ground is clear
  if (exitTo !== undefined) {
    const far = chs.slice().sort((p, q) => arcTo(b, angOf(p.centre), exitTo) - arcTo(b, angOf(q.centre), exitTo))[0];
    exitFrom(ctx, net, far, exitTo, 6 + rng.next());
  } else if (kind === 'complex' && chs.length >= 2 && rng.chance(0.8)) {
    const cands = chs.slice().sort((p, q) => (p.depth - p.r) - (q.depth - q.r));
    for (const ch of cands) { if (ch === first) continue; const a0 = angOf(ch.centre); if (exitFrom(ctx, net, ch, a0, 6 + rng.next()) || exitFrom(ctx, net, ch, a0 + 8 / b.radius, 6 + rng.next()) || exitFrom(ctx, net, ch, a0 - 8 / b.radius, 6 + rng.next())) break; }
  }
  return net;
}

/** A shaft: straight down from a small flat to a worked bench, with one or two galleries running off it. */
function growShaft(ctx: Ctx, mouth: number, name: string): Network | null {
  const { b, rng } = ctx;
  const net = newNetwork(name, 'shaft', mouth);
  const R = b.radius;
  const rMax = Math.max(9, Math.min(14, 0.35 * R - 4));
  const hw = 5.5 + rng.next();
  const rim = rimAcross(b, mouth, hw + 3);
  const u = { x: Math.cos(mouth), y: Math.sin(mouth) };
  let bench: Chamber | null = null;
  for (let depth = 26 + rng.next() * 10; depth >= 20 && !bench; depth -= 2) {
    const r = Math.min(rMax, 11 + rng.next() * 3);
    const c = { x: u.x * (rim - depth - r), y: u.y * (rim - depth - r) };
    if (chamberOk(ctx, net, c, r)) bench = addChamber(ctx, net, c, r, 'cut');
  }
  if (!bench) return null;
  // the shaft itself
  const pts = [{ x: u.x * (rim + 6), y: u.y * (rim + 6) }, { x: u.x * rim, y: u.y * rim }, { x: u.x * (rim - hw - 3), y: u.y * (rim - hw - 3) }, bench.centre];
  const hws = [hw + 2.5, hw + 1, hw, hw];
  const f = addPassage(ctx, net, `${name} SHAFT`, pts, hws, true, false);
  if (!f) return null;
  net.entry = pts.slice(0, 3);
  net.points.push({ p: pts[2], hw, fissure: f });
  // galleries
  const sides = rng.chance(0.5) ? [1, -1] : [rng.sign()];
  for (const sd of sides) {
    const along = rot(u, sd * Math.PI / 2);
    for (let t = 0; t < 6; t++) {
      const r = Math.min(rMax, 9 + rng.next() * 5);
      const gap = 8 + rng.next() * 12;
      const down = rng.next() * 10 - 2;
      const c = { x: bench.centre.x + along.x * (bench.r * 1.45 + r + gap) - u.x * down, y: bench.centre.y + along.y * (bench.r * 1.45 + r + gap) - u.y * down };
      if (!chamberOk(ctx, net, c, r)) continue;
      const before = b.fissures.length;
      const g = addChamber(ctx, net, c, r, 'room');
      if (!g) continue;
      if (!linkChambers(ctx, net, bench, g, rng.chance(0.3))) { net.chambers.pop(); net.rooms.pop(); net.fissures.pop(); b.fissures.length = before; continue; }
      break;
    }
  }
  // worked walls shed rubble when shot
  for (const ff of net.fissures) ff.fragile = rng.chance(0.5);
  return net;
}

// ------------------------------------------------------------------ 3. the dressing

const LOG_LINES: Record<string, string[][]> = {
  'home-cave': [
    ['DRIFT LOG, DAY 40. THE SEAM TURNED DOWN AGAIN. WE FOLLOWED IT.', 'THE HOIST CABLE PARTED AT THE SECOND BEND. NOBODY HURT. WE WALK IT NOW.', 'THE ROCK HERE RINGS WHEN YOU HIT IT. THE OLD HANDS SAY THAT MEANS A ROOM BEHIND.'],
    ['SURVEY NOTE. THIS GALLERY WAS CUT BEFORE THE CHARTER. NOBODY KNOWS BY WHOM.', 'THE SIDE PASSAGE COMES OUT ABOVE THE RIDGE. QUICKER THAN THE ROAD WHEN THE DUST IS UP.', 'WE LEFT THE CELLS IN THE DEEP ROOM. COLD KEEPS THEM.'],
    ['FOREMAN\'S LOG. TWO DAYS OF NOTHING, THEN THE WALL WENT SOFT AND WE WERE THROUGH INTO SOMEBODY ELSE\'S WORKINGS.', 'THEIR TOOLS ARE STILL HERE. THEIR NAMES ARE NOT.', 'DO NOT SHOOT IN THE NARROWS. THE ROOF REMEMBERS.'],
  ],
  'home-installation': [
    ['PLANT LOG. THE REGULATOR STILL HOLDS ITS BEAT AFTER ALL THESE YEARS. WE NEVER LEARNED WHAT IT WAS BUILT TO FEED.', 'THE FINS WERE STRIPPED FOR SCRAP LONG AGO. THE HOUSING IS TOO HEAVY TO MOVE.', 'IF THE BEAT EVER STOPS, TELL THE HARBOUR.'],
    ['CARETAKER\'S NOTE. THE OLD PLANT WANTS NOTHING FROM US. IT COUNTS, AND IT KEEPS THE ROOM WARM.', 'A SURVEY CREW OFFERED TO BUY THE CORE. THE COUNCIL SAID NO. I DO NOT KNOW WHY.', 'THE SOCKET FITS THE SAME PATTERN AS THE ONES ON THE BASES. MAKE OF THAT WHAT YOU WILL.'],
  ],
  'home-dead': [
    ['DECOMMISSION NOTE. CORE PULLED AND SOLD. THE HOUSING STAYS. THE GUN STAYS. NEITHER WILL DO ANYTHING WITHOUT A BEAT IN THE SOCKET.', 'IF ANYBODY SEATS ONE, THE GUN WILL NOT KNOW WHOSE SIDE IT IS ON.', 'WE LEFT THE FINS. THEY ARE WORTH NOTHING.'],
  ],
  'home-wreck': [
    ['THE FIELD WAS A CONVOY ONCE. THREE HULLS CAME DOWN TOGETHER IN THE FIRST YEAR OF THE TIDE.', 'WE TAKE WHAT SELLS AND LEAVE THE REST. THE GROUND KEEPS IT.', 'ONE DRIVE SECTION STILL TICKS AT NIGHT.'],
    ['SALVAGE CLAIM, FILED AND IGNORED. THE BIG SECTION IS TOO HEAVY FOR A KESTREL WITHOUT A CABLE.', 'SOMEBODY HAS BEEN HERE BEFORE US. THE GOOD PLATING IS GONE.', 'THE RECORDER IN THE COCKPIT WAS STILL WARM. WE DID NOT LISTEN.'],
  ],
  'home-ridge': [
    ['RELAY LOG. WE LOSE THE HARBOUR EVERY EVENING WHEN THE MAST GOES INTO SHADOW. THE COLONY THINKS IT IS US.', 'THE CREST IS THE ONLY PLACE ON THIS SIDE WITH A CLEAR LINE TO THE MOON.', 'SOMETHING PINGED US FROM ORBIT LAST NIGHT. IT DID NOT ANSWER.'],
  ],
  'home-signal': [
    ['ARRAY LOG. THREE MASTS, NO POWER, AND THE MIDDLE ONE STILL HUMS ON THE PEAK OF EVERY THIRD SECOND.', 'THE SURVEY CALLED IT RESONANCE. THE SURVEY LEFT.', 'WE TIED THE RECORDER TO THE FLOOR SO IT WOULD STOP MOVING.'],
  ],
  'home-gun': [
    ['SENTRY POST, LOWER GALLERY. THE TIDE PUT A GUN DOWN HERE WHILE WE WERE STILL WORKING THE UPPER SEAM.', 'IT SHOOTS AT ANYTHING WARM. WE COME AND GO COLD AND SLOW.', 'ITS FINS ARE ON THE SHELF BESIDE IT. IT CANNOT KEEP FIRING WITHOUT THEM.'],
  ],
  'inner-cave': [
    ['SHADE LOG. AT NOON THE ROCK OUTSIDE IS TOO HOT TO TOUCH THROUGH GLOVES. IN HERE IT IS ALWAYS THE SAME COLD.', 'WE MOVE ONLY IN THE HOURS BEFORE DAWN. THE SHUTTLE\'S GUNS WOULD NOT COOL OTHERWISE.', 'THE CELLS ARE STACKED AT THE BACK. TAKE ONE, LEAVE ONE.'],
    ['SEAM LOG. THE ORE IS GOOD BUT THE HAUL IS A DAYLIGHT RUN AND DAYLIGHT KILLS.', 'WE CUT THE SECOND WAY OUT SO NOBODY IS EVER CAUGHT ON THE SUN SIDE AGAIN.', 'LISTEN FOR THE WALLS TICKING. THAT IS THE DAY COMING.'],
  ],
  'inner-installation': [
    ['SUN WORKS LOG. THE HOUSING STAYS COOL BEHIND THE RIM. THE REGULATOR STILL COUNTS.', 'THE MAST BURNED OUT IN THE FIRST SUMMER. WE NEVER REPLACED IT.', 'IF YOU TAKE THE CORE, TAKE IT AT NIGHT. THE SOCKET BITES WHEN IT IS HOT.'],
  ],
  'inner-dead': [
    ['THE POSITION WAS BUILT FOR THE TIDE AND ABANDONED BY IT. THE SOCKET IS EMPTY. THE GUN IS NOT.', 'A CORE IN THAT SOCKET WOULD WAKE IT. WHO IT WOULD SHOOT AT, WE DID NOT STAY TO LEARN.'],
  ],
  'inner-wreck': [
    ['SHE CAME DOWN AT MIDDAY WITH HER FINS GLOWING. WE COULD NOT REACH HER UNTIL DARK.', 'THE HULL IS STILL WARM AT DAWN. DO NOT TOUCH THE PLATING.', 'HER CELLS WERE FULL. THAT WAS NOT THE PROBLEM.'],
    ['THE CRATER TAKES ONE A YEAR. THE PILOTS ALL SAY THE SAME THING: THE GUNS WENT QUIET AND THEN THE SHIP DID.', 'NOTHING HERE IS WORTH THE NOON. COME BACK WHEN THE SHADOW IS ON IT.', 'WE LEFT A CELL IN THE OVERHANG FOR WHOEVER IS NEXT.'],
  ],
  'inner-ridge': [
    ['WATCH LOG. FROM THE CREST YOU CAN SEE THE TERMINATOR COMING LIKE A TIDE ON A BEACH.', 'THE MAST GETS ONE HOUR OF SHADE. WE SEND EVERYTHING THEN.', 'ANYTHING THAT CROSSES THE SUN SIDE LEAVES A TRAIL. WE HAVE WATCHED THEM COOK.'],
  ],
  'inner-signal': [
    ['THE MASTS DOWN HERE WERE NEVER OURS. THEY POINT AT THE FLOOR.', 'ON THE PEAK OF THE BEAT THE ROCK UNDER THEM IS WARM. WE MEASURED IT. WE STOPPED MEASURING IT.'],
  ],
  'inner-gun': [
    ['THE TIDE HOLDS THE DEEP ROOM. WE HOLD THE SHADE ABOVE IT. NOBODY CROSSES THE BENCH AT SPEED.', 'ITS FINS SIT ON THE SHELF. ITS MAST SEES THE WHOLE ROOM AND NOTHING PAST THE DOOR.'],
  ],
};

function addLog(w: World, b: Body, x: number, y: number, key: string, rng: Rng, from: string, note: string): Pickup | null {
  const pool = LOG_LINES[key];
  if (!pool) return null;
  const lines = pool[rng.int(pool.length)];
  const sv = surfaceVelocity(b, x, y);
  const log = spawnPickup(w, 'log', x, y, sv.x, sv.y, 0, null, `${from} RECORDER`);
  log.radius = 0.6; log.mass = 0.2; log.glow = 0.4;
  w.slices.logs.push({ pickup: log, from, lines, line: 0, next: 0, noteKey: `gen-log-${log.id}`, noteText: note });
  return log;
}

/** Nudge a world point clear of the walls around it. Returns null when it cannot be made to fit inside. */
function fitInside(b: Body, x: number, y: number, radius: number): V2 | null {
  let px = x, py = y;
  for (let i = 0; i < 6; i++) {
    const { hit, inside } = circleVsWalls(b, px, py, radius);
    if (!inside) return null;
    if (!hit) return { x: px, y: py };
    px += hit.nx * (hit.pen + 0.05); py += hit.ny * (hit.pen + 0.05);
  }
  const { hit, inside } = circleVsWalls(b, px, py, radius);
  return inside && !hit ? { x: px, y: py } : null;
}

/** A local point on a chamber's shelf: t along it (0..1), lifted off the floor. */
function onShelf(ch: Chamber, t: number, lift: number): V2 {
  return { x: ch.floorA.x + (ch.floorB.x - ch.floorA.x) * t + ch.floorN.x * lift, y: ch.floorA.y + (ch.floorB.y - ch.floorA.y) * t + ch.floorN.y * lift };
}

function shelfLength(ch: Chamber): number { return Math.hypot(ch.floorB.x - ch.floorA.x, ch.floorB.y - ch.floorA.y); }

/** Put a pickup on the shelf (or in the air of the chamber) where it fits. */
function place(w: World, b: Body, ch: Chamber, kind: Pickup['kind'], value: number, name: string, rng: Rng, radius: number, where: 'shelf' | 'air' = 'shelf'): Pickup | null {
  for (let t = 0; t < 8; t++) {
    const local = where === 'shelf' ? onShelf(ch, 0.1 + rng.next() * 0.8, radius + 0.4) : { x: ch.centre.x + (rng.next() - 0.5) * ch.r, y: ch.centre.y + (rng.next() - 0.5) * ch.r };
    const wp = bodyToWorld(b, local);
    const at = fitInside(b, wp.x, wp.y, radius + 0.35);
    if (!at) continue;
    const sv = surfaceVelocity(b, at.x, at.y);
    const k = spawnPickup(w, kind, at.x, at.y, sv.x, sv.y, value, null, name);
    k.life = 1e9;
    if (kind === 'wreck') { k.radius = 2.0; k.mass = 2.5; }
    if (kind === 'log') { k.radius = 0.6; k.mass = 0.2; k.glow = 0.4; }
    return k;
  }
  return null;
}

function placeRock(w: World, b: Body, local: V2, size: number, rng: Rng, radius?: number): Asteroid | null {
  const wp = bodyToWorld(b, local);
  const rr = radius ?? (size === 3 ? 3.4 : size === 2 ? 2.1 : 1.1);
  const at = fitInside(b, wp.x, wp.y, rr * 0.7 + 0.3);
  if (!at) return null;
  const sv = surfaceVelocity(b, at.x, at.y);
  const a = createAsteroid(w, at.x, at.y, sv.x, sv.y, size, PLACED_ROCK);
  if (radius !== undefined) a.radius = radius;
  a.rested = true; a.rich = rng.chance(0.3);
  return a;
}

type Situation = 'gun' | 'workings' | 'wreck' | 'dump' | 'live' | 'dead' | 'signal' | 'rubble' | 'shelter' | 'empty';

/** Fill a network: every chamber gets a situation, no two alike in one complex, the world's rare ones rationed. */
function dressNetwork(w: World, ctx: Ctx, net: Network, names: Namer, ration: Record<string, number>): void {
  const { b, rng, geo } = ctx;
  const role = geo.role;
  const world = b.name.split(' ')[0];
  const noteFor = (what: string): string => `A RECORDER ${what} UNDER THE GROUND OF ${b.name}.`;
  const spend = (k: string): boolean => { if ((ration[k] ?? 0) <= 0) return false; ration[k]--; return true; };
  const used = new Set<Situation>();
  const chambers = net.chambers.slice().sort((p, q) => q.depth - p.depth);
  const entry = net.chambers[0];
  const pool: [Situation, number][] = role === 'inner'
    ? [['dump', 3], ['wreck', 2], ['workings', 2], ['rubble', 2], ['shelter', 2], ['gun', 1.1], ['live', 1.2], ['dead', 0.6], ['signal', 1]]
    : [['workings', 3], ['wreck', 2], ['dump', 2], ['rubble', 2], ['gun', 1.0], ['live', 1.2], ['dead', 0.6], ['signal', 1]];
  for (const ch of chambers) {
    // the entry chamber is lighter: a wreck, rubble, a dump, or nothing, unless the position guards the door
    const isEntry = ch === entry;
    let pick: Situation = 'empty';
    for (let t = 0; t < 12; t++) {
      let total = 0; for (const [, wgt] of pool) total += wgt;
      let r = rng.next() * total, cand: Situation = 'empty';
      for (const [k, wgt] of pool) { r -= wgt; if (r <= 0) { cand = k; break; } }
      if (used.has(cand) && cand !== 'rubble' && cand !== 'dump') continue;
      if (isEntry && !(cand === 'rubble' || cand === 'dump' || cand === 'wreck' || (cand === 'gun' && rng.chance(0.3)))) continue;
      if ((cand === 'gun' || cand === 'live' || cand === 'dead') && shelfLength(ch) < 20) continue;
      if ((cand === 'gun' || cand === 'dead') && net.chambers.length < 3) continue;
      if ((cand === 'gun' || cand === 'live' || cand === 'dead' || cand === 'signal') && !spend(cand)) continue;
      pick = cand; break;
    }
    if (net.kind === 'shelter') pick = role === 'inner' ? 'shelter' : rng.chance(0.5) ? 'dump' : 'rubble';
    used.add(pick);
    ch.content = pick;
    const shelfT = (k: number, n: number): number => 0.15 + (0.7 * (k + 0.5)) / n;
    switch (pick) {
      case 'gun': {
        // a gun position on the shelf, its kit along the shelf, powered by its own plant
        const along = unit({ x: ch.floorB.x - ch.floorA.x, y: ch.floorB.y - ch.floorA.y });
        const at = onShelf(ch, 0.5, 0.3);
        const pad = addInteriorPad(b, 'enemybase', `POST ${['ECHO', 'FOXTROT', 'GOLF', 'HOTEL', 'INDIA', 'JULIET'][rng.int(6)]}`, at, ch.floorN, 4);
        pad.enemyHealth = 200; pad.guns = rng.chance(0.4) ? 2 : 1;
        equipInteriorBase(w, pad, along, true, shelfLength(ch) / 2);
        if (rng.chance(0.6)) { const lg = place(w, b, ch, 'log', 0, `${net.name} RECORDER`, rng, 0.6); if (lg) w.slices.logs.push({ pickup: lg, from: net.name, lines: rng.pick(LOG_LINES[`${role}-gun`]), line: 0, next: 0, noteKey: `gen-log-${lg.id}`, noteText: noteFor('NEAR A GUN POSITION') }); }
        geo.placed.push(`gun position ${pad.name} in ${net.name}`);
        break;
      }
      case 'dead': {
        // a position built and left without its core: seat one and it wakes
        const along = unit({ x: ch.floorB.x - ch.floorA.x, y: ch.floorB.y - ch.floorA.y });
        const at = onShelf(ch, 0.5, 0.3);
        const pad = addInteriorPad(b, 'enemybase', `POST ${['KILO', 'LIMA', 'MIKE', 'NOVEMBER'][rng.int(4)]} (DARK)`, at, ch.floorN, 4);
        pad.enemyHealth = 160; pad.guns = 1;
        equipInteriorBase(w, pad, along, false, shelfLength(ch) / 2);
        const lg = place(w, b, ch, 'log', 0, `${net.name} RECORDER`, rng, 0.6);
        if (lg) w.slices.logs.push({ pickup: lg, from: net.name, lines: rng.pick(LOG_LINES[`${role}-dead`]), line: 0, next: 0, noteKey: `gen-log-${lg.id}`, noteText: noteFor('BESIDE A GUN POSITION WITH AN EMPTY SOCKET') });
        geo.placed.push(`dormant position in ${net.name}`);
        break;
      }
      case 'live': {
        const along = unit({ x: ch.floorB.x - ch.floorA.x, y: ch.floorB.y - ch.floorA.y });
        const base = onShelf(ch, 0.5, 1.0);
        const plant = addStructureAt(w, b, 'plant', base, ch.floorN, null, `${net.name} PLANT`);
        const socket = { x: plant.local.x + ch.floorN.x * 1.3, y: plant.local.y + ch.floorN.y * 1.3 };
        const src = addPowerSource(w, b, socket, 48, `${net.name} PLANT`, plant);
        spawnCore(w, src, 'REGULATOR');
        const sp = Math.min(4.5, shelfLength(ch) / 2 - 2.2);
        addStructureAt(w, b, 'radiator', { x: base.x + along.x * sp + ch.floorN.x * 0.1, y: base.y + along.y * sp + ch.floorN.y * 0.1 }, ch.floorN, null, `${net.name} FINS`);
        addStructureAt(w, b, 'mast', { x: base.x - along.x * sp - ch.floorN.x * 0.4, y: base.y - along.y * sp - ch.floorN.y * 0.4 }, ch.floorN, null, `${net.name} MAST`).integrity = 15;
        const lg = place(w, b, ch, 'log', 0, `${net.name} RECORDER`, rng, 0.6);
        if (lg) w.slices.logs.push({ pickup: lg, from: net.name, lines: rng.pick(LOG_LINES[`${role}-installation`]), line: 0, next: 0, noteKey: `gen-log-${lg.id}`, noteText: noteFor('BESIDE AN OLD PLANT THAT STILL KEEPS A CORE') });
        geo.placed.push(`buried plant with a core in ${net.name}`);
        break;
      }
      case 'workings': {
        for (let k = 0; k < 5 + rng.int(4); k++) place(w, b, ch, 'ore', rng.chance(0.4) ? 25 : 10, '', rng, 0.7, rng.chance(0.5) ? 'shelf' : 'air');
        for (let k = 0; k < 1 + rng.int(2); k++) placeRock(w, b, onShelf(ch, 0.2 + rng.next() * 0.6, 2.4), rng.chance(0.6) ? 1 : 2, rng);
        // the way on from here may be blocked by a boulder in a squeeze, and the walls shed rubble when shot
        const squeeze = net.links.find(l => l.narrow && (l.a === ch.id || l.b === ch.id) && !net.blocked.includes(l));
        if (squeeze && squeeze.pts.length >= 2) {
          const mid = squeeze.pts.length === 3 ? squeeze.pts[1] : { x: (squeeze.pts[0].x + squeeze.pts[1].x) / 2, y: (squeeze.pts[0].y + squeeze.pts[1].y) / 2 };
          const rock = placeRock(w, b, mid, 3, rng, Math.max(4.0, squeeze.hw * 1.15));
          if (rock) { net.blocked.push(squeeze); if (squeeze.fissure) squeeze.fissure.fragile = true; geo.placed.push(`boulder blocking a squeeze in ${net.name}`); }
        }
        if (ch.fissure) ch.fissure.fragile = rng.chance(0.5);
        geo.placed.push(`workings in ${net.name}`);
        break;
      }
      case 'wreck': {
        const k = place(w, b, ch, 'wreck', 0, names.derelict(), rng, 2.0);
        for (let j = 0; j < 2 + rng.int(3); j++) place(w, b, ch, 'salvage', 30 + rng.int(30), '', rng, 0.7);
        if (rng.chance(0.6)) { const lg = place(w, b, ch, 'log', 0, 'BLACK BOX', rng, 0.6); if (lg) { lg.beacon = rng.chance(0.5); w.slices.logs.push({ pickup: lg, from: k ? k.name : net.name, lines: rng.pick(LOG_LINES[`${role}-wreck`]), line: 0, next: 0, noteKey: `gen-log-${lg.id}`, noteText: noteFor('IN A HULL LEFT ON A SHELF') }); } }
        geo.placed.push(`stranded hull in ${net.name}`);
        break;
      }
      case 'dump': {
        const n = role === 'inner' ? 4 + rng.int(3) : 3 + rng.int(3);
        for (let k = 0; k < n; k++) place(w, b, ch, 'fuel', 35 + rng.int(15), '', rng, 0.7);
        const tank = place(w, b, ch, 'fuel', 70, 'BULK TANK', rng, 1.3);
        if (tank) { tank.radius = 1.3; tank.mass = 1.6; }
        geo.placed.push(`fuel dump in ${net.name}`);
        break;
      }
      case 'shelter': {
        for (let k = 0; k < 2 + rng.int(2); k++) place(w, b, ch, 'fuel', 40, '', rng, 0.7);
        place(w, b, ch, 'wreck', 0, `${names.derelict()} (COOKED)`, rng, 2.0);
        const lg = place(w, b, ch, 'log', 0, 'SHELTER RECORDER', rng, 0.6);
        if (lg) w.slices.logs.push({ pickup: lg, from: 'SHELTER', lines: rng.pick(LOG_LINES[`${role}-cave`]), line: 0, next: 0, noteKey: `gen-log-${lg.id}`, noteText: noteFor('IN A SHELTER UNDER THE RIM') });
        geo.placed.push(`shelter in ${net.name}`);
        break;
      }
      case 'signal': {
        const along = unit({ x: ch.floorB.x - ch.floorA.x, y: ch.floorB.y - ch.floorA.y });
        for (let k = -1; k <= 1; k++) { const p = onShelf(ch, 0.5, 0.6); addStructureAt(w, b, 'mast', { x: p.x + along.x * k * 3.4, y: p.y + along.y * k * 3.4 }, ch.floorN, null, `${net.name} ARRAY`); }
        const lg = place(w, b, ch, 'log', 0, 'ARRAY RECORDER', rng, 0.6, 'air');
        if (lg) { lg.beacon = true; lg.glow = 0.7; w.slices.logs.push({ pickup: lg, from: 'THE ARRAY', lines: rng.pick(LOG_LINES[`${role}-signal`]), line: 0, next: 0, noteKey: `gen-log-${lg.id}`, noteText: noteFor('AMONG THREE DEAD MASTS THAT POINT AT THE FLOOR') }); }
        geo.placed.push(`array in ${net.name}`);
        break;
      }
      case 'rubble': {
        const n = 3 + rng.int(3);
        for (let k = 0; k < n; k++) placeRock(w, b, onShelf(ch, shelfT(k, n), 2.6), rng.chance(0.5) ? 1 : 2, rng);
        geo.placed.push(`rubble in ${net.name}`);
        break;
      }
      case 'empty': {
        if (rng.chance(0.5)) { const lg = place(w, b, ch, 'log', 0, `${net.name} RECORDER`, rng, 0.6); if (lg) w.slices.logs.push({ pickup: lg, from: net.name, lines: rng.pick(LOG_LINES[`${role}-cave`]), line: 0, next: 0, noteKey: `gen-log-${lg.id}`, noteText: noteFor('ON AN EMPTY SHELF') }); }
        break;
      }
    }
  }
  // every complex has at least one thing to want at its far end
  if (net.chambers.every(c => c.content === 'empty')) { const far = chambers[0]; place(w, b, far, 'fuel', 40, '', rng, 0.7); geo.placed.push(`cell in ${net.name}`); }
}

/** Fill the world: generated pads and machinery in the remaining sockets, then the underground from the mouths, then what is in it. */
export function dressPlanet(w: World, geo: Geography, names: Namer): void {
  const b = geo.body, rng = geo.rng, role = geo.role;
  const world = b.name.split(' ')[0];
  const budget: Partial<Record<SocketKind, number>> = role === 'inner'
    ? { settlement: 0, depot: 2, hiddenpad: 1, works: 0, wreckfield: 2, installation: 1, machinery: 1, mast: 1, beacon: 1 }
    : { settlement: 2, depot: 1, hiddenpad: 1, works: 1, wreckfield: 2, installation: 1, machinery: 2, mast: 2, beacon: 1 };
  const spend = (k: SocketKind): boolean => { const n = budget[k] ?? 0; if (n <= 0) return false; budget[k] = n - 1; return true; };
  const surfaceVel = (x: number, y: number): V2 => surfaceVelocity(b, x, y);
  const onGround = (angle: number, lift = 1.0): V2 => { const r = rimAt(b, angle) + lift; return bodyToWorld(b, { x: Math.cos(angle) * r, y: Math.sin(angle) * r }); };
  const noteFor = (what: string): string => `A RECORDER ${what} ON ${b.name}.`;

  // ---- surface sockets
  for (const sk of rng.shuffle(geo.sockets.slice())) {
    if (sk.used) continue;
    for (const k of sk.kinds) {
      if (k === 'cavemouth' || k === 'shaftmouth' || k === 'tunnel' || k === 'overhang' || k === 'colony' || k === 'mine' || k === 'gun') continue;
      if (!spend(k)) continue;
      sk.used = true;
      const a = sk.angle;
      switch (k) {
        case 'settlement': { const p = addPad(b, 'outpost', names.colony(b.name), a, 3.5); p.fuel = true; p.repair = false; geo.placed.push(`settlement ${p.name} (${sk.motif.kind})`); break; }
        case 'depot': {
          const p = addPad(b, 'outpost', `${world} DEPOT ${rng.int(9) + 1}`, a, 3.5); p.fuel = true;
          geo.keepOut.push({ angle: a, hw: 6 });
          for (let i = 0; i < 2; i++) { const g = onGround(a + ((i - 0.5) * 2.2) / b.radius, 1.2); const sv = surfaceVel(g.x, g.y); spawnPickup(w, 'fuel', g.x, g.y, sv.x, sv.y, 40).life = 1e9; }
          geo.placed.push(`depot ${p.name} (${sk.motif.kind})`); break;
        }
        case 'hiddenpad': { const p = addPad(b, 'derelict', names.derelict(), a, 3.5); p.stock = 1 + rng.int(2); geo.placed.push(`hidden pad ${p.name} (${sk.motif.kind})`); break; }
        case 'works': {
          const p = addPad(b, 'outpost', `${names.mine()} WORKS`, a, 3.5); p.fuel = rng.chance(0.5);
          const side = rng.sign();
          addStructure(w, b, 'radiator', a + side * (p.halfWidth + 3.5) / b.radius, null, `${p.name} FINS`);
          geo.keepOut.push({ angle: a, hw: 9 });
          geo.placed.push(`works ${p.name} (${sk.motif.kind})`); break;
        }
        case 'wreckfield': {
          geo.keepOut.push({ angle: a, hw: 12 });
          const n = 4 + rng.int(4);
          for (let i = 0; i < n; i++) {
            const da = ((i / (n - 1)) - 0.5) * 16 / b.radius;
            const g = onGround(a + da, 1.1);
            const sv = surfaceVel(g.x, g.y);
            const big = i === Math.floor(n / 2);
            const k2 = spawnPickup(w, big ? 'wreck' : 'salvage', g.x, g.y, sv.x, sv.y, big ? 0 : 30 + rng.int(25), null, big ? `${names.derelict()} SECTION` : '');
            k2.life = 1e9; if (big) { k2.radius = 2.0; k2.mass = 2.5; }
          }
          if (rng.chance(0.6)) { const g = onGround(a + 9 / b.radius, 1.0); addLog(w, b, g.x, g.y, `${role}-wreck`, rng, 'WRECK FIELD', noteFor(`IN A WRECK FIELD IN A ${sk.motif.kind.toUpperCase()}`)); }
          geo.placed.push(`wreck field (${sk.motif.kind})`); break;
        }
        case 'installation': {
          geo.keepOut.push({ angle: a, hw: 9 });
          const plant = addStructure(w, b, 'plant', a, null, `${world} OLD PLANT`);
          const socket = { x: plant.local.x + plant.normalLocal.x * 1.2, y: plant.local.y + plant.normalLocal.y * 1.2 };
          const src = addPowerSource(w, b, socket, 48, `${world} OLD PLANT`, plant);
          spawnCore(w, src, 'REGULATOR');
          addStructure(w, b, 'mast', a + rng.sign() * 6 / b.radius, null, `${world} OLD MAST`).integrity = 12;
          const g = onGround(a - 5 / b.radius, 1.0); addLog(w, b, g.x, g.y, `${role}-installation`, rng, 'OLD PLANT', noteFor(`AT AN OLD PLANT IN A ${sk.motif.kind.toUpperCase()}`));
          geo.placed.push(`installation (${sk.motif.kind})`); break;
        }
        case 'machinery': {
          geo.keepOut.push({ angle: a, hw: 6 });
          addStructure(w, b, 'plant', a - 2.0 / b.radius, null, `${world} HOUSING`);
          addStructure(w, b, 'radiator', a + 2.0 / b.radius, null, `${world} FINS`);
          geo.placed.push(`machinery (${sk.motif.kind})`); break;
        }
        case 'mast': {
          geo.keepOut.push({ angle: a, hw: 6 });
          addStructure(w, b, 'mast', a, null, `${world} OLD RELAY`);
          if (rng.chance(0.5)) { const g = onGround(a + 3 / b.radius, 1.0); addLog(w, b, g.x, g.y, `${role}-ridge`, rng, 'RELAY', noteFor('BESIDE A DEAD MAST ON A RIDGE')); }
          geo.placed.push(`mast (${sk.motif.kind})`); break;
        }
        case 'beacon': {
          geo.keepOut.push({ angle: a, hw: 4 });
          const g = onGround(a, 1.0); const sv = surfaceVel(g.x, g.y);
          const k2 = spawnPickup(w, 'log', g.x, g.y, sv.x, sv.y, 0, null, 'RIDGE BEACON');
          k2.radius = 0.6; k2.mass = 0.2; k2.glow = 0.6; k2.beacon = true;
          w.slices.logs.push({ pickup: k2, from: 'BEACON', lines: LOG_LINES[`${role}-ridge`]?.[0] ?? ['...'], line: 0, next: 0, noteKey: `gen-log-${k2.id}`, noteText: noteFor('WITH A BEACON ON A CREST') });
          geo.placed.push(`beacon (${sk.motif.kind})`); break;
        }
      }
      break;
    }
  }

  // ---- the underground: complexes from cave mouths, shafts from shaft heads, tunnels, shelters
  const ctx: Ctx = { w, geo, b, rng, floorY: b.radius >= 80 ? -5 : -4.5 };
  const caps: Record<string, number> = role === 'inner' ? { complex: 1, shaft: 1, tunnel: 1, shelter: 2 } : { complex: 2, shaft: 2, tunnel: 1, shelter: 1 };
  const kinds: Record<string, 'complex' | 'shaft' | 'tunnel' | 'shelter'> = { cavemouth: 'complex', shaftmouth: 'shaft', tunnel: 'tunnel', overhang: 'shelter' };
  let complexes = 0;
  const mouthSockets = geo.sockets.filter(sk => !sk.used && kinds[sk.kinds[0]]).sort((p, q) => (kinds[p.kinds[0]] === 'complex' ? 0 : 1) - (kinds[q.kinds[0]] === 'complex' ? 0 : 1));
  for (const sk of mouthSockets) {
    if (sk.used) continue;
    const k = sk.kinds[0];
    const kind = kinds[k];
    if (!kind || (caps[kind] ?? 0) <= 0) continue;
    const hwMouth = kind === 'shaft' ? 6.5 : kind === 'shelter' ? 6.5 : 8;
    if (!mouthClear(ctx, sk.angle, hwMouth) || (kind === 'tunnel' && !mouthClear(ctx, sk.to!, 7))) { geo.placed.push(`(no ${kind}: mouth blocked)`); continue; }
    sk.used = true;
    const before = b.fissures.length;
    const name = kind === 'shaft' ? names.mine() : kind === 'tunnel' ? `${world} TUNNEL` : kind === 'shelter' ? `${world} SHELTER` : `${world} ${['WORKINGS', 'DEEP', 'HOLLOWS', 'GALLERIES'][complexes % 4]}`;
    let net: Network | null = null;
    if (kind === 'complex') net = growComplex(ctx, sk.angle, name, 3 + rng.int(role === 'inner' ? 3 : 4), 'complex');
    else if (kind === 'shaft') net = growShaft(ctx, sk.angle, name);
    else if (kind === 'tunnel') net = growComplex(ctx, sk.angle, name, 2, 'tunnel', sk.to);
    else net = growComplex(ctx, sk.angle, name, 1, 'shelter');
    if (!net || !net.fissures.length) { b.fissures.length = before; geo.placed.push(`(no ${kind}: could not grow)`); continue; }
    caps[kind]--;
    if (kind === 'complex') complexes++;
    geo.mouths.push(sk.angle);
    notchTerrain(b, sk.angle, hwMouth + 4, 2.6);
    geo.networks.push(net);
  }
  // a world with no complex under its ground is not one of these worlds: walk the circumference for the clearest plain and cut one there
  const hasComplex = (): boolean => geo.networks.some(n => n.chambers.length >= 2);
  if (!hasComplex()) {
    const a0 = rng.next() * TAU;
    for (let t = 0; t < 72 && !hasComplex(); t++) {
      const a = a0 + (t / 72) * TAU;
      if (!mouthClear(ctx, a, 8) || rimAt(b, a) > b.radius + 4) continue;
      const before = b.fissures.length, beforeNets = geo.networks.length, beforeMouths = geo.mouths.length;
      const net = growComplex(ctx, a, `${world} WORKINGS`, 3 + rng.int(3), 'complex');
      if (!net || net.chambers.length < 2) { b.fissures.length = before; geo.networks.length = beforeNets; geo.mouths.length = beforeMouths; continue; }
      geo.mouths.push(a); notchTerrain(b, a, 12, 2.6); geo.networks.push(net);
      geo.placed.push('complex cut into plain ground (no socket would take one)');
    }
  }
  markOpenings(b);
  recomputeMaxRadius(b);

  // ---- what is inside
  const ration: Record<string, number> = role === 'inner' ? { gun: 1, live: 1, dead: 1, signal: 1 } : { gun: 1, live: 1, dead: 1, signal: 1 };
  const nets = geo.networks.slice().sort((p, q) => q.chambers.length - p.chambers.length);
  for (const net of nets) dressNetwork(w, ctx, net, names, ration);

  // ---- boulders on canyon floors: rocks that stay where they are until something moves them
  for (const m of geo.motifs) {
    if (m.kind !== 'canyon' || m.params.cave || !rng.chance(0.5)) continue;
    const a = ((m.s0 + m.length * (rng.chance(0.5) ? 0.25 : 0.75)) % (TAU * b.radius)) / b.radius;
    if (b.pads.some(p => !p.interior && arcTo(b, p.angle, a) < p.halfWidth + 4)) continue;
    if (geo.mouths.some(mm => arcTo(b, mm, a) < 9)) continue;
    const g = onGround(a, 2.4);
    const sv = surfaceVel(g.x, g.y);
    const r = createAsteroid(w, g.x, g.y, sv.x, sv.y, 2, PLACED_ROCK);
    r.rested = true;
    geo.placed.push('boulder in a canyon');
  }
}

// ------------------------------------------------------------------ 4. validation

/** Physical soundness of a body's geography: every problem found, as text. Empty means sound. */
export function validatePlanet(w: World, b: Body): string[] {
  const out: string[] = [];
  const R = b.radius;
  const rim = (a: number): number => rimAt(b, a);
  // mouths: open edges whose midpoint lies at the ground or above
  const mouths: number[] = [];
  for (const f of b.fissures) {
    const n = f.outline.length;
    if (!outlineSimple(f.outline)) out.push(`${f.name}: outline crosses itself`);
    let opens = 0;
    for (let i = 0; i < n; i++) {
      if (!edgeOpen(f, i)) continue;
      opens++;
      const a = f.outline[i], c = f.outline[(i + 1) % n];
      const mx = (a.x + c.x) / 2, my = (a.y + c.y) / 2;
      if (Math.hypot(mx, my) >= rim(angOf({ x: mx, y: my })) - 1.5) mouths.push(angOf({ x: mx, y: my }));
    }
    if (!opens) out.push(`${f.name}: no way in`);
  }
  // open edges lead somewhere: into another passage or out of the ground
  for (const f of b.fissures) {
    const n = f.outline.length;
    for (let i = 0; i < n; i++) {
      if (!edgeOpen(f, i)) continue;
      const a = f.outline[i], c = f.outline[(i + 1) % n];
      const ex = c.x - a.x, ey = c.y - a.y; const el = Math.hypot(ex, ey) || 1;
      if (el < 0.3) continue;
      const ox = ey / el * 0.06, oy = -ex / el * 0.06; // outward of a counter-clockwise outline
      for (let k = 1; k <= 3; k++) {
        const t = 0.3 + 0.2 * (k - 1);
        const px = a.x + ex * t + ox, py = a.y + ey * t + oy;
        const r = Math.hypot(px, py);
        if (r >= rim(angOf({ x: px, y: py })) - 1.5) continue;
        if (!b.fissures.some(g => g !== f && pointInPolygon(g.outline, px, py))) {
          let nd = Infinity;
          for (const g of b.fissures) { if (g === f) continue; const m = g.outline.length; for (let j = 0; j < m; j++) { const p0 = g.outline[j], q0 = g.outline[(j + 1) % m]; const vx = q0.x - p0.x, vy = q0.y - p0.y; const l2 = vx * vx + vy * vy || 1e-9; let u = ((px - p0.x) * vx + (py - p0.y) * vy) / l2; u = Math.max(0, Math.min(1, u)); nd = Math.min(nd, Math.hypot(px - (p0.x + vx * u), py - (p0.y + vy * u))); } }
          if (nd > 0.5) { out.push(`${f.name}: open edge ${i} leads into rock`); break; }
        }
      }
    }
  }
  // every passage is reachable from a mouth
  if (b.fissures.length) {
    const reach = new Set<Fissure>();
    const queue: Fissure[] = [];
    for (const f of b.fissures) {
      const n = f.outline.length;
      for (let i = 0; i < n; i++) {
        if (!edgeOpen(f, i)) continue;
        const a = f.outline[i], c = f.outline[(i + 1) % n];
        const mx = (a.x + c.x) / 2, my = (a.y + c.y) / 2;
        if (Math.hypot(mx, my) >= rim(angOf({ x: mx, y: my })) - 1.5) { queue.push(f); reach.add(f); break; }
      }
    }
    while (queue.length) {
      const f = queue.pop()!;
      const n = f.outline.length;
      for (let i = 0; i < n; i++) {
        if (!edgeOpen(f, i)) continue;
        const a = f.outline[i], c = f.outline[(i + 1) % n];
        const mx = (a.x + c.x) / 2, my = (a.y + c.y) / 2;
        for (const g of b.fissures) if (g !== f && !reach.has(g) && pointInPolygon(g.outline, mx, my)) { reach.add(g); queue.push(g); }
      }
    }
    for (const f of b.fissures) if (!reach.has(f)) out.push(`${f.name}: not reachable from any mouth`);
  }
  // walls stay under the ground except at a mouth
  for (const f of b.fissures) {
    for (const v of f.outline) {
      const r = Math.hypot(v.x, v.y), a = angOf(v);
      if (r > rim(a) - 2.5 && !mouths.some(m => arcTo(b, m, a, r) < 14)) { out.push(`${f.name}: a wall breaks the surface away from any mouth`); break; }
    }
  }
  // pads: surface pads not swallowed, approachable, clear of mouths; interior pads on a floor inside a passage
  for (const p of b.pads) {
    const seg = b.segments;
    if (p.interior) {
      const c = { x: Math.cos(p.angle) * p.height, y: Math.sin(p.angle) * p.height };
      if (!b.fissures.some(f => pointInPolygon(f.outline, c.x, c.y))) out.push(`${p.name}: interior pad outside every passage`);
      continue;
    }
    for (let k = 0; k <= p.segCount; k++) {
      const i = (p.segIndex + k) % seg, a = (i / seg) * TAU;
      const v = { x: Math.cos(a) * b.terrain[i], y: Math.sin(a) * b.terrain[i] };
      if (b.fissures.some(f => pointInPolygon(f.outline, v.x, v.y))) { out.push(`${p.name}: pad lies in a passage`); break; }
    }
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * TAU;
      const d = arcTo(b, p.angle, a);
      if (d < p.halfWidth + 9 && b.terrain[i] > p.height + R * 0.09 + 1e-6 && !padCoversSegment(p, i)) { out.push(`${p.name}: a wall within ${(d).toFixed(0)} units stands ${(b.terrain[i] - p.height).toFixed(1)} above the pad`); break; }
    }
    for (const m of mouths) if (arcTo(b, m, p.angle) < p.halfWidth + 4) out.push(`${p.name}: a mouth opens under the pad`);
  }
  // objects: nothing embedded, nothing in a wall
  const near = (x: number, y: number): boolean => Math.hypot(x - b.pos.x, y - b.pos.y) < b.maxRadius + 8;
  const check = (x: number, y: number, radius: number, what: string): void => {
    const l = worldToBody(b, x, y);
    const inside = b.fissures.some(f => pointInPolygon(f.outline, l.x, l.y));
    if (inside) { const { hit } = circleVsWalls(b, x, y, radius); if (hit && hit.pen > 0.2) out.push(`${what}: in a wall (${hit.pen.toFixed(2)})`); return; }
    const r = Math.hypot(l.x, l.y);
    if (r < rim(angOf(l)) - radius * 0.5) out.push(`${what}: embedded in the ground (${(rim(angOf(l)) - r).toFixed(1)} under)`);
  };
  for (const k of w.pickups) if (k.alive && near(k.pos.x, k.pos.y)) check(k.pos.x, k.pos.y, k.radius * 0.7, `${k.kind} ${k.name}`);
  for (const a of w.asteroids) if (a.alive && near(a.pos.x, a.pos.y)) check(a.pos.x, a.pos.y, a.radius * 0.7, `rock ${a.size}`);
  for (const s of w.structures) if (s.body === b) { const wp = bodyToWorld(b, s.local); check(wp.x, wp.y, s.radius * 0.55, `${s.kind} ${s.name}`); }
  // mouths are not blocked by a rock
  for (const m of mouths) {
    const r = rim(m);
    const wp = bodyToWorld(b, { x: Math.cos(m) * (r + 1), y: Math.sin(m) * (r + 1) });
    for (const a of w.asteroids) if (a.alive && Math.hypot(a.pos.x - wp.x, a.pos.y - wp.y) < a.radius + 3) out.push(`a rock blocks a mouth`);
  }
  // the underground is roomy: chambers wide enough to turn in, passages broad unless a deliberate squeeze, every chamber with a shelf
  const geo = GEOGRAPHY.get(b);
  if (geo) for (const net of geo.networks) {
    if (net.kind === 'complex' && net.chambers.length < 2) out.push(`${net.name}: fewer than two chambers`);
    for (const ch of net.chambers) {
      if (ch.r < 8) out.push(`${net.name}: chamber of radius ${ch.r.toFixed(1)}`);
      if (shelfLength(ch) < 7) out.push(`${net.name}: shelf only ${shelfLength(ch).toFixed(1)} long`);
    }
    for (const l of net.links) if (l.hw < 3.2) out.push(`${net.name}: passage half width ${l.hw.toFixed(1)}`);
    const narrow = net.links.filter(l => l.narrow).length;
    if (net.links.length >= 3 && narrow > net.links.length / 2) out.push(`${net.name}: more squeezes than passages`);
  }
  if (b.fissures.length > 60) out.push('too many passages');
  return out;
}
