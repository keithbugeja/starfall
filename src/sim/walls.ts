// Walls: polyline interiors carved into bodies (fissures, caves, hull cuts). A fissure is a closed
// outline in the body's local frame; inside it the polar terrain does not apply and the outline's
// edges are the collision surface. Bodies that rotate carry their fissures with them.
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
    if (i === f.openEdge) continue;
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
    if (i === f.openEdge) continue;
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
  const f: Fissure = { name, body: b, outline, floorY, flashUntil: -1e9, fragile, openEdge: outline.length - 1 };
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
