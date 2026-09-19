// Stations: rotating ring with a docking gap, a central hub you must touch gently.
import { TAU, wrapAngle } from '../engine/math';
import type { Body } from './bodies';
import { damageShip } from './physics';
import { release } from './tether';
import { podDelivered } from './slices';
import { canSense } from './sense';
import { comm, sfx, type Ship, type Station, type World } from './world';

export const RING_SEGMENTS = 24;
export const DOCK_SPEED = 7;

export interface StationSpec {
  name: string;
  kind: Station['kind'];
  parent: Body;
  orbitRadius: number;
  period: number;
  phase: number;
  radius?: number;
  spin?: number;
}

export function createStation(w: World, spec: StationSpec): Station {
  const R = spec.radius ?? 13;
  const segAngle = TAU / RING_SEGMENTS;
  const st: Station = {
    id: w.nextId++,
    name: spec.name,
    pos: { x: 0, y: 0 },
    vel: { x: 0, y: 0 },
    angle: w.rng.next() * TAU,
    spin: spec.spin ?? 0.2,
    spinNominal: spec.spin ?? 0.2,
    radius: R,
    bayDepth: R * 0.32,           // hub radius
    bayHalfWidth: segAngle * 2.0, // gap half-angle: four ring segments removed
    orbit: { parent: spec.parent, radius: spec.orbitRadius, angularSpeed: TAU / spec.period, phase: spec.phase },
    kind: spec.kind,
    alive: true,
    health: 1500,
    healthMax: 1500,
    fuelPrice: 2,
    orePrice: 30,
    salvagePrice: 45,
    upgrades: [],
    market: null,
    siege: 0,
    defenceTimer: 0,
    discovered: false,
    meshIndex: -1,
    lastDockTime: -1e9,
    stock: 0,
    flashUntil: -1e9,
  };
  updateStationPos(st, w.time, 0);
  w.stations.push(st);
  return st;
}

export function ringThickness(st: Station): number { return st.radius * 0.16; }
export function hubRadius(st: Station): number { return st.radius * 0.32; }

function updateStationPos(st: Station, time: number, dt: number): void {
  if (!st.orbit) return;
  const a = st.orbit.phase + st.orbit.angularSpeed * time;
  const nx = st.orbit.parent.pos.x + Math.cos(a) * st.orbit.radius;
  const ny = st.orbit.parent.pos.y + Math.sin(a) * st.orbit.radius;
  if (dt > 0) { st.vel.x = (nx - st.pos.x) / dt; st.vel.y = (ny - st.pos.y) / dt; }
  st.pos.x = nx; st.pos.y = ny;
}

export function updateStations(w: World, dt: number): void {
  for (const st of w.stations) {
    updateStationPos(st, w.time, dt);
    st.angle = wrapAngle(st.angle + st.spin * dt);
    // the ring motors are weak: a cable can out-pull them, but they win in the end
    if (st.spin !== st.spinNominal) { const d = st.spinNominal - st.spin; const step = 0.0035 * dt; st.spin = Math.abs(d) <= step ? st.spinNominal : st.spin + Math.sign(d) * step; }
    if (st.siege > 0) st.siege -= dt;
    if (st.health < st.healthMax && st.siege <= 0) st.health = Math.min(st.healthMax, st.health + 2 * dt);
    // point defence: a slow turret that harasses the nearest hostile
    st.defenceTimer -= dt;
    if (st.alive && st.defenceTimer <= 0) {
      st.defenceTimer = 0.9;
      let best: Ship | null = null, bd = 100;
      for (const s of w.ships) {
        if (!s.alive || s.faction !== 'enemy' || s.landed) continue;
        const d = Math.hypot(s.pos.x - st.pos.x, s.pos.y - st.pos.y);
        if (d < bd && canSense(w, st.pos.x, st.pos.y, 100, s)) { bd = d; best = s; }
      }
      if (best) {
        const dx = best.pos.x - st.pos.x, dy = best.pos.y - st.pos.y;
        const tt = bd / 80;
        const ax = dx + (best.vel.x - st.vel.x) * tt, ay = dy + (best.vel.y - st.vel.y) * tt;
        const a = Math.atan2(ay, ax) + (w.rng.next() - 0.5) * 0.06;
        const muzzle = st.radius * 0.36;
        w.projectiles.push({ id: w.nextId++, pos: { x: st.pos.x + Math.cos(a) * muzzle, y: st.pos.y + Math.sin(a) * muzzle }, vel: { x: st.vel.x + Math.cos(a) * 80, y: st.vel.y + Math.sin(a) * 80 }, life: 1.8, faction: 'civ', damage: 9, kind: 'pulse', radius: 0.6, gravMul: 1, owner: -1, seekTarget: null, color: [0.6, 0.9, 1.0], prevPos: { x: st.pos.x + Math.cos(a) * muzzle, y: st.pos.y + Math.sin(a) * muzzle } });
        sfx(w, 'fire_pulse', st.pos, 0.35);
      }
    }
    if (st.health <= 0 && st.alive) {
      st.alive = false;
      w.explosions.push({ pos: { x: st.pos.x, y: st.pos.y }, time: w.time, size: 5, color: [1, 0.6, 0.3] });
      comm(w, 'CONTROL', `${st.name} HAS BEEN DESTROYED.`, [1, 0.3, 0.3], 3, st.pos);
      sfx(w, 'bigboom', st.pos, 1, 6);
    }
  }
}

/** Angle of a point relative to the station's rotating frame. */
export function localAngle(st: Station, x: number, y: number): number {
  return wrapAngle(Math.atan2(y - st.pos.y, x - st.pos.x) - st.angle);
}

/** Resolve ring collisions and hub docking for one ship. Returns true if the ship docked. */
export function stationContact(w: World, s: Ship, st: Station): boolean {
  if (!st.alive || s.docked || s.landed) return false;
  const dx = s.pos.x - st.pos.x, dy = s.pos.y - st.pos.y;
  const d = Math.hypot(dx, dy);
  const R = st.radius, thick = ringThickness(st), hub = hubRadius(st);
  if (d > R + thick / 2 + s.radius + 1) return false;
  const nx = d > 1e-6 ? dx / d : 1, ny = d > 1e-6 ? dy / d : 0;
  const rvx = s.vel.x - st.vel.x, rvy = s.vel.y - st.vel.y;
  const local = localAngle(st, s.pos.x, s.pos.y);
  // ring
  const inner = R - thick / 2 - s.radius * 0.8, outer = R + thick / 2 + s.radius * 0.8;
  if (d > inner && d < outer) {
    const angularMargin = (s.radius * 0.8) / R;
    const inGap = Math.abs(local) < st.bayHalfWidth - angularMargin;
    if (!inGap) {
      // push back to the side the ship came from (never let it phase through the ring)
      const toInner = d - inner, toOuter = outer - d;
      const sign = d >= R ? 1 : -1;
      const pen = sign > 0 ? toOuter : toInner;
      s.pos.x += nx * sign * pen; s.pos.y += ny * sign * pen;
      const vn = rvx * nx + rvy * ny;
      // ring surface velocity (rotation) for tangential friction feel
      if (vn * sign < 0) {
        const impact = Math.abs(vn);
        const rest = 0.35;
        s.vel.x = st.vel.x + rvx - (1 + rest) * vn * nx;
        s.vel.y = st.vel.y + rvy - (1 + rest) * vn * ny;
        if (impact > 2.5) {
          damageShip(w, s, Math.pow(impact - 2.5, 1.4) * 1.5, 'none', 'collision');
          sfx(w, 'impact', s.pos, Math.min(1, impact / 12), impact);
          if (s === w.player) w.screenShake = Math.min(1, w.screenShake + impact / 25);
          w.explosions.push({ pos: { x: s.pos.x, y: s.pos.y }, time: w.time, size: 0.4, color: [1, 0.8, 0.5] });
        }
      }
      return false;
    }
  }
  // hub
  if (d < hub + s.radius * 0.8) {
    const rel = Math.hypot(rvx, rvy);
    if (s.faction === 'player') {
      if (rel < DOCK_SPEED) {
        dock(w, s, st);
        return true;
      }
      // too fast: bounce off the hub
      const pen = hub + s.radius * 0.8 - d;
      s.pos.x += nx * pen; s.pos.y += ny * pen;
      const vn = rvx * nx + rvy * ny;
      if (vn < 0) {
        s.vel.x = st.vel.x + rvx - 1.4 * vn * nx;
        s.vel.y = st.vel.y + rvy - 1.4 * vn * ny;
        damageShip(w, s, Math.pow(-vn - 2, 1.4) * 1.5, 'none', 'collision');
        sfx(w, 'impact', s.pos, 0.8, -vn);
        comm(w, st.name, 'TOO FAST, KESTREL. UNDER 7 TO DOCK.', [1, 0.7, 0.3], 1);
        if (s === w.player) w.screenShake = Math.min(1, w.screenShake + 0.3);
      }
      return false;
    }
    // AI ships that reach the hub dock silently (freighters delivering)
    if (s.ai && s.faction === 'civ') { s.docked = st; s.alive = false; return true; }
    // enemies bounce off the hub
    const pen = hub + s.radius * 0.8 - d;
    s.pos.x += nx * pen; s.pos.y += ny * pen;
    const vn = rvx * nx + rvy * ny;
    if (vn < 0) { s.vel.x = st.vel.x + rvx - 1.2 * vn * nx; s.vel.y = st.vel.y + rvy - 1.2 * vn * ny; }
  }
  return false;
}

export function dock(w: World, s: Ship, st: Station): void {
  s.docked = st;
  s.pos.x = st.pos.x; s.pos.y = st.pos.y;
  s.vel.x = st.vel.x; s.vel.y = st.vel.y;
  s.angVel = 0;
  s.thrusting = 0; s.boosting = false;
  st.lastDockTime = w.time;
  st.discovered = true;
  if (s === w.player) {
    w.stats.docks++;
    w.respawnStation = st;
    sfx(w, 'dock', st.pos, 1);
    comm(w, st.name, `DOCKING COMPLETE. WELCOME ABOARD, KESTREL.`, [0.6, 1, 0.8], 1);
    if (s.towing && s.towing.alive) {
      const pod = s.towing;
      release(w, s);
      podDelivered(w, pod, null);
      comm(w, st.name, 'POD RECEIVED. THE COLONISTS ARE SAFE. +150 CR', [0.6, 1, 0.8], 1);
    } else if (s.tether) release(w, s);
  }
}

/** Leave the station through the gap. */
export function undock(w: World, s: Ship): void {
  const st = s.docked;
  if (!st) return;
  s.docked = null;
  const a = st.angle; // gap direction
  const hub = hubRadius(st);
  const cx = Math.cos(a), cy = Math.sin(a);
  s.pos.x = st.pos.x + cx * (hub + s.radius + 0.5);
  s.pos.y = st.pos.y + cy * (hub + s.radius + 0.5);
  s.angle = a;
  s.angVel = 0;
  // outward plus the tangential motion of the gap so the ship rides out with it
  const tang = st.spin * (hub + 2);
  s.vel.x = st.vel.x + cx * 12 - cy * tang;
  s.vel.y = st.vel.y + cy * 12 + cx * tang;
  // if the gap faces the parent world, curve the exit away from it and say so
  const parent = st.orbit ? st.orbit.parent : null;
  if (parent) {
    const px = parent.pos.x - st.pos.x, py = parent.pos.y - st.pos.y;
    const pl = Math.hypot(px, py) || 1;
    const facing = (cx * px + cy * py) / pl;
    if (facing > 0.2) {
      // leave slowly with a sideways drift so there is time to turn before the well takes hold
      const side = (cx * py - cy * px) > 0 ? -1 : 1;
      s.vel.x = st.vel.x + cx * 6 - cy * tang - cy * side * 3.5;
      s.vel.y = st.vel.y + cy * 6 + cx * tang + cx * side * 3.5;
      if (s === w.player) comm(w, st.name, `EXIT FACES ${parent.name}. TURN AND CLIMB BEFORE YOU CRUISE.`, [1, 0.8, 0.4], 2);
    }
  }
  s.invuln = 1.5;
  if (s === w.player) { w.stats.launches++; sfx(w, 'launch', s.pos, 0.8); }
}
