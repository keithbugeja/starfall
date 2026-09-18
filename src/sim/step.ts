// One simulation tick, shared by the game and the tests. The game composes controls and consumes
// effects; everything that changes world state happens here.
import type { Controls } from '../engine/input';
import { aiFire, pruneShips, updateAi } from './ai';
import { updateOrbits } from './bodies';
import { updateDirector } from './director';
import { applyModule, collide, fireWeapon, stepAsteroids, stepPickups, stepProjectiles, stepShip } from './physics';
import { updatePings } from './ping';
import { podDelivered, stepFreeBodies, updateSlices } from './slices';
import { stationContact, updateStations } from './stations';
import { release, solveTethers } from './tether';
import { comm, sfx, type Ship, type World } from './world';

export interface StepOptions {
  flight: boolean;         // the player is in the flight screen (may fire)
  fireSecondary: boolean;  // a secondary-weapon press this tick
  director: boolean;       // run the living system (off during the title attract mode)
  nearestEnemy: Ship | null;
}

/** Advance the world by dt. Returns true if the player docked this tick. */
export function stepWorld(w: World, c: Controls, dt: number, opts: StepOptions): boolean {
  updateOrbits(w.bodies, w.time, dt);
  stepFreeBodies(w, dt);
  updateStations(w, dt);
  if (opts.director) updateDirector(w, dt);
  const p = w.player;
  stepShip(w, p, c, dt);
  if (p.fireCooldown > 0) p.fireCooldown -= dt;
  if (c.fire && p.alive && !p.landed && !p.docked && !p.boosting && opts.flight) fireWeapon(w, p, p.weapon);
  if (opts.fireSecondary && p.secondary && p.alive && !p.docked && !p.landed) {
    const cd = p.fireCooldown; p.fireCooldown = 0;
    if (p.secondary.ammo > 0) fireWeapon(w, p, p.secondary, opts.nearestEnemy); else sfx(w, 'deny');
    p.fireCooldown = Math.max(cd, 0.2);
  }
  for (const s of w.ships) {
    if (s === p || !s.alive) continue;
    const ac = updateAi(w, s, dt);
    stepShip(w, s, ac, dt);
    aiFire(w, s);
  }
  solveTethers(w, dt);
  stepProjectiles(w, dt);
  stepAsteroids(w, dt);
  stepPickups(w, dt);
  collide(w, dt);
  let docked = false;
  for (const s of w.ships) {
    if (!s.alive || s.docked) continue;
    for (const st of w.stations) {
      if (stationContact(w, s, st) && s === p) docked = true;
    }
  }
  landedServices(w, dt);
  pruneShips(w);
  updatePings(w, dt);
  updateSlices(w, dt);
  w.time += dt;
  w.tick++;
  return docked;
}

/** Refuel, repair, load ore, deliver pods and strip derelicts while landed on a pad. */
function landedServices(w: World, dt: number): void {
  const p = w.player;
  if (!p.landed || !p.alive) return;
  const pad = p.landed.pad;
  if (!pad || !pad.alive) return;
  if (pad.kind === 'colony' || pad.kind === 'mine' || pad.kind === 'outpost') {
    if (p.fuel < p.fuelMax) p.fuel = Math.min(p.fuelMax, p.fuel + 7 * dt);
    if (pad.kind === 'colony' && p.hull < p.hullMax) p.hull = Math.min(p.hullMax, p.hull + 4 * dt);
    if (!pad.visited) { pad.visited = true; w.score += 100; comm(w, pad.name, pad.kind === 'colony' ? 'WELCOME, KESTREL. FUEL AND REPAIRS ARE ON US.' : 'PAD CLEAR. ORE IS YOURS TO CARRY.', [0.6, 1, 0.7], 1); }
    // a pod on the cable, close enough, is taken in
    const pod = p.towing;
    if (pod && pod.alive && Math.hypot(pod.pos.x - p.pos.x, pod.pos.y - p.pos.y) < 14) {
      release(w, p);
      podDelivered(w, pod, pad);
      comm(w, pad.name, 'POD RECEIVED. THE COLONISTS ARE SAFE. +150 CR', [0.6, 1, 0.7], 2);
      sfx(w, 'success');
    }
    if (pad.kind === 'mine') {
      pad.spawnTimer -= dt;
      if (pad.spawnTimer <= 0 && pad.stock > 0 && p.cargo.ore + p.cargo.salvage < p.cargo.capacity) {
        pad.spawnTimer = 1.5;
        pad.stock--; p.cargo.ore++;
        sfx(w, 'pickup', null, 0.5);
      }
    }
  } else if (pad.kind === 'derelict') {
    if (pad.stock > 0) {
      pad.spawnTimer += dt;
      if (pad.spawnTimer > 7) {
        pad.stock = 0;
        const modules = ['ancientcore', 'coldfusion', 'gyros', 'phase', 'seekers'];
        const names: Record<string, string> = { ancientcore: 'ANCIENT DRIVE CORE (BOOST +40%, BURN -40%)', coldfusion: 'COLD FUSION CELL (FUEL BURN HALVED)', gyros: 'MILITARY GYROS (TURN RATE +40%)', phase: 'PHASE LATTICE (SHIELD + HULL)', seekers: 'SEEKER RACK (12 MISSILES)' };
        const id = modules[pad.id % modules.length];
        applyModule(w, p, id);
        w.score += 800; w.credits += 200;
        comm(w, pad.name, `SALVAGE COMPLETE: ${names[id]}. +200 CR`, [1, 0.9, 0.5], 2);
        w.audioEvents.push({ kind: 'module', pos: null, volume: 1, param: 0 });
      }
    }
  }
}
