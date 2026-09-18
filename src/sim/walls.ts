// Walls: polyline interiors carved into bodies (fissures, caves, hull cuts). A fissure is a closed
// outline in the body's local frame; inside it the polar terrain does not apply and the outline's
// edges are the collision surface. Bodies that rotate carry their fissures with them. Passages may
// overlap: where they do, the shared stretches of outline are openings, and a point in the overlap
// is inside both, so every wall query looks at every passage the point is in.
import { TAU, type V2 } from '../engine/math';
import type { Body } from './bodies';

export interface Fissure {
  name: string;
  body: Body;
  outline: V2[];      // local coordinates, counter-clockwise, closed implicitly
  floorY: number;     // render depth of the floor below the plane
  flashUntil: number; // ping flash timer (world time)
  fragile: boolean;   // shots on these walls shed rubble
  openEdge: number;   // index of the edge that is the mouth (no wall there), -1 if closed
  open: boolean[];    // per edge: true where there is no wall (the mouth, or a join into another passage)
}

/** Is edge i of a fissure an opening rather than a wall? */
export function edgeOpen(f: Fissure, i: number): boolean { return i === f.openEdge || (f.open.length > i && f.open[i]); }

/** Split every outline edge where another passage's outline crosses it, so no edge is half in one passage and half in rock. */
function splitAtCrossings(b: Body): void {
  for (const f of b.fissures) {
    const n = f.outline.length;
    if (f.open.length !== n) f.open = new Array(n).fill(false);
    const outline: V2[] = [], open: boolean[] = [];
    let openEdge = -1;
    for (let i = 0; i < n; i++) {
      const a = f.outline[i], c = f.outline[(i + 1) % n];
      const ts: number[] = [];
      for (const g of b.fissures) {
        if (g === f) continue;
        const m = g.outline.length;
        for (let j = 0; j < m; j++) {
          const p = g.outline[j], q = g.outline[(j + 1) % m];
          const t = segSeg(a.x, a.y, c.x, c.y, p.x, p.y, q.x, q.y);
          if (t > 1e-4 && t < 1 - 1e-4) ts.push(t);
        }
      }
      ts.sort((u, v) => u - v);
      const isOpen = i === f.openEdge || f.open[i];
      if (i === f.openEdge) openEdge = outline.length;
      outline.push(a); open.push(isOpen);
      let last = -1;
      for (const t of ts) {
        if (t - last < 1e-3) continue;
        outline.push({ x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t }); open.push(isOpen);
        last = t;
      }
    }
    f.outline = outline; f.open = open; f.openEdge = openEdge;
  }
}

/** Where passages overlap, the shared stretches of outline are openings, not walls. Call after all fissures of a body exist. */
export function markOpenings(b: Body): void {
  if (b.fissures.length > 1) splitAtCrossings(b);
  for (const f of b.fissures) {
    const n = f.outline.length;
    if (f.open.length !== n) f.open = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      if (i === f.openEdge || f.open[i]) { f.open[i] = true; continue; }
      const a = f.outline[i], c = f.outline[(i + 1) % n];
      const mx = (a.x + c.x) / 2, my = (a.y + c.y) / 2;
      // the edge is an opening if its midpoint (nudged slightly either way) lies inside another passage; edges never cross another outline after splitting
      const ex = c.x - a.x, ey = c.y - a.y; const el = Math.hypot(ex, ey) || 1;
      const ox = ey / el * 0.12, oy = -ex / el * 0.12;
      for (const g of b.fissures) { if (g === f) continue; if (pointInPolygon(g.outline, mx + ox, my + oy) && pointInPolygon(g.outline, mx - ox, my - oy)) { f.open[i] = true; break; } }
    }
  }
}

/** Safety net: a world point that is under the ground of a body with passages but in none of them is moved into the nearest passage. */
export function rescueIntoWalls(b: Body, x: number, y: number, radius: number): (V2 & { into: string }) | null {
  const l = worldToBody(b, x, y);
  let best: { d: number; px: number; py: number; nx: number; ny: number; f: Fissure } | null = null;
  for (const f of b.fissures) {
    const n = f.outline.length;
    for (let i = 0; i < n; i++) {
      const a = f.outline[i], c = f.outline[(i + 1) % n];
      const ex = c.x - a.x, ey = c.y - a.y;
      const l2 = ex * ex + ey * ey || 1e-9;
      let t = ((l.x - a.x) * ex + (l.y - a.y) * ey) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = a.x + ex * t, py = a.y + ey * t;
      const d = Math.hypot(l.x - px, l.y - py);
      if (!best || d < best.d) { const el = Math.sqrt(l2); best = { d, px, py, nx: -ey / el, ny: ex / el, f }; }
    }
  }
  // only a nearby passage counts: something deep under the ground far from any passage is pushed out of the ground the ordinary way
  if (!best || best.d > 12) return null;
  const lp = { x: best.px + best.nx * (radius + 0.1), y: best.py + best.ny * (radius + 0.1) };
  return { ...bodyToWorld(b, lp), into: best.f.name };
}

/** Local -> world for a point on a body (respects rotation). */
export function bodyToWorld(b: Body, p: V2): V2 {
  if (!b.rotates) return { x: b.pos.x + p.x, y: b.pos.y + p.y };
  const c = Math.cos(b.spinAngle), s = Math.sin(b.spinAngle);
  return { x: b.pos.x + p.x * c - p.y * s, y: b.pos.y + p.x * s + p.y * c };
}

/** World -> local for a point on a body. */
export function worldToBody(b: Body, x: number, y: number): V2 {
  const dx = x - b.pos.x, dy = y - b.pos.y;
  if (!b.rotates) return { x: dx, y: dy };
  const c = Math.cos(-b.spinAngle), s = Math.sin(-b.spinAngle);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

export function rotateVec(v: V2, ang: number): V2 {
  const c = Math.cos(ang), s = Math.sin(ang);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

export function pointInPolygon(poly: V2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Is a world point inside any fissure of the body? Returns the fissure or null. */
export function fissureAt(b: Body, x: number, y: number): Fissure | null {
  if (!b.fissures.length) return null;
  const l = worldToBody(b, x, y);
  for (const f of b.fissures) if (pointInPolygon(f.outline, l.x, l.y)) return f;
  return null;
}

/** All passages containing a world point (a point in a join is in two). */
export function fissuresAt(b: Body, x: number, y: number): Fissure[] {
  const out: Fissure[] = [];
  if (!b.fissures.length) return out;
  const l = worldToBody(b, x, y);
  for (const f of b.fissures) if (pointInPolygon(f.outline, l.x, l.y)) out.push(f);
  return out;
}

/** Deepest wall penetration of a circle against every passage that contains its centre; null when the point is in no passage or touches no wall. */
export function circleVsWalls(b: Body, x: number, y: number, radius: number): { hit: WallHit | null; inside: boolean } {
  if (!b.fissures.length) return { hit: null, inside: false };
  const l = worldToBody(b, x, y);
  let best: WallHit | null = null, inside = false;
  for (const f of b.fissures) {
    if (!pointInPolygon(f.outline, l.x, l.y)) continue;
    inside = true;
    const h = circleVsFissure(b, f, x, y, radius);
    if (h && (!best || h.pen > best.pen)) best = h;
  }
  return { hit: best, inside };
}

/** First wall crossed by a world segment, over every passage containing either end. Null when neither end is in a passage or no wall is crossed. */
export function segmentVsWalls(b: Body, ax: number, ay: number, bx: number, by: number): { hit: { t: number; edge: number; fissure: Fissure } | null; inside: boolean } {
  if (!b.fissures.length) return { hit: null, inside: false };
  const la = worldToBody(b, ax, ay), lb = worldToBody(b, bx, by);
  let best: { t: number; edge: number; fissure: Fissure } | null = null, inside = false;
  for (const f of b.fissures) {
    if (!pointInPolygon(f.outline, la.x, la.y) && !pointInPolygon(f.outline, lb.x, lb.y)) continue;
    inside = true;
    const h = segmentVsFissure(b, f, ax, ay, bx, by);
    if (h && (!best || h.t < best.t)) best = { t: h.t, edge: h.edge, fissure: f };
  }
  return { hit: best, inside };
}

/** Does a closed outline avoid crossing itself? (A crossing outline has holes in its inside test.) */
export function outlineSimple(outline: V2[]): boolean {
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const a = outline[i], c = outline[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const p = outline[j], q = outline[(j + 1) % n];
      if (segSeg(a.x, a.y, c.x, c.y, p.x, p.y, q.x, q.y) >= 0) return false;
    }
  }
  return true;
}

export interface WallHit {
  pen: number;   // penetration depth
  nx: number;    // world normal (pointing into the open region, away from the wall)
  ny: number;
  fissure: Fissure;
  edge: number;  // edge index
}

/** Circle against the walls of a fissure. Returns the deepest penetration or null. */
export function circleVsFissure(b: Body, f: Fissure, x: number, y: number, radius: number): WallHit | null {
  const l = worldToBody(b, x, y);
  let best: WallHit | null = null;
  const n = f.outline.length;
  for (let i = 0; i < n; i++) {
    if (edgeOpen(f, i)) continue;
    const a = f.outline[i], c = f.outline[(i + 1) % n];
    const ex = c.x - a.x, ey = c.y - a.y;
    const l2 = ex * ex + ey * ey || 1e-9;
    let t = ((l.x - a.x) * ex + (l.y - a.y) * ey) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.x + ex * t, py = a.y + ey * t;
    const dx = l.x - px, dy = l.y - py;
    const d = Math.hypot(dx, dy);
    if (d < radius) {
      // normal: from the wall toward the point; for a point exactly on the wall use the edge's inward normal
      let nx: number, ny: number;
      if (d > 1e-6) { nx = dx / d; ny = dy / d; }
      else { const el = Math.sqrt(l2); nx = -ey / el; ny = ex / el; }
      const pen = radius - d;
      if (!best || pen > best.pen) {
        const wn = b.rotates ? rotateVec({ x: nx, y: ny }, b.spinAngle) : { x: nx, y: ny };
        best = { pen, nx: wn.x, ny: wn.y, fissure: f, edge: i };
      }
    }
  }
  return best;
}

/** Segment (world) against fissure walls: returns the first intersection parameter t in [0,1] or -1. */
export function segmentVsFissure(b: Body, f: Fissure, ax: number, ay: number, bx: number, by: number): { t: number; edge: number } | null {
  const la = worldToBody(b, ax, ay), lb = worldToBody(b, bx, by);
  const n = f.outline.length;
  let bestT = 2, bestE = -1;
  for (let i = 0; i < n; i++) {
    if (edgeOpen(f, i)) continue;
    const p = f.outline[i], q = f.outline[(i + 1) % n];
    const t = segSeg(la.x, la.y, lb.x, lb.y, p.x, p.y, q.x, q.y);
    if (t >= 0 && t < bestT) { bestT = t; bestE = i; }
  }
  return bestE >= 0 ? { t: bestT, edge: bestE } : null;
}

function segSeg(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  const r1x = bx - ax, r1y = by - ay, r2x = dx - cx, r2y = dy - cy;
  const den = r1x * r2y - r1y * r2x;
  if (Math.abs(den) < 1e-9) return -1;
  const t = ((cx - ax) * r2y - (cy - ay) * r2x) / den;
  const u = ((cx - ax) * r1y - (cy - ay) * r1x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

/**
 * Authoring helper: build a fissure outline from a centreline of (depth, lateral, halfWidth) samples
 * running inward from a mouth on the body's rim at mouthAngle. depth is measured inward from the
 * rim radius, lateral is sideways (positive = counter-clockwise side). Widths are per sample.
 */
export function fissureFromPath(b: Body, name: string, mouthAngle: number, rimRadius: number, path: { d: number; v: number; hw: number }[], floorY = -6, fragile = false): Fissure {
  const ux = Math.cos(mouthAngle), uy = Math.sin(mouthAngle);      // outward radial
  const px = -uy, py = ux;                                          // lateral (ccw)
  const left: V2[] = [], right: V2[] = [];
  for (let i = 0; i < path.length; i++) {
    const s = path[i];
    const r = rimRadius - s.d;
    const cx = ux * r + px * s.v, cy = uy * r + py * s.v;
    // lateral direction of the passage at this sample (from the neighbours), for square-ish walls
    const prev = path[Math.max(0, i - 1)], next = path[Math.min(path.length - 1, i + 1)];
    let tx = (ux * (rimRadius - next.d) + px * next.v) - (ux * (rimRadius - prev.d) + px * prev.v);
    let ty = (uy * (rimRadius - next.d) + py * next.v) - (uy * (rimRadius - prev.d) + py * prev.v);
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const nx = -ty, ny = tx;
    left.push({ x: cx + nx * s.hw, y: cy + ny * s.hw });
    right.push({ x: cx - nx * s.hw, y: cy - ny * s.hw });
  }
  // outline: down the right side, back up the left (counter-clockwise when the passage runs inward)
  const outline: V2[] = [...right, ...left.reverse()];
  // ensure counter-clockwise; the closing edge (last vertex back to the first) is always the mouth
  let area = 0;
  for (let i = 0; i < outline.length; i++) { const a = outline[i], c = outline[(i + 1) % outline.length]; area += a.x * c.y - c.x * a.y; }
  if (area < 0) outline.reverse();
  const f: Fissure = { name, body: b, outline, floorY, flashUntil: -1e9, fragile, openEdge: outline.length - 1, open: [] };
  b.fissures.push(f);
  return f;
}

/**
 * General builder: a passage along a centreline of local points with a half width per point. The
 * centreline is resampled so no wall edge is longer than about 1.6 units (the join test between
 * passages works on edge midpoints). openStart leaves the cap at the first point open (a mouth on
 * the rim); every other cap and wall is solid until markOpenings finds a passage behind it.
 * Returns null when the walls would cross (a bend tighter than the passage is wide).
 */
export function fissureFromPolyline(b: Body, name: string, pts: V2[], hws: number[], floorY: number, fragile: boolean, openStart: boolean, openEnd = false): Fissure | null {
  if (pts.length < 2) return null;
  const cp: V2[] = [], ch: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], c = pts[i + 1];
    const len = Math.hypot(c.x - a.x, c.y - a.y);
    const n = Math.max(1, Math.ceil(len / 1.6));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      cp.push({ x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t });
      ch.push(hws[i] + (hws[i + 1] - hws[i]) * t);
    }
  }
  cp.push(pts[pts.length - 1]); ch.push(hws[hws.length - 1]);
  const dirs: V2[] = cp.map((_, i) => { const prev = cp[Math.max(0, i - 1)], next = cp[Math.min(cp.length - 1, i + 1)]; const l = Math.hypot(next.x - prev.x, next.y - prev.y) || 1; return { x: (next.x - prev.x) / l, y: (next.y - prev.y) / l }; });
  const left: V2[] = [], right: V2[] = [];
  for (let i = 0; i < cp.length; i++) {
    const nx = -dirs[i].y, ny = dirs[i].x;
    left.push({ x: cp[i].x + nx * ch[i], y: cp[i].y + ny * ch[i] });
    right.push({ x: cp[i].x - nx * ch[i], y: cp[i].y - ny * ch[i] });
  }
  // on the inside of a bend the offset points fold back; drop any that do not advance along the passage
  const prune = (side: V2[]): V2[] => {
    const out: V2[] = [side[0]];
    for (let i = 1; i < side.length; i++) {
      const d = dirs[i], p = side[i], q = out[out.length - 1];
      if (i === side.length - 1 || (p.x - q.x) * d.x + (p.y - q.y) * d.y > 0.05) out.push(p);
    }
    return out;
  };
  const Rr = prune(right), L = prune(left);
  const outline: V2[] = [...Rr, ...L.reverse()];
  const endEdge = Rr.length - 1; // right[last] -> left[last]
  let area = 0;
  for (let i = 0; i < outline.length; i++) { const a = outline[i], c = outline[(i + 1) % outline.length]; area += a.x * c.y - c.x * a.y; }
  const startEdge = outline.length - 1;
  let endIdx = endEdge;
  if (area < 0) { outline.reverse(); endIdx = outline.length - 2 - endEdge; }
  if (!outlineSimple(outline)) return null;
  const open: boolean[] = new Array(outline.length).fill(false);
  if (openStart) open[startEdge] = true;
  if (openEnd) open[endIdx] = true;
  const f: Fissure = { name, body: b, outline, floorY, flashUntil: -1e9, fragile, openEdge: openStart ? startEdge : -1, open };
  b.fissures.push(f);
  return f;
}

/** Lower the polar terrain across the mouth so the notch reads from orbit. */
export function notchTerrain(b: Body, mouthAngle: number, halfWidthUnits: number, drop: number): void {
  const seg = b.segments;
  const halfAng = halfWidthUnits / b.radius;
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * TAU;
    const d = Math.atan2(Math.sin(a - mouthAngle), Math.cos(a - mouthAngle));
    if (Math.abs(d) <= halfAng) b.terrain[i] = Math.min(b.terrain[i], b.radius - drop);
  }
}
