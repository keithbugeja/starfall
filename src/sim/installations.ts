// Installations: what an enemy base is made of. Every base gets the same kit under the same rules:
// a sensor mast, radiator fins for its guns, and either a local plant with a core in its socket or a
// feed from the body's grid. THE KILN is one of these placed in a crater near a colony; nothing about
// it is special except where it stands.
import { angleDiff, TAU, type Rng } from '../engine/math';
import { addPad, recomputeMaxRadius, type Body, type Pad } from './bodies';
import { addPowerSource, spawnCore } from './power';
import { addStructure, addStructureAt } from './structures';
import type { V2 } from '../engine/math';
import { bodyToWorld, circleVsWalls, worldToBody } from './walls';
import type { World } from './world';

/** Fit a base with its machinery. gridFed bases draw from a body-wide source and get no plant. */
export function equipBase(w: World, pad: Pad, gridFed: boolean, rng: Rng, opts: { radiator?: boolean } = {}): void {
  const b = pad.body;
  const side = rng.sign();
  const arc = (u: number): number => pad.angle + (u / b.radius) * side;
  pad.mast = addStructure(w, b, 'mast', arc(pad.halfWidth + 4.5), pad, `${pad.name} MAST`);
  if (opts.radiator !== false) pad.radiator = addStructure(w, b, 'radiator', arc(-(pad.halfWidth + 4.5)), pad, `${pad.name} RADIATOR`);
  if (!gridFed) {
    const plant = addStructure(w, b, 'plant', arc(pad.halfWidth + 9.5), pad, `${pad.name} PLANT`);
    pad.plant = plant;
    const socket = { x: plant.local.x + plant.normalLocal.x * 1.2, y: plant.local.y + plant.normalLocal.y * 1.2 };
    const src = addPowerSource(w, b, socket, 48, pad.name, plant);
    spawnCore(w, src);
  }
}

/**
 * The same kit on a floor under the ground: the pad sits on a chamber's shelf, its mast, fins and plant
 * stand along the shelf either side. withCore false leaves the socket empty: a dormant position that
 * wakes when someone seats a core in it.
 */
export function equipInteriorBase(w: World, pad: Pad, along: V2, withCore: boolean, reach = 12): void {
  const b = pad.body;
  const n = pad.normalLocal!;
  const base = { x: Math.cos(pad.angle) * pad.height, y: Math.sin(pad.angle) * pad.height };
  const at = (u: number, lift: number): V2 => ({ x: base.x + along.x * u + n.x * lift, y: base.y + along.y * u + n.y * lift });
  // reach: how far along the shelf either side of the pad there is floor; a piece that would stand in the wall moves in toward the pad, then up off the floor
  const fit = (u: number, lift: number, radius: number): V2 => {
    for (const [du, dl] of [[0, 0], [-1.5, 0], [-3, 0], [0, 2.5], [-1.5, 2.5], [0, 5]]) {
      const l = at(u + Math.sign(u) * du, lift + dl);
      const wp = bodyToWorld(b, l);
      const { hit, inside } = circleVsWalls(b, wp.x, wp.y, radius + 0.3);
      if (inside && !hit) return l;
    }
    const l = at(u * 0.5, lift + 4);
    const wp = bodyToWorld(b, l);
    return worldToBody(b, wp.x, wp.y);
  };
  const m = Math.min(pad.halfWidth + 2.8, reach - 2.6);
  pad.radiator = addStructureAt(w, b, 'radiator', fit(-m, 1.1, 1.8), n, pad, `${pad.name} RADIATOR`);
  const plant = addStructureAt(w, b, 'plant', fit(m, 1.0, 1.6), n, pad, `${pad.name} PLANT`);
  pad.plant = plant;
  const socket = { x: plant.local.x + n.x * 1.3, y: plant.local.y + n.y * 1.3 };
  const src = addPowerSource(w, b, socket, 48, pad.name, plant, !withCore);
  if (withCore) spawnCore(w, src);
}

/** THE KILN: a base in a shallow crater within gun reach of a colony, on the terminator at first light. */
export function authorKiln(w: World, world: Body, colony: Pad, rng: Rng): Pad | null {
  const R = world.radius;
  // two candidate spots either side of the colony, sixty units along the surface; take the one nearest
  // the terminator, so the day cycle is in play from the first minutes
  const sx = w.star.pos.x - world.pos.x, sy = w.star.pos.y - world.pos.y;
  const sunAngle = Math.atan2(sy, sx);
  let best = 0, bestScore = -1;
  for (const side of [1, -1]) {
    const a = colony.angle + side * (60 / R);
    // keep clear of every other pad
    let clear = true;
    for (const p of world.pads) if (Math.abs(angleDiff(p.angle, a)) * R < 34) clear = false;
    if (!clear) continue;
    const toTerminator = Math.abs(Math.abs(angleDiff(a, sunAngle)) - Math.PI / 2);
    const score = Math.PI - toTerminator;
    if (score > bestScore) { bestScore = score; best = a; }
  }
  if (bestScore < 0) return null;
  const centre = best;
  // shape the crater: a shallow floor and raised rims a dozen units out
  const seg = world.segments;
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * TAU;
    const arc = Math.abs(angleDiff(a, centre)) * R;
    if (arc < 9) world.terrain[i] -= 3;
    else if (arc > 11 && arc < 24) {
      const t = 1 - Math.abs(arc - 17.5) / 6.5;
      world.terrain[i] += 5 * Math.max(0, t) * (0.6 + 0.4 * rng.next());
    }
    world.terrain[i] = Math.max(R * 0.7, Math.min(R * 1.3, world.terrain[i]));
  }
  recomputeMaxRadius(world);
  const pad = addPad(world, 'enemybase', 'THE KILN', centre, 5);
  pad.enemyHealth = 260; pad.spawnTimer = 70; pad.guns = 2;
  w.pads.push(pad);
  equipBase(w, pad, false, rng);
  return pad;
}
