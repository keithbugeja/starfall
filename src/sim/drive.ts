// The jump drive: a module that throws a ship along its nose to another star. It is built from rules
// that already exist. It will not engage inside a well (the local gravity must be nearly nothing),
// it needs the nose on the destination's bearing, it charges for seconds during which the ship is the
// loudest and hottest thing around, it costs fuel from the same tank as flight by distance and mass,
// and it drops whatever is on the cable. Nothing about it is a tunnel.
import { angleDiff, type V2 } from '../engine/math';
import { gravityAt } from './physics';
import { release } from './tether';
import { chartBearing, chartDistance, JUMP_FUEL_PER_UNIT, recipeOf, type Sector } from '../sector/sector';
import { comm, sfx, type Ship, type World } from './world';

export const DRIVE_GRAVITY_LIMIT = 0.02;   // units per second squared: outside every planet's well, clear of the star's near well
export const DRIVE_BEARING_TOLERANCE = 0.12; // radians of nose error the drive accepts
export const DRIVE_CHARGE_SECONDS = 8;      // the short drive
export const DRIVE_RANGE = 5;               // chart units the short drive reaches on a full tank at stock mass
export const DRIVE_HEAT_AT_JUMP = 0.85;     // the charge holds the guns at least this hot, in sun or shade, and never jams them
export const DRIVE_ARRIVAL_SPEED = 30;      // inward speed on arrival

export interface DriveCheck {
  fitted: boolean;
  target: string | null;
  distance: number;      // chart units to the target
  bearing: number;       // world heading the jump needs
  bearingError: number;  // radians, absolute
  gravity: number;       // local pull, units per second squared
  fuelNeeded: number;
  inRange: boolean;
  ok: boolean;
  reason: string;        // the first thing wrong, as the HUD says it
}

const tmp: V2 = { x: 0, y: 0 };

export function hasDrive(s: Ship): boolean { return s.upgrades.includes('drive'); }

export function jumpFuel(distance: number, s: Ship): number { return Math.ceil(distance * JUMP_FUEL_PER_UNIT * s.massMul); }

/** Everything that stands between the ship and a jump, in the order a pilot would fix it. */
export function checkDrive(w: World, sector: Sector, s: Ship): DriveCheck {
  const fitted = hasDrive(s);
  const target = s.drive.target;
  const out: DriveCheck = { fitted, target, distance: 0, bearing: 0, bearingError: 0, gravity: 0, fuelNeeded: 0, inRange: false, ok: false, reason: '' };
  if (!fitted) { out.reason = 'NO DRIVE FITTED'; return out; }
  if (!target || target === w.systemId) { out.reason = 'NO DESTINATION'; return out; }
  const from = recipeOf(sector, w.systemId), to = recipeOf(sector, target);
  out.distance = chartDistance(from, to);
  out.bearing = chartBearing(from, to);
  out.bearingError = Math.abs(angleDiff(s.angle, out.bearing));
  out.gravity = gravityAt(w, s.pos.x, s.pos.y, tmp);
  out.fuelNeeded = jumpFuel(out.distance, s);
  out.inRange = out.distance <= DRIVE_RANGE;
  if (!out.inRange) { out.reason = 'OUT OF RANGE'; return out; }
  if (s.docked || s.landed) { out.reason = 'LAUNCH FIRST'; return out; }
  if (s.tether) { out.reason = 'CABLE OUT'; return out; }
  if (out.gravity > DRIVE_GRAVITY_LIMIT) { out.reason = 'TOO DEEP IN THE WELL'; return out; }
  if (s.fuel < out.fuelNeeded) { out.reason = 'NOT ENOUGH FUEL'; return out; }
  if (out.bearingError > DRIVE_BEARING_TOLERANCE) { out.reason = 'OFF BEARING'; return out; }
  out.ok = true; out.reason = 'READY';
  return out;
}

/**
 * Advance the drive one tick. engage is the pilot holding the charge key. Firing or boosting resets
 * the charge; losing a gate resets it. Returns true on the tick the charge completes: the caller
 * performs the jump. The charge itself is heat and, through the sensor rule, noise.
 */
export function updateDrive(w: World, sector: Sector, s: Ship, engage: boolean, dt: number): boolean {
  const d = s.drive;
  if (!engage || !hasDrive(s)) { if (d.charging) { d.charging = false; d.charge = 0; } return false; }
  const chk = checkDrive(w, sector, s);
  if (!chk.ok || s.boosting || w.time - s.lastFireTime < 0.5) {
    if (d.charging) { d.charging = false; d.charge = 0; if (!chk.ok) comm(w, 'DRIVE', `CHARGE LOST: ${chk.reason}.`, [1, 0.7, 0.3], 1); sfx(w, 'deny', s.pos, 0.5); }
    return false;
  }
  if (!d.charging) { d.charging = true; d.charge = 0; sfx(w, 'ui', s.pos, 0.4); }
  d.charge = Math.min(1, d.charge + dt / DRIVE_CHARGE_SECONDS);
  // the charge is heat the ship cannot shed: the guns arrive hot, short of a jam, whatever the shade
  s.heat = Math.max(s.heat, d.charge * DRIVE_HEAT_AT_JUMP);
  return d.charge >= 1;
}

/** The moment of the jump: the cable goes, the fuel goes, the world goes. The sector does the rest. */
export function consumeJump(w: World, s: Ship, chk: DriveCheck): void {
  if (s.tether) release(w, s);
  s.fuel = Math.max(0, s.fuel - chk.fuelNeeded);
  s.drive.charging = false; s.drive.charge = 0;
  s.lastFireTime = -1e9;
}
