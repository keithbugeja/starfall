// Tether: a cable between a ship and any object with mass. Modelled as a stiff spring-damper that
// only acts when taut, so slack rope is free, a taut rope is a pendulum, a yank stretches and can
// snap, and steady pull never breaks. Rigid targets (stations, free hulls) take torque at the
// attachment point, so pulling on a ring slows its spin.
import { type V2 } from '../engine/math';
import { terrainRadiusAt, type Body } from './bodies';
import { worldToBody, bodyToWorld, rotateVec } from './walls';
import { comm, sfx, type Asteroid, type Pickup, type Ship, type Station, type World } from './world';

export type TetherKind = 'pickup' | 'asteroid' | 'ship' | 'station' | 'body';

export interface Tether {
  owner: Ship;
  kind: TetherKind;
  pickup: Pickup | null;
  asteroid: Asteroid | null;
  ship: Ship | null;
  station: Station | null;
  body: Body | null;
  local: V2;         // attachment point in the target's local frame (station / body)
  length: number;    // rest length
  tension: number;   // current cable force
  peak: number;      // highest force seen
  stretch: number;   // current extension beyond rest length
  age: number;
}

export const TETHER_RANGE = 7;       // reach from the hull to latch
export const TETHER_MIN = 2.5;
export const TETHER_MAX = 11;
export const TETHER_K = 120;         // spring stiffness (force per unit stretch)
export const TETHER_BREAK = 90;      // force at which the cable parts
export const TETHER_MAX_STRETCH = 4; // parts regardless beyond this
export const STATION_MASS = 60;

export function shipMass(s: Ship): number { return s.massMul * Math.max(0.5, s.radius * s.radius); }
export function asteroidMass(a: Asteroid): number { return a.radius * a.radius * 2; }

interface EndState { x: number; y: number; vx: number; vy: number; invMass: number; rx: number; ry: number; invI: number; }

function targetState(t: Tether): EndState | null {
  switch (t.kind) {
    case 'pickup': {
      const p = t.pickup!;
      if (!p.alive) return null;
      return { x: p.pos.x, y: p.pos.y, vx: p.vel.x, vy: p.vel.y, invMass: 1 / p.mass, rx: 0, ry: 0, invI: 0 };
    }
    case 'asteroid': {
      const a = t.asteroid!;
      if (!a.alive) return null;
      return { x: a.pos.x, y: a.pos.y, vx: a.vel.x, vy: a.vel.y, invMass: 1 / asteroidMass(a), rx: 0, ry: 0, invI: 0 };
    }
    case 'ship': {
      const s = t.ship!;
      if (!s.alive || s.docked) return null;
      return { x: s.pos.x, y: s.pos.y, vx: s.vel.x, vy: s.vel.y, invMass: s.landed ? 0 : 1 / shipMass(s), rx: 0, ry: 0, invI: 0 };
    }
    case 'station': {
      const st = t.station!;
      if (!st.alive) return null;
      const c = Math.cos(st.angle), s = Math.sin(st.angle);
      const rx = t.local.x * c - t.local.y * s, ry = t.local.x * s + t.local.y * c;
      const I = STATION_MASS * st.radius * st.radius;
      return { x: st.pos.x + rx, y: st.pos.y + ry, vx: st.vel.x - st.spin * ry, vy: st.vel.y + st.spin * rx, invMass: 0, rx, ry, invI: 1 / I };
    }
    case 'body': {
      const b = t.body!;
      const wp = bodyToWorld(b, t.local);
      const rx = wp.x - b.pos.x, ry = wp.y - b.pos.y;
      const ang = b.free ? b.angVel : 0;
      return { x: wp.x, y: wp.y, vx: b.vel.x - ang * ry, vy: b.vel.y + ang * rx, invMass: b.free ? 1 / b.bodyMass : 0, rx, ry, invI: b.free && b.inertia > 0 ? 1 / b.inertia : 0 };
    }
  }
}

function applyToTarget(t: Tether, fx: number, fy: number, dt: number, st: EndState): void {
  // fx, fy: force on the target (toward the ship when taut)
  switch (t.kind) {
    case 'pickup': { const p = t.pickup!; p.vel.x += fx * st.invMass * dt; p.vel.y += fy * st.invMass * dt; break; }
    case 'asteroid': { const a = t.asteroid!; a.vel.x += fx * st.invMass * dt; a.vel.y += fy * st.invMass * dt; break; }
    case 'ship': { const s = t.ship!; s.vel.x += fx * st.invMass * dt; s.vel.y += fy * st.invMass * dt; if (s.landed && Math.hypot(fx, fy) > 25) { s.landed = null; } break; }
    case 'station': {
      const s = t.station!;
      const torque = st.rx * fy - st.ry * fx;
      s.spin += torque * st.invI * dt;
      break;
    }
    case 'body': {
      const b = t.body!;
      if (!b.free) break;
      b.vel.x += fx * st.invMass * dt; b.vel.y += fy * st.invMass * dt;
      const torque = st.rx * fy - st.ry * fx;
      b.angVel += torque * st.invI * dt;
      break;
    }
  }
}

/** Nearest tetherable thing within reach of the ship, or null. */
export function findTetherTarget(w: World, s: Ship): Tether | null {
  let best: Tether | null = null, bestGap = TETHER_RANGE;
  const consider = (gap: number, make: () => Tether) => { if (gap < bestGap) { bestGap = gap; best = make(); } };
  const base = (kind: TetherKind): Tether => ({ owner: s, kind, pickup: null, asteroid: null, ship: null, station: null, body: null, local: { x: 0, y: 0 }, length: 0, tension: 0, peak: 0, stretch: 0, age: 0 });
  for (const p of w.pickups) {
    if (!p.alive || p.carriedBy || !p.tetherable) continue;
    const d = Math.hypot(p.pos.x - s.pos.x, p.pos.y - s.pos.y) - s.radius - p.radius;
    consider(d, () => ({ ...base('pickup'), pickup: p }));
  }
  for (const a of w.asteroids) {
    if (!a.alive) continue;
    const d = Math.hypot(a.pos.x - s.pos.x, a.pos.y - s.pos.y) - s.radius - a.radius;
    consider(d, () => ({ ...base('asteroid'), asteroid: a }));
  }
  for (const o of w.ships) {
    if (o === s || !o.alive || o.docked) continue;
    const d = Math.hypot(o.pos.x - s.pos.x, o.pos.y - s.pos.y) - s.radius - o.radius;
    consider(d, () => ({ ...base('ship'), ship: o }));
  }
  for (const st of w.stations) {
    if (!st.alive) continue;
    const dx = s.pos.x - st.pos.x, dy = s.pos.y - st.pos.y;
    const d = Math.hypot(dx, dy) || 1;
    // nearest point on the ring
    const gap = Math.abs(d - st.radius) - s.radius - st.radius * 0.08;
    consider(gap, () => {
      const ang = Math.atan2(dy, dx) - st.angle;
      return { ...base('station'), station: st, local: { x: Math.cos(ang) * st.radius, y: Math.sin(ang) * st.radius } };
    });
  }
  for (const b of w.bodies) {
    if (!b.tetherable) continue;
    const dx = s.pos.x - b.pos.x, dy = s.pos.y - b.pos.y;
    const d = Math.hypot(dx, dy) || 1;
    const ang = Math.atan2(dy, dx);
    const surf = terrainRadiusAt(b, ang);
    const gap = d - surf - s.radius;
    consider(gap, () => {
      const wp = { x: b.pos.x + Math.cos(ang) * surf, y: b.pos.y + Math.sin(ang) * surf };
      return { ...base('body'), body: b, local: worldToBody(b, wp.x, wp.y) };
    });
  }
  return best;
}

export function attach(w: World, s: Ship): boolean {
  if (s.tether) return false;
  const t = findTetherTarget(w, s);
  if (!t) { sfx(w, 'deny', s.pos, 0.4); return false; }
  const st = targetState(t);
  if (!st) return false;
  const d = Math.hypot(st.x - s.pos.x, st.y - s.pos.y);
  t.length = Math.max(TETHER_MIN, Math.min(TETHER_MAX, d));
  s.tether = t;
  if (t.kind === 'pickup') { t.pickup!.tetheredBy = s; if (t.pickup!.kind === 'pod') s.towing = t.pickup; }
  if (t.kind === 'asteroid' && t.asteroid && s === w.player) { t.asteroid.handled = true; t.asteroid.rested = false; }
  sfx(w, 'tether', s.pos, 0.8, 0);
  return true;
}

/** Attach directly to a known pickup (gentle contact with a pod). */
export function attachPickup(w: World, s: Ship, p: Pickup): void {
  if (s.tether) return;
  const t: Tether = { owner: s, kind: 'pickup', pickup: p, asteroid: null, ship: null, station: null, body: null, local: { x: 0, y: 0 }, length: 0, tension: 0, peak: 0, stretch: 0, age: 0 };
  const d = Math.hypot(p.pos.x - s.pos.x, p.pos.y - s.pos.y);
  t.length = Math.max(TETHER_MIN, Math.min(TETHER_MAX, Math.max(d, 3)));
  s.tether = t;
  p.tetheredBy = s;
  if (p.kind === 'pod') s.towing = p;
  sfx(w, 'tether', s.pos, 0.8, 0);
}

export function release(w: World, s: Ship, snapped = false): void {
  const t = s.tether;
  if (!t) return;
  if (t.kind === 'pickup' && t.pickup) t.pickup.tetheredBy = null;
  s.tether = null;
  s.towing = null;
  if (snapped) {
    sfx(w, 'snap', s.pos, 1, 0);
    if (s === w.player) comm(w, 'KESTREL', 'CABLE PARTED.', [1, 0.6, 0.3], 1);
    if (s === w.player) w.screenShake = Math.min(1, w.screenShake + 0.3);
  } else sfx(w, 'tether', s.pos, 0.6, 1);
}

/** Apply cable forces for every tethered ship. Call after ships and objects have integrated. */
export function solveTethers(w: World, dt: number): void {
  for (const s of w.ships) {
    const t = s.tether;
    if (!t) continue;
    if (!s.alive || s.docked) { release(w, s); continue; }
    const st = targetState(t);
    if (!st) { release(w, s); continue; }
    t.age += dt;
    const dx = st.x - s.pos.x, dy = st.y - s.pos.y;
    const dist = Math.hypot(dx, dy) || 1e-6;
    const ext = dist - t.length;
    if (ext <= 0) { t.tension = 0; t.stretch = 0; continue; }
    const nx = dx / dist, ny = dy / dist;
    const vn = (st.vx - s.vel.x) * nx + (st.vy - s.vel.y) * ny; // > 0 separating
    const mShip = shipMass(s);
    const mEff = 1 / (1 / mShip + st.invMass + (st.rx * ny - st.ry * nx) * (st.rx * ny - st.ry * nx) * st.invI + 1e-9);
    // spring-damper on the extension rate; a rope never pushes, so the total is clamped at zero
    // just under critical: settles under steady pull, and a take-up under ~7 u/s holds
    const damping = 0.55 * 2 * Math.sqrt(TETHER_K * Math.min(mEff, 4));
    let force = TETHER_K * ext + damping * vn;
    force = Math.max(0, force);
    t.tension = force;
    t.stretch = ext;
    if (force > t.peak) t.peak = force;
    if (force > TETHER_BREAK || ext > TETHER_MAX_STRETCH) { release(w, s, true); continue; }
    // pull the ship toward the target, the target toward the ship
    s.vel.x += nx * force / mShip * dt; s.vel.y += ny * force / mShip * dt;
    applyToTarget(t, -nx * force, -ny * force, dt, st);
    // small rope friction on the relative tangential motion keeps pendulums from winding up numerically
    const tvx = (st.vx - s.vel.x) - vn * nx, tvy = (st.vy - s.vel.y) - vn * ny;
    const k = 0.15 * dt;
    if (st.invMass > 0 && t.kind !== 'station' && t.kind !== 'body') {
      applyToTarget(t, -tvx * k / (st.invMass || 1) / dt * 0.5, -tvy * k / (st.invMass || 1) / dt * 0.5, dt, st);
    }
    // landed ships that get pulled hard come unstuck
    if (s.landed && force > 20) s.landed = null;
    if (t.kind === 'pickup' && t.pickup && t.pickup.kind === 'pod') s.towing = t.pickup;
  }
}

/** World position of the tether's far end (for rendering). */
export function tetherEnd(t: Tether): V2 | null {
  const st = targetState(t);
  return st ? { x: st.x, y: st.y } : null;
}

export { rotateVec };
