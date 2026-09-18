// Sensing, sunlight and cooling: the same rules for every ship, turret and installation.
// A sensor sees a thing when its emissions are strong enough for the range and nothing solid is in
// the way. Emissions come from engines, weapons, heat, pings and the tide's own beat. Cooling comes
// from radiators, which work in shadow and struggle in sunlight; the star and its flares add heat.
import type { V2 } from '../engine/math';
import { maxTerrainRadius, type Body } from './bodies';
import { inShadow } from './physics';
import { fissureAt } from './walls';
import { coreOnCable, poweredAt } from './power';
import type { Ship, World } from './world';

export { hasSensors } from './upgrades';

/** 0..1 sunlight at a point. Surface objects pass their outward normal; the night side gets none. */
export function sunlight(w: World, x: number, y: number, normal: V2 | null): number {
  if (inShadow(w, { x, y })) return 0;
  if (!normal) return 1;
  const sx = w.star.pos.x - x, sy = w.star.pos.y - y;
  const l = Math.hypot(sx, sy) || 1;
  const c = (normal.x * sx + normal.y * sy) / l;
  return c <= 0 ? 0 : Math.min(1, c * 1.15);
}

/** Line of sight between two world points: terrain polygons and big rocks block it. */
export function losClear(w: World, ax: number, ay: number, bx: number, by: number): boolean { return losBlocker(w, ax, ay, bx, by) === null; }

/** What blocks the line of sight, by name, or null when it is clear. */
export function losBlocker(w: World, ax: number, ay: number, bx: number, by: number): string | null {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy || 1e-9;
  for (const b of w.bodies) {
    if (b.kind === 'gas') continue;
    const R = b.kind === 'star' ? b.radius : maxTerrainRadius(b);
    // closest approach of the segment to the centre
    const t = Math.max(0, Math.min(1, ((b.pos.x - ax) * dx + (b.pos.y - ay) * dy) / l2));
    const cx = ax + dx * t - b.pos.x, cy = ay + dy * t - b.pos.y;
    if (cx * cx + cy * cy > R * R) continue;
    if (b.kind === 'star') return b.name;
    // caves hide what is inside them from anything outside
    if (b.fissures.length) {
      const fa = fissureAt(b, ax, ay), fb = fissureAt(b, bx, by);
      if ((fa || fb) && fa !== fb) return b.name;
      if (fa && fb) continue;
    }
    // exact: the segment against the terrain polygon
    const seg = b.segments;
    const rot = b.rotates ? b.spinAngle : 0;
    const c = Math.cos(rot), s = Math.sin(rot);
    let px = 0, py = 0;
    for (let i = 0; i <= seg; i++) {
      const k = i % seg;
      const a = (k / seg) * Math.PI * 2;
      const r = b.terrain[k];
      const lx = Math.cos(a) * r, ly = Math.sin(a) * r;
      const wx = b.pos.x + lx * c - ly * s, wy = b.pos.y + lx * s + ly * c;
      if (i > 0 && segSeg(ax, ay, bx, by, px, py, wx, wy)) return b.name;
      px = wx; py = wy;
    }
  }
  for (const a of w.asteroids) {
    if (!a.alive || a.size < 2) continue;
    const r = a.radius * 0.9;
    const t = Math.max(0, Math.min(1, ((a.pos.x - ax) * dx + (a.pos.y - ay) * dy) / l2));
    const cx = ax + dx * t - a.pos.x, cy = ay + dy * t - a.pos.y;
    if (cx * cx + cy * cy < r * r) return 'A ROCK';
  }
  return null;
}

function segSeg(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const r1x = bx - ax, r1y = by - ay, r2x = dx - cx, r2y = dy - cy;
  const den = r1x * r2y - r1y * r2x;
  if (Math.abs(den) < 1e-9) return false;
  const t = ((cx - ax) * r2y - (cy - ay) * r2x) / den;
  const u = ((cx - ax) * r1y - (cy - ay) * r1x) / den;
  return t > 0.001 && t < 0.999 && u >= 0 && u <= 1;
}

/** Emission signature of a ship: 1 is a ship under main thrust. */
export function signature(w: World, s: Ship): number {
  let sig = s.landed ? 0.06 : 0.12;
  // the plume is the engine's actual output: a tuned engine or a boost shows further than a stock burn
  const output = s.boosting ? s.stats.boostThrust : s.stats.thrust * s.thrusting;
  sig += (output / 14) * 0.9 + (s.retroing * s.stats.retro + Math.abs(s.strafing) * s.stats.strafe) / 14 * 0.6;
  // the muzzle flash of a heavy gun carries further than a pulse
  if (w.time - s.lastFireTime < 1.5) sig += 0.6 + s.lastShotHeat * 8;
  if (w.time - s.lastPingTime < 2.5) sig += 3.0;
  sig += s.heat * 0.4;
  // things that keep the tide's beat radiate it
  if (s.kind === 'sentinel' && s.landed && poweredAt(w, s.landed.body, s.pos.x, s.pos.y)) sig += 1.0;
  if (coreOnCable(s)) sig += 1.0;
  return sig;
}

/** Can a sensor at (x, y) with the given unit range see the target? */
export function canSense(w: World, x: number, y: number, range: number, target: Ship): boolean {
  if (!target.alive || target.docked) return false;
  const d = Math.hypot(target.pos.x - x, target.pos.y - y);
  if (d > range * Math.sqrt(signature(w, target))) return false;
  return losClear(w, x, y, target.pos.x, target.pos.y);
}

/** Heat shed per second by a ship's radiators. Radiators want shadow. */
export function coolingRate(w: World, s: Ship): number {
  if (s.kind === 'sentinel' && s.landed) {
    const pad = s.ai?.home as import('./bodies').Pad | null;
    const rad = pad ? pad.radiator : null;
    if (rad && rad.alive) {
      const rp = radiatorPos(rad);
      const sun = sunlight(w, rp.x, rp.y, radiatorNormal(rad));
      rad.hot = Math.max(rad.hot, s.heat);
      return 0.06 + 0.5 * (1 - sun);
    }
    return 0.03;
  }
  const n = s.landed ? landedNormal(s) : null;
  const sun = sunlight(w, s.pos.x, s.pos.y, n);
  return 0.35 * (0.7 + 0.3 * (1 - sun));
}

function landedNormal(s: Ship): V2 | null {
  const L = s.landed;
  if (!L) return null;
  const b = L.body;
  if (!b.rotates) return L.normal;
  const c = Math.cos(b.spinAngle), sn = Math.sin(b.spinAngle);
  return { x: L.normal.x * c - L.normal.y * sn, y: L.normal.x * sn + L.normal.y * c };
}

function radiatorPos(r: import('./structures').Structure): V2 {
  const b: Body = r.body;
  if (!b.rotates) return { x: b.pos.x + r.local.x, y: b.pos.y + r.local.y };
  const c = Math.cos(b.spinAngle), sn = Math.sin(b.spinAngle);
  return { x: b.pos.x + r.local.x * c - r.local.y * sn, y: b.pos.y + r.local.x * sn + r.local.y * c };
}

function radiatorNormal(r: import('./structures').Structure): V2 {
  const b: Body = r.body;
  if (!b.rotates) return r.normalLocal;
  const c = Math.cos(b.spinAngle), sn = Math.sin(b.spinAngle);
  return { x: r.normalLocal.x * c - r.normalLocal.y * sn, y: r.normalLocal.x * sn + r.normalLocal.y * c };
}

/** Heat added per second by the environment: the star up close, and flares on anything in sunlight. */
export function ambientHeat(w: World, s: Ship): number {
  let h = 0;
  const star = w.star;
  const d = Math.hypot(s.pos.x - star.pos.x, s.pos.y - star.pos.y);
  const n0 = s.landed ? landedNormal(s) : null;
  const lit = sunlight(w, s.pos.x, s.pos.y, n0);
  if (d < star.heatRadius) h += Math.max(0, 1 - (d - star.radius) / (star.heatRadius - star.radius)) * 0.14 * (lit > 0 ? 1 : 0);
  // beyond the scorch radius the star still warms everything it shines on, out to the warm radius
  else if (d < star.warmRadius) h += Math.max(0, 1 - (d - star.heatRadius) / (star.warmRadius - star.heatRadius)) * 0.5 * lit;
  if (w.flare.active && w.flare.intensity > 0) {
    const n = s.landed ? landedNormal(s) : null;
    h += 0.16 * w.flare.intensity * sunlight(w, s.pos.x, s.pos.y, n);
  }
  return h;
}
