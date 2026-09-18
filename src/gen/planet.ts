// Planetary geography: a world's equatorial profile cut as an arcade level, and passages under it.
// Terrain motifs (valleys, ridges, craters, canyons, shelves, excavations, fissures, shafts, tunnels,
// overhangs) are laid along the circumference from a per-world catalogue; each motif offers sockets
// that authored and generated content fill (a colony wants a crater floor, a mine wants a canyon, a
// mast wants a crest). Caves are grown from mouths by a small grammar: an entry, chambers, junctions,
// branches, and sometimes a second way out. Nothing here is a quest: it is a place with things in it.
import { angleDiff, clamp, TAU, type Rng, type V2 } from '../engine/math';
import { addPad, makeBodyRng, padCoversSegment, recomputeMaxRadius, surfaceVelocity, terrainRadiusAt, type Body, type Pad } from '../sim/bodies';
import { createAsteroid, spawnPickup } from '../sim/physics';
import { addPowerSource, spawnCore } from '../sim/power';
import { addStructure, addStructureAt } from '../sim/structures';
import { bodyToWorld, circleVsWalls, edgeOpen, fissureFromPolyline, markOpenings, notchTerrain, outlineSimple, pointInPolygon, worldToBody, type Fissure } from '../sim/walls';
import type { Pickup, World } from '../sim/world';
import type { Namer } from './names';

export type WorldRole = 'home' | 'inner' | 'mid' | 'gas' | 'enemy';
export type MotifKind = 'valley' | 'ridge' | 'crater' | 'canyon' | 'shelf' | 'excavation' | 'fissure' | 'shaft' | 'tunnel' | 'overhang';
export type SocketKind = 'colony' | 'settlement' | 'depot' | 'mine' | 'works' | 'hiddenpad' | 'wreckfield' | 'installation' | 'machinery' | 'mast' | 'beacon' | 'gun' | 'cavemouth' | 'shaftmouth' | 'tunnel' | 'overhang';

export interface Motif { kind: MotifKind; s0: number; length: number; params: Record<string, number>; }
export interface Socket { kinds: SocketKind[]; angle: number; motif: Motif; used: boolean; to?: number; dir?: number; }
export interface Room { centre: V2; hw: number; fissure: Fissure; depth: number; }
export interface Geography {
  body: Body; role: WorldRole; rng: Rng;
  motifs: Motif[]; sockets: Socket[];
  mouths: number[];           // local angles of every cave mouth
  keepOut: { angle: number; hw: number }[]; // surface content a mouth must not open under (structures, wreck fields, recorders)
  networks: Network[];
  placed: string[];           // what the dressing put where (for the harness and the report)
}
interface Network { name: string; fissures: Fissure[]; rooms: Room[]; points: { p: V2; hw: number; fissure: Fissure }[]; mouths: number[]; entry: V2[]; }

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
    case 'fissure': return 8 + rng.next() * 2;
    case 'shaft': return 8;
    case 'tunnel': return 42 + rng.next() * 26;
    case 'overhang': return 15 + rng.next() * 5;
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
    case 'fissure': { const d = Math.min(u, L - u); return { off: -2.6 * ramp(d, 1.2), flat: ramp(d, 1.2) }; }
    case 'shaft': { const d = Math.min(u, L - u); return { off: -1.6 * ramp(d, 1.5), flat: ramp(d, 1.5) }; }
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

// ------------------------------------------------------------------ 2. the passages

interface Ctx { w: World; geo: Geography; b: Body; rng: Rng; floorY: number; }

function mouthClear(ctx: Ctx, angle: number, hw: number): boolean {
  const b = ctx.b;
  for (const p of b.pads) if (arcTo(b, p.angle, angle) < p.halfWidth + hw + 6) return false;
  for (const m of ctx.geo.mouths) if (arcTo(b, m, angle) < hw * 2 + 9) return false;
  for (const k of ctx.geo.keepOut) if (arcTo(b, k.angle, angle) < k.hw + hw + 4) return false;
  // no notch over a shallow passage that is already there
  for (const net of ctx.geo.networks) for (const pt of net.points) if (depthOf(b, pt.p) < 13 && arcTo(b, angOf(pt.p), angle, Math.hypot(pt.p.x, pt.p.y)) < hw + pt.hw + 6) return false;
  return true;
}

/** A centreline point is sound when it is well under the ground, not too deep, and not under a pad. */
function pointOk(ctx: Ctx, q: V2, hw: number, margin = 4.5): boolean {
  const b = ctx.b;
  const r = Math.hypot(q.x, q.y);
  if (r < b.radius * 0.42) return false;
  const d = depthAcross(b, q, hw);
  if (d < hw + margin) return false;
  if (d < 8.5) for (const p of b.pads) if (arcTo(b, p.angle, angOf(q), r) < p.halfWidth + hw + 4) return false;
  return true;
}

/** Walk a passage from a start point: bends, a bias to stay under the ground, an optional chamber at the end. */
function walk(ctx: Ctx, start: V2, heading: V2, hw: number, steps: number, chamber: boolean): { pts: V2[]; hws: number[] } {
  const { b, rng } = ctx;
  const pts: V2[] = [start], hws: number[] = [hw];
  let p = start, h = unit(heading);
  for (let i = 0; i < steps; i++) {
    let turn = clamp(rng.gauss() * 0.3, -0.55, 0.55);
    const d = depthOf(b, p), r = Math.hypot(p.x, p.y);
    const inward = unit({ x: -p.x, y: -p.y });
    const side = h.x * inward.y - h.y * inward.x;
    if (d < 10) turn += 0.35 * Math.sign(side || 1);            // shallow: bend toward the centre
    else if (r < b.radius * 0.5) turn -= 0.35 * Math.sign(side || 1); // deep: bend away from it
    h = rot(h, turn);
    const len = 5 + rng.next() * 3;
    const q = { x: p.x + h.x * len, y: p.y + h.y * len };
    if (!pointOk(ctx, q, hw)) break;
    pts.push(q); hws.push(hw + (rng.next() - 0.5) * 0.5);
    p = q;
  }
  if (chamber && pts.length >= 2) {
    const big = 5.5 + rng.next() * 3.5;
    let ok = true;
    const extra: V2[] = [];
    for (let k = 0; k < 2; k++) {
      const q = { x: p.x + h.x * 5.5, y: p.y + h.y * 5.5 };
      if (!pointOk(ctx, q, big)) { ok = false; break; }
      extra.push(q); p = q;
    }
    if (ok) {
      hws[hws.length - 1] = Math.max(hws[hws.length - 1], big * 0.7);
      for (const q of extra) { pts.push(q); hws.push(big); }
      const q = { x: p.x + h.x * 3, y: p.y + h.y * 3 };
      if (pointOk(ctx, q, big * 0.6)) { pts.push(q); hws.push(big * 0.55); }
    }
  }
  return { pts, hws };
}

/** Try to lead a passage back up to the surface: turn toward the sky step by step; null if there is no clean way out. */
function climbOut(ctx: Ctx, from: V2, heading: V2, hw: number): { pts: V2[]; hws: number[]; mouth: number } | null {
  const { b } = ctx;
  const pts: V2[] = [], hws: number[] = [];
  let p = from, h = unit(heading);
  for (let i = 0; i < 9; i++) {
    const out = unit(p);
    const cross = h.x * out.y - h.y * out.x;
    const dot = h.x * out.x + h.y * out.y;
    const want = Math.atan2(cross, dot);
    h = rot(h, clamp(want, -0.5, 0.5));
    const q = { x: p.x + h.x * 5, y: p.y + h.y * 5 };
    const d = depthOf(b, q);
    if (d < hw + 4) {
      // about to break the surface: the mouth is straight up from here
      const a = angOf(q);
      if (!mouthClear(ctx, a, hw)) return null;
      const rim = rimAt(b, a);
      pts.push({ x: Math.cos(a) * (rim - hw - 2), y: Math.sin(a) * (rim - hw - 2) }); hws.push(hw);
      pts.push({ x: Math.cos(a) * rim, y: Math.sin(a) * rim }); hws.push(hw + 0.8);
      pts.push({ x: Math.cos(a) * (rim + 6), y: Math.sin(a) * (rim + 6) }); hws.push(hw + 2.5);
      return { pts, hws, mouth: a };
    }
    if (!pointOk(ctx, q, hw)) return null;
    pts.push(q); hws.push(hw);
    p = q;
  }
  return null;
}

function mouthPoints(b: Body, a: number, hw: number): { pts: V2[]; hws: number[] } {
  const rim = rimAt(b, a);
  const u = { x: Math.cos(a), y: Math.sin(a) };
  return { pts: [{ x: u.x * (rim + 6), y: u.y * (rim + 6) }, { x: u.x * rim, y: u.y * rim }, { x: u.x * (rim - hw - 2), y: u.y * (rim - hw - 2) }], hws: [hw + 2.6, hw + 0.9, hw] };
}

function record(net: Network, f: Fissure, pts: V2[], hws: number[], skip: number, ctx: Ctx): void {
  for (let i = skip; i < pts.length; i++) {
    const d = depthOf(ctx.b, pts[i]);
    if (d < 6) continue;
    net.points.push({ p: pts[i], hw: hws[i], fissure: f });
    if (hws[i] >= 5 && d >= 9) net.rooms.push({ centre: pts[i], hw: hws[i], fissure: f, depth: d });
  }
}

function addFissure(ctx: Ctx, net: Network, name: string, pts: V2[], hws: number[], openStart: boolean, openEnd: boolean, fragile: boolean): Fissure | null {
  if (pts.length < 2) return null;
  const f = fissureFromPolyline(ctx.b, name, pts, hws, ctx.floorY, fragile, openStart, openEnd);
  if (f) net.fissures.push(f);
  return f;
}

/** A cave from a mouth: entry, then chambers, junctions and branches; a branch may find its own way out. */
function growCave(ctx: Ctx, mouth: number, name: string): Network | null {
  const { b, rng } = ctx;
  const net: Network = { name, fissures: [], rooms: [], points: [], mouths: [mouth], entry: [] };
  const hw = 3 + rng.next() * 0.5;
  const m = mouthPoints(b, mouth, hw + 0.6);
  net.entry = m.pts.slice();
  const inward = unit({ x: -Math.cos(mouth), y: -Math.sin(mouth) });
  let main = { pts: [] as V2[], hws: [] as number[] };
  for (let t = 0; t < 4 && main.pts.length < 4; t++) {
    const h0 = rot(inward, (rng.next() - 0.5) * 0.8);
    const cand = walk(ctx, m.pts[m.pts.length - 1], h0, hw, 3 + rng.int(4), rng.chance(0.65));
    if (cand.pts.length > main.pts.length) main = cand;
  }
  const pts = [...m.pts, ...main.pts.slice(1)], hws = [...m.hws, ...main.hws.slice(1)];
  const f = addFissure(ctx, net, name, pts, hws, true, false, false);
  if (!f) return null;
  record(net, f, pts, hws, 3, ctx);
  // branches from the main passage
  const nBranch = main.pts.length >= 4 ? rng.int(3) : main.pts.length >= 3 ? rng.int(2) : 0;
  for (let k = 0; k < nBranch; k++) {
    const idx = 2 + rng.int(Math.max(1, main.pts.length - 3));
    const at = main.pts[idx];
    const dir = unit({ x: main.pts[idx + 1 < main.pts.length ? idx + 1 : idx].x - main.pts[idx - 1].x, y: main.pts[idx + 1 < main.pts.length ? idx + 1 : idx].y - main.pts[idx - 1].y });
    const bh = rot(dir, rng.sign() * (1.2 + rng.next() * 0.7));
    const bhw = 2.5 + rng.next() * 0.7;
    const br = walk(ctx, at, bh, bhw, 3 + rng.int(4), rng.chance(0.55));
    if (br.pts.length < 3) continue;
    let bpts = br.pts, bhws = br.hws, openEnd = false;
    if (rng.chance(0.3) && depthOf(b, bpts[bpts.length - 1]) < 26 && bhws[bhws.length - 1] < 4) {
      const last = bpts[bpts.length - 1], prev = bpts[bpts.length - 2];
      const out = climbOut(ctx, last, { x: last.x - prev.x, y: last.y - prev.y }, bhw);
      if (out) { bpts = [...bpts, ...out.pts]; bhws = [...bhws, ...out.hws]; openEnd = true; ctx.geo.mouths.push(out.mouth); net.mouths.push(out.mouth); notchTerrain(b, out.mouth, bhw + 1.5, 2.4); }
    }
    let bf: Fissure | null = null;
    for (let t = 0; t < 3 && !bf; t++) bf = addFissure(ctx, net, `${name} ${k + 1}`, bpts, bhws, false, openEnd, false);
    if (bf) record(net, bf, bpts, bhws, 1, ctx);
    else if (openEnd) { ctx.geo.mouths.pop(); net.mouths.pop(); }
  }
  return net;
}

/** A shaft: straight down from a small flat, a gallery at the bottom. Some are worked seams whose walls shed rubble when shot. */
function growShaft(ctx: Ctx, mouth: number, name: string): Network | null {
  const { b, rng } = ctx;
  const net: Network = { name, fissures: [], rooms: [], points: [], mouths: [mouth], entry: [] };
  const hw = 2.6 + rng.next() * 0.5;
  const m = mouthPoints(b, mouth, hw + 0.4);
  net.entry = m.pts.slice();
  const inward = unit({ x: -Math.cos(mouth), y: -Math.sin(mouth) });
  const pts = [...m.pts], hws = [...m.hws];
  let p = pts[pts.length - 1];
  const depth = 16 + rng.next() * 14;
  let steps = 0;
  while (depthOf(b, p) < depth && steps < 8) {
    const q = { x: p.x + inward.x * 6 + (rng.next() - 0.5) * 1.2, y: p.y + inward.y * 6 + (rng.next() - 0.5) * 1.2 };
    if (!pointOk(ctx, q, hw)) break;
    pts.push(q); hws.push(hw); p = q; steps++;
  }
  if (steps < 2) return null;
  const fragile = rng.chance(0.35);
  const f = addFissure(ctx, net, name, pts, hws, true, false, fragile);
  if (!f) return null;
  record(net, f, pts, hws, 3, ctx);
  // the gallery: sideways from the foot, one way or straight through both ways as a single passage
  const both = rng.chance(0.4);
  const g1 = walk(ctx, p, rot(inward, Math.PI / 2), 2.7, 2 + rng.int(3), true);
  const g2 = both ? walk(ctx, p, rot(inward, -Math.PI / 2), 2.7, 2 + rng.int(3), true) : { pts: [p], hws: [2.7] };
  const one = rng.sign() > 0 ? g1 : g2.pts.length > 1 ? g2 : g1;
  const gp = both && g1.pts.length > 1 && g2.pts.length > 1 ? [...g2.pts.slice(1).reverse(), p, ...g1.pts.slice(1)] : one.pts;
  const gw = both && g1.pts.length > 1 && g2.pts.length > 1 ? [...g2.hws.slice(1).reverse(), 2.7, ...g1.hws.slice(1)] : one.hws;
  if (gp.length >= 3) {
    const gf = addFissure(ctx, net, `${name} GALLERY`, gp, gw, false, false, fragile);
    if (gf) record(net, gf, gp, gw, 0, ctx);
  }
  return net;
}

/** A tunnel under a ridge, open at both ends. */
function growTunnel(ctx: Ctx, a: number, c: number, name: string): Network | null {
  const { b, rng } = ctx;
  const net: Network = { name, fissures: [], rooms: [], points: [], mouths: [a, c], entry: [] };
  const hw = 2.9 + rng.next() * 0.4;
  const ma = mouthPoints(b, a, hw + 0.4), mc = mouthPoints(b, c, hw + 0.4);
  net.entry = ma.pts.slice();
  const pts: V2[] = [...ma.pts], hws: number[] = [...ma.hws];
  // the run: at a steady radius under the base surface, from a toward c the short way
  const under = 13 + rng.next() * 3;
  const da = angleDiff(a, c); // signed turn from a to c, the short way
  const sg = Math.sign(da) || 1;
  const n = Math.max(2, Math.round(Math.abs(da) * b.radius / 6));
  // the corners are chamfered: from the foot of the mouth the passage goes down and along before the level run
  const pa = a + sg * 5 / b.radius;
  const ra = rimAt(b, pa) - under + 4;
  pts.push({ x: Math.cos(pa) * ra, y: Math.sin(pa) * ra }); hws.push(hw);
  net.entry.push(pts[pts.length - 1]);
  const a0 = a + sg * 10 / b.radius, c0 = c - sg * 10 / b.radius;
  const dd = angleDiff(a0, c0);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const ang = a0 + dd * t;
    // under the ridge the roof is thick; between, the run keeps a steady depth under whatever the ground does
    let rim = Infinity;
    for (let k = -2; k <= 2; k++) rim = Math.min(rim, rimAt(b, ang + (k / 2) * (hw + 1.5) / b.radius));
    const rr = Math.min(rim - under, b.radius - under + 6);
    const q = { x: Math.cos(ang) * rr, y: Math.sin(ang) * rr };
    if (!pointOk(ctx, q, hw, 3.5)) { ctx.geo.placed.push(`(tunnel point ${i}/${n} failed: depth ${depthAcross(b, q, hw).toFixed(1)} r ${(rr / b.radius).toFixed(2)})`); return null; }
    pts.push(q); hws.push(i > 0 && i < n && rng.chance(0.25) ? hw + 2.5 : hw);
  }
  const pc = c - sg * 5 / b.radius;
  const rc = rimAt(b, pc) - under + 4;
  pts.push({ x: Math.cos(pc) * rc, y: Math.sin(pc) * rc }); hws.push(hw);
  pts.push(mc.pts[2], mc.pts[1], mc.pts[0]); hws.push(mc.hws[2], mc.hws[1], mc.hws[0]);
  const f = addFissure(ctx, net, name, pts, hws, true, true, false);
  if (!f) { ctx.geo.placed.push('(tunnel outline crossed)'); return null; }
  record(net, f, pts, hws, 4, ctx);
  net.points.splice(-3, 3);
  return net;
}

/** An overhang: a shallow shelter running sideways just under the ground, open at one end. */
function growOverhang(ctx: Ctx, mouth: number, dir: number, name: string): Network | null {
  const { b, rng } = ctx;
  const net: Network = { name, fissures: [], rooms: [], points: [], mouths: [mouth], entry: [] };
  const hw = 2.7;
  const m = mouthPoints(b, mouth, hw + 0.3);
  net.entry = m.pts.slice();
  const inward = unit({ x: -Math.cos(mouth), y: -Math.sin(mouth) });
  const side = rot(inward, -dir * Math.PI / 2); // toward increasing angle when dir > 0
  const pts = [...m.pts], hws = [...m.hws];
  const rim = rimAt(b, mouth);
  const start = { x: Math.cos(mouth) * (rim - 8.2), y: Math.sin(mouth) * (rim - 8.2) };
  pts.push(start); hws.push(hw);
  let p = start;
  const len = 2 + rng.int(3);
  for (let i = 0; i < len; i++) {
    const q = { x: p.x + side.x * 5, y: p.y + side.y * 5 };
    // keep the roof thin but sound: about eight units under the local ground
    const ang = angOf(q);
    let rim2 = Infinity;
    for (let k = -2; k <= 2; k++) rim2 = Math.min(rim2, rimAt(b, ang + (k / 2) * (hw + 1.5) / b.radius));
    const r = rim2 - 8.2;
    const qq = { x: Math.cos(ang) * r, y: Math.sin(ang) * r };
    if (!pointOk(ctx, qq, hw, 3)) break;
    pts.push(qq); hws.push(hw + (i === len - 1 ? 0.8 : 0)); p = qq;
  }
  if (pts.length < 5) return null;
  const f = addFissure(ctx, net, name, pts, hws, true, false, false);
  if (!f) return null;
  record(net, f, pts, hws, 3, ctx);
  net.rooms.push({ centre: pts[pts.length - 1], hw: hws[hws.length - 1], fissure: f, depth: depthOf(b, pts[pts.length - 1]) });
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
  'home-wreck': [
    ['THE FIELD WAS A CONVOY ONCE. THREE HULLS CAME DOWN TOGETHER IN THE FIRST YEAR OF THE TIDE.', 'WE TAKE WHAT SELLS AND LEAVE THE REST. THE GROUND KEEPS IT.', 'ONE DRIVE SECTION STILL TICKS AT NIGHT.'],
    ['SALVAGE CLAIM, FILED AND IGNORED. THE BIG SECTION IS TOO HEAVY FOR A KESTREL WITHOUT A CABLE.', 'SOMEBODY HAS BEEN HERE BEFORE US. THE GOOD PLATING IS GONE.', 'THE RECORDER IN THE COCKPIT WAS STILL WARM. WE DID NOT LISTEN.'],
  ],
  'home-ridge': [
    ['RELAY LOG. WE LOSE THE HARBOUR EVERY EVENING WHEN THE MAST GOES INTO SHADOW. THE COLONY THINKS IT IS US.', 'THE CREST IS THE ONLY PLACE ON THIS SIDE WITH A CLEAR LINE TO THE MOON.', 'SOMETHING PINGED US FROM ORBIT LAST NIGHT. IT DID NOT ANSWER.'],
  ],
  'inner-cave': [
    ['SHADE LOG. AT NOON THE ROCK OUTSIDE IS TOO HOT TO TOUCH THROUGH GLOVES. IN HERE IT IS ALWAYS THE SAME COLD.', 'WE MOVE ONLY IN THE HOURS BEFORE DAWN. THE SHUTTLE\'S GUNS WOULD NOT COOL OTHERWISE.', 'THE CELLS ARE STACKED AT THE BACK. TAKE ONE, LEAVE ONE.'],
    ['SEAM LOG. THE ORE IS GOOD BUT THE HAUL IS A DAYLIGHT RUN AND DAYLIGHT KILLS.', 'WE CUT THE SECOND WAY OUT SO NOBODY IS EVER CAUGHT ON THE SUN SIDE AGAIN.', 'LISTEN FOR THE WALLS TICKING. THAT IS THE DAY COMING.'],
  ],
  'inner-installation': [
    ['SUN WORKS LOG. THE HOUSING STAYS COOL BEHIND THE RIM. THE REGULATOR STILL COUNTS.', 'THE MAST BURNED OUT IN THE FIRST SUMMER. WE NEVER REPLACED IT.', 'IF YOU TAKE THE CORE, TAKE IT AT NIGHT. THE SOCKET BITES WHEN IT IS HOT.'],
  ],
  'inner-wreck': [
    ['SHE CAME DOWN AT MIDDAY WITH HER FINS GLOWING. WE COULD NOT REACH HER UNTIL DARK.', 'THE HULL IS STILL WARM AT DAWN. DO NOT TOUCH THE PLATING.', 'HER CELLS WERE FULL. THAT WAS NOT THE PROBLEM.'],
    ['THE CRATER TAKES ONE A YEAR. THE PILOTS ALL SAY THE SAME THING: THE GUNS WENT QUIET AND THEN THE SHIP DID.', 'NOTHING HERE IS WORTH THE NOON. COME BACK WHEN THE SHADOW IS ON IT.', 'WE LEFT A CELL IN THE OVERHANG FOR WHOEVER IS NEXT.'],
  ],
  'inner-ridge': [
    ['WATCH LOG. FROM THE CREST YOU CAN SEE THE TERMINATOR COMING LIKE A TIDE ON A BEACH.', 'THE MAST GETS ONE HOUR OF SHADE. WE SEND EVERYTHING THEN.', 'ANYTHING THAT CROSSES THE SUN SIDE LEAVES A TRAIL. WE HAVE WATCHED THEM COOK.'],
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

function placeInRoom(w: World, b: Body, room: Room, kind: Pickup['kind'], value: number, name: string, rng: Rng, radius = 0.7): Pickup | null {
  for (let t = 0; t < 8; t++) {
    const jx = (rng.next() - 0.5) * room.hw * 1.2, jy = (rng.next() - 0.5) * room.hw * 1.2;
    const wp = bodyToWorld(b, { x: room.centre.x + jx, y: room.centre.y + jy });
    const at = fitInside(b, wp.x, wp.y, radius + 0.4);
    if (!at) continue;
    const sv = surfaceVelocity(b, at.x, at.y);
    const k = spawnPickup(w, kind, at.x, at.y, sv.x, sv.y, value, null, name);
    k.life = 1e9;
    return k;
  }
  return null;
}

/** Fill the world: generated pads and machinery in the remaining sockets, then caves from the mouths, then what is in them. */
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
            const k = spawnPickup(w, big ? 'wreck' : 'salvage', g.x, g.y, sv.x, sv.y, big ? 0 : 30 + rng.int(25), null, big ? `${names.derelict()} SECTION` : '');
            k.life = 1e9; if (big) { k.radius = 2.0; k.mass = 2.5; }
          }
          if (rng.chance(0.6)) { const g = onGround(a + 9 / b.radius, 1.0); addLog(w, b, g.x, g.y, `${role}-wreck`, rng, 'WRECK FIELD', noteFor(`IN A WRECK FIELD IN A ${sk.motif.kind.toUpperCase()}`)); }
          geo.placed.push(`wreck field (${sk.motif.kind})`); break;
        }
        case 'installation': {
          // an old plant with a core still in its socket; its mast is dead
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
          const k = spawnPickup(w, 'log', g.x, g.y, sv.x, sv.y, 0, null, 'RIDGE BEACON');
          k.radius = 0.6; k.mass = 0.2; k.glow = 0.6; k.beacon = true;
          w.slices.logs.push({ pickup: k, from: 'BEACON', lines: LOG_LINES[`${role}-ridge`]?.[0] ?? ['...'], line: 0, next: 0, noteKey: `gen-log-${k.id}`, noteText: noteFor('WITH A BEACON ON A CREST') });
          geo.placed.push(`beacon (${sk.motif.kind})`); break;
        }
      }
      break;
    }
  }

  // ---- caves
  const ctx: Ctx = { w, geo, b, rng, floorY: b.radius >= 80 ? -6 : -5 };
  const maxNets = role === 'inner' ? 4 : 5;
  let n = 0;
  for (const sk of geo.sockets) {
    if (sk.used || n >= maxNets) continue;
    const k = sk.kinds[0];
    if (k !== 'cavemouth' && k !== 'shaftmouth' && k !== 'tunnel' && k !== 'overhang') continue;
    if (!mouthClear(ctx, sk.angle, 4) || (k === 'tunnel' && !mouthClear(ctx, sk.to!, 4))) { geo.placed.push(`(no ${k}: mouth blocked)`); continue; }
    sk.used = true;
    const before = b.fissures.length;
    let net: Network | null = null;
    const name = k === 'shaftmouth' ? `${names.mine()}` : k === 'tunnel' ? `${world} TUNNEL` : k === 'overhang' ? `${world} SHELTER` : `${world} CAVE ${n + 1}`;
    if (k === 'cavemouth') net = growCave(ctx, sk.angle, name);
    else if (k === 'shaftmouth') net = growShaft(ctx, sk.angle, name);
    else if (k === 'tunnel') net = growTunnel(ctx, sk.angle, sk.to!, name);
    else net = growOverhang(ctx, sk.angle, sk.dir ?? 1, name);
    if (!net || !net.fissures.length) { b.fissures.length = before; geo.placed.push(`(no ${k}: could not grow)`); continue; }
    geo.mouths.push(sk.angle); if (k === 'tunnel') geo.mouths.push(sk.to!);
    notchTerrain(b, sk.angle, 5, 2.4); if (k === 'tunnel') notchTerrain(b, sk.to!, 5, 2.4);
    geo.networks.push(net);
    n++;
  }
  // a world with no way under its ground is not one of these worlds: find the clearest plain and cut a cave there
  if (n === 0) {
    for (let t = 0; t < 36 && n === 0; t++) {
      const a = rng.next() * TAU;
      if (!mouthClear(ctx, a, 4) || rimAt(b, a) > b.radius + 2) continue;
      const before = b.fissures.length;
      const net = growCave(ctx, a, `${world} CAVE`);
      if (!net || !net.fissures.length) { b.fissures.length = before; continue; }
      geo.mouths.push(a); notchTerrain(b, a, 5, 2.4); geo.networks.push(net); n++;
      geo.placed.push('cave cut into plain ground (no socket would take one)');
    }
  }
  markOpenings(b);
  recomputeMaxRadius(b);

  // ---- what is inside
  let installations = role === 'inner' ? (rng.chance(0.7) ? 1 : 0) : 1;
  const nets = geo.networks.slice().sort((p, q) => Math.max(...q.rooms.map(r => r.depth), 0) - Math.max(...p.rooms.map(r => r.depth), 0));
  for (const net of nets) {
    const rooms = net.rooms.slice().sort((p, q) => q.depth - p.depth);
    let filled = 0;
    for (let i = 0; i < rooms.length; i++) {
      const room = rooms[i];
      const roll = rng.next();
      if (i === 0 && installations > 0 && room.hw >= 5.5) {
        // a buried installation: a housing against the deepest wall, a core in its socket, a recorder beside it
        // the housing stands against the deepest wall of the room it can reach
        const normal = unit(room.centre);
        let at: V2 | null = null;
        for (let back = room.hw - 2.2; back >= 0 && !at; back -= 1.5) { const wp = bodyToWorld(b, { x: room.centre.x - normal.x * back, y: room.centre.y - normal.y * back }); at = fitInside(b, wp.x, wp.y, 2.0); }
        if (at) {
          const local = worldToBody(b, at.x, at.y);
          const plant = addStructureAt(w, b, 'plant', local, normal, null, `${net.name} PLANT`);
          const socket = { x: plant.local.x + plant.normalLocal.x * 1.3, y: plant.local.y + plant.normalLocal.y * 1.3 };
          const src = addPowerSource(w, b, socket, 48, `${net.name} PLANT`, plant);
          spawnCore(w, src, 'REGULATOR');
          const lg = placeInRoom(w, b, room, 'log', 0, `${net.name} RECORDER`, rng, 0.6);
          if (lg) { lg.radius = 0.6; lg.mass = 0.2; lg.glow = 0.4; w.slices.logs.push({ pickup: lg, from: net.name, lines: rng.pick(LOG_LINES[`${role}-installation`]), line: 0, next: 0, noteKey: `gen-log-${lg.id}`, noteText: noteFor(`IN A CHAMBER UNDER THE GROUND, BESIDE AN OLD PLANT THAT STILL KEEPS A CORE`) }); }
          installations--; filled++;
          geo.placed.push(`buried installation in ${net.name}`);
          continue;
        }
      }
      if (roll < 0.36) {
        // a cache: cells and salvage left where it is cold
        const nf = role === 'inner' ? 2 + rng.int(2) : 1 + rng.int(2);
        for (let k = 0; k < nf; k++) placeInRoom(w, b, room, 'fuel', 35 + rng.int(15), '', rng);
        for (let k = 0; k < 1 + rng.int(3); k++) placeInRoom(w, b, room, 'salvage', 30 + rng.int(30), '', rng);
        filled++; geo.placed.push(`cache in ${net.name}`);
      } else if (roll < 0.6) {
        const k = placeInRoom(w, b, room, 'wreck', 0, `${names.derelict()}`, rng, 2.0);
        if (k) { k.radius = 2.0; k.mass = 2.5; filled++; geo.placed.push(`stranded hull in ${net.name}`); }
        for (let j = 0; j < 1 + rng.int(2); j++) placeInRoom(w, b, room, 'salvage', 30 + rng.int(30), '', rng);
        if (rng.chance(0.5)) { const lg = placeInRoom(w, b, room, 'log', 0, 'BLACK BOX', rng, 0.6); if (lg) { lg.radius = 0.6; lg.mass = 0.2; lg.glow = 0.4; lg.beacon = rng.chance(0.4); w.slices.logs.push({ pickup: lg, from: k ? k.name : net.name, lines: rng.pick(LOG_LINES[`${role}-wreck`]), line: 0, next: 0, noteKey: `gen-log-${lg.id}`, noteText: noteFor('IN A HULL LEFT UNDER THE GROUND') }); } }
      } else if (roll < 0.78) {
        // rubble: rocks resting in the room; the narrows beyond may be blocked until they are moved or broken
        for (let k = 0; k < 1 + rng.int(2); k++) {
          const wp = bodyToWorld(b, room.centre);
          const size = rng.chance(0.6) ? 1 : 2;
          const at = fitInside(b, wp.x + (rng.next() - 0.5) * room.hw, wp.y + (rng.next() - 0.5) * room.hw, size === 1 ? 1.6 : 2.6);
          if (!at) continue;
          const sv = surfaceVel(at.x, at.y);
          const a = createAsteroid(w, at.x, at.y, sv.x, sv.y, size, PLACED_ROCK);
          a.rested = true; a.rich = rng.chance(role === 'inner' ? 0.5 : 0.25);
        }
        filled++; geo.placed.push(`rubble in ${net.name}`);
      } else {
        // an ore pocket, or just a recorder
        if (net.name.endsWith('TUNNEL') || rng.chance(0.5)) {
          for (let k = 0; k < 2 + rng.int(3); k++) placeInRoom(w, b, room, 'ore', rng.chance(0.4) ? 25 : 10, '', rng);
          geo.placed.push(`ore pocket in ${net.name}`);
        } else {
          const lg = placeInRoom(w, b, room, 'log', 0, `${net.name} RECORDER`, rng, 0.6);
          if (lg) { lg.radius = 0.6; lg.mass = 0.2; lg.glow = 0.4; w.slices.logs.push({ pickup: lg, from: net.name, lines: rng.pick(LOG_LINES[`${role}-cave`]), line: 0, next: 0, noteKey: `gen-log-${lg.id}`, noteText: noteFor('LEFT IN A PASSAGE UNDER THE GROUND') }); geo.placed.push(`recorder in ${net.name}`); }
        }
        filled++;
      }
    }
    // every hole holds something: a cell at the far end at least
    if (!filled && net.points.length) {
      const far = net.points.slice().sort((p, q) => depthOf(b, q.p) - depthOf(b, p.p))[0];
      const wp = bodyToWorld(b, far.p);
      const at = fitInside(b, wp.x, wp.y, 1.1);
      if (at) { const sv = surfaceVel(at.x, at.y); spawnPickup(w, 'fuel', at.x, at.y, sv.x, sv.y, 40).life = 1e9; geo.placed.push(`cell in ${net.name}`); }
    }
  }
  // ---- boulders on canyon floors and crater rims: rocks that stay where they are until something moves them
  for (const m of geo.motifs) {
    if (m.kind !== 'canyon' || m.params.cave || !rng.chance(0.5)) continue;
    const a = ((m.s0 + m.length * (rng.chance(0.5) ? 0.25 : 0.75)) % (TAU * b.radius)) / b.radius;
    if (b.pads.some(p => arcTo(b, p.angle, a) < p.halfWidth + 4)) continue;
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
        if (!b.fissures.some(g => g !== f && pointInPolygon(g.outline, px, py))) { out.push(`${f.name}: open edge ${i} leads into rock`); break; }
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
      if (r > rim(a) - 2.5 && !mouths.some(m => arcTo(b, m, a, r) < 10)) { out.push(`${f.name}: a wall breaks the surface away from any mouth`); break; }
    }
  }
  // pads: not swallowed, approachable, clear of mouths
  for (const p of b.pads) {
    const seg = b.segments;
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
  for (const s of w.structures) if (s.body === b) { const wp = bodyToWorld(b, s.local); check(wp.x, wp.y, s.radius * 0.8, `${s.kind} ${s.name}`); }
  // mouths are not blocked by a rock
  for (const m of mouths) {
    const r = rim(m);
    const wp = bodyToWorld(b, { x: Math.cos(m) * (r + 1), y: Math.sin(m) * (r + 1) });
    for (const a of w.asteroids) if (a.alive && Math.hypot(a.pos.x - wp.x, a.pos.y - wp.y) < a.radius + 3) out.push(`a rock blocks a mouth`);
  }
  if (b.fissures.length > 40) out.push('too many passages');
  return out;
}
