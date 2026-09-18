// Power: a general rule. A power source is a socket on a body that seats a core (a prop that keeps the
// tide's beat). Anything on that body within the source's reach draws from it: guns, sensors, launch
// systems, the base glyphs. Pull the core out, or crack the housing, and everything it fed goes dark.
// Sockets accept any core; cores are never destroyed, only moved.
import { angleDiff, type V2 } from '../engine/math';
import { surfaceVelocity, type Body } from './bodies';
import { spawnPickup } from './physics';
import type { Structure } from './structures';
import { bodyToWorld } from './walls';
import { comm, sfx, type Pickup, type Ship, type World } from './world';

export interface PowerSource {
  id: number;
  name: string;          // what it feeds
  body: Body;
  socketLocal: V2;       // socket position in the body's local frame
  range: number;         // arc distance along the surface it can feed; Infinity = the whole body
  core: Pickup | null;   // whatever core is seated right now
  powered: boolean;
  broken: boolean;       // housing cracked: nothing seats here again
  lostAt: number;
  plant: Structure | null;
}

export const SEAT_RANGE = 4;   // a core this close to the socket is seated
export const MAGNET_RANGE = 6; // the socket draws a loose core home from this far

export function addPowerSource(w: World, body: Body, socketLocal: V2, range: number, name: string, plant: Structure | null = null): PowerSource {
  const src: PowerSource = { id: w.nextId++, name, body, socketLocal, range, core: null, powered: false, broken: false, lostAt: -1e9, plant };
  w.power.push(src);
  return src;
}

/** A core prop seated in the socket of a source. */
export function spawnCore(w: World, src: PowerSource, name = 'REGULATOR'): Pickup {
  const wp = bodyToWorld(src.body, src.socketLocal);
  const sv = surfaceVelocity(src.body, wp.x, wp.y);
  const core = spawnPickup(w, 'prop', wp.x, wp.y, sv.x, sv.y, 0, null, name);
  core.radius = 1.0; core.mass = 0.7; core.glow = 1; core.indestructible = true; core.role = 'core'; core.origin = src.name;
  src.core = core; src.powered = true;
  return core;
}

export function socketWorld(src: PowerSource): V2 { return bodyToWorld(src.body, src.socketLocal); }

/** Is a world point on this body fed by a live source? */
export function poweredAt(w: World, body: Body, x: number, y: number): boolean {
  for (const src of w.power) {
    if (src.body !== body || !src.powered) continue;
    if (src.range === Infinity) return true;
    const sp = socketWorld(src);
    const a0 = Math.atan2(sp.y - body.pos.y, sp.x - body.pos.x), a1 = Math.atan2(y - body.pos.y, x - body.pos.x);
    if (Math.abs(angleDiff(a0, a1)) * body.radius <= src.range) return true;
  }
  return false;
}

/** The core, if any, this ship is carrying on its cable close to the hull. */
export function coreOnCable(s: Ship): Pickup | null {
  const t = s.tether;
  if (!t || t.kind !== 'pickup' || !t.pickup || !t.pickup.alive || t.pickup.role !== 'core') return null;
  const p = t.pickup;
  return Math.hypot(p.pos.x - s.pos.x, p.pos.y - s.pos.y) < 14 ? p : null;
}

/** Seat detection, socket magnets, and the moment the lights go out. */
export function updatePower(w: World, dt: number): void {
  for (const src of w.power) {
    const sp = socketWorld(src);
    let seated: Pickup | null = null, bd = SEAT_RANGE;
    if (!src.broken) {
      for (const k of w.pickups) {
        if (!k.alive || k.role !== 'core' || k.carriedBy) continue;
        const d = Math.hypot(k.pos.x - sp.x, k.pos.y - sp.y);
        if (d < bd) { bd = d; seated = k; }
        // the socket draws a loose core home
        if (!k.tetheredBy && d < MAGNET_RANGE && d > 0.3) {
          const sv = surfaceVelocity(src.body, k.pos.x, k.pos.y);
          k.vel.x += (sp.x - k.pos.x) / d * 9 * dt; k.vel.y += (sp.y - k.pos.y) / d * 9 * dt;
          k.vel.x = sv.x + (k.vel.x - sv.x) * (1 - 2 * dt); k.vel.y = sv.y + (k.vel.y - sv.y) * (1 - 2 * dt);
        }
      }
    }
    const powered = seated !== null;
    if (seated && seated !== src.core && seated.origin !== src.name) {
      w.log.push({ time: w.time, kind: 'core-foreign', text: `${src.name} SEATED A CORE FROM ${seated.origin}`, x: sp.x, y: sp.y });
    }
    src.core = seated;
    if (powered !== src.powered) {
      src.powered = powered;
      if (!powered) {
        src.lostAt = w.time;
        comm(w, 'SENSORS', `EMISSIONS AT ${src.name} HAVE STOPPED.`, [0.85, 0.45, 1.0], 2, sp);
        sfx(w, 'powerdown', sp, 1);
        w.log.push({ time: w.time, kind: 'power-lost', text: `${src.name} DARK`, x: sp.x, y: sp.y });
      } else {
        comm(w, 'SENSORS', `EMISSIONS AT ${src.name} HAVE RESUMED.`, [1, 0.5, 0.3], 2, sp);
        w.log.push({ time: w.time, kind: 'power-restored', text: `${src.name} LIT`, x: sp.x, y: sp.y });
      }
    }
  }
}

/** The housing is cracked: the socket is gone and the core is thrown clear. */
export function breakSocket(w: World, src: PowerSource): void {
  if (src.broken) return;
  src.broken = true;
  const core = src.core;
  if (core) {
    const sp = socketWorld(src);
    const ang = Math.atan2(sp.y - src.body.pos.y, sp.x - src.body.pos.x) + (w.rng.next() - 0.5) * 0.8;
    core.vel.x += Math.cos(ang) * 5; core.vel.y += Math.sin(ang) * 5;
    core.pos.x += Math.cos(ang) * 1.5; core.pos.y += Math.sin(ang) * 1.5;
  }
}
