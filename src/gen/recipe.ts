// Generated systems: a World built from a SystemRecipe rather than the home system's authored layout.
// One trait first, everything else in its service. This milestone knows one trait: the red dwarf
// that flares. Small worlds close to a small cool star that flares often, so the day side of the
// inner world is a place to work at night and get out of; a mine on that world because the ore is
// there; a free port over the next world out; no Tide.
import { Rng, TAU } from '../engine/math';
import { addPad, createBody, makeBodyRng, resetBodyIds, type Body } from '../sim/bodies';
import { createAsteroid } from '../sim/physics';
import { createStation } from '../sim/stations';
import { createEmptyWorld, createShip, type World } from '../sim/world';
import { makeNamer } from './names';
import { spawnAiShip } from '../sim/ai';
import { markOpenings } from '../sim/walls';
import { dressPlanet, GEOGRAPHY, padAngleFor, PLACED_ROCK, sculptPlanet, type Geography } from './planet';
import type { SystemRecipe } from '../sector/sector';
import { clamp } from '../engine/math';
import { makeMarket } from '../sim/market';

const PAL = {
  ember: { low: [0.5, 0.16, 0.08], mid: [0.5, 0.16, 0.08], high: [0.5, 0.16, 0.08], glow: [1.55, 0.5, 0.28] },
  scorched: { low: [0.9, 0.32, 0.08], mid: [0.3, 0.2, 0.18], high: [0.46, 0.4, 0.36] },
  rock: { low: [0.34, 0.3, 0.28], mid: [0.56, 0.5, 0.44], high: [0.74, 0.7, 0.66] },
  ice: { low: [0.4, 0.55, 0.72], mid: [0.66, 0.8, 0.92], high: [0.95, 0.97, 1.0] },
};

export function generateFromRecipe(r: SystemRecipe): World {
  switch (r.trait) {
    case 'the red dwarf that flares': return emberSystem(r);
    default: throw new Error(`no generator for the trait "${r.trait}"`);
  }
}

/** The red dwarf that flares. */
function emberSystem(r: SystemRecipe): World {
  resetBodyIds();
  const seed = r.seed;
  const w = createEmptyWorld(seed, r.name || 'EMBER');
  const rng = new Rng(seed);
  const names = makeNamer(rng.fork());
  w.machinePresence = 0;
  w.flareRate = 3.5;

  // ---------------- the star: small, cool, close, and it flares
  const starName = names.star();
  const starR = 110 + rng.int(20);
  const star = createBody({ name: starName, kind: 'star', type: 'star', radius: starR, surfaceG: 9 + rng.next() * 2, soiMul: 3.0, palette: PAL.ember, landable: false, seed, oblate: 1 });
  w.star = star;
  w.bodies.push(star);

  // ---------------- three small worlds, close in
  const orbits = [520, 960, 1520].map(o => Math.round(o * (0.96 + rng.next() * 0.08)));
  star.farMass = 4 * Math.PI * Math.PI * orbits[1] * orbits[1] * orbits[1] / (1500 * 1500); // the middle world's year is 1500 s
  const kepler = (o: number): number => TAU * Math.sqrt(o * o * o / star.farMass);
  let phase = rng.next() * TAU;
  const worlds: Body[] = [];
  const geos: Geography[] = [];
  const specs: { type: 'volcanic' | 'rock' | 'ice'; radius: number; g: number; rough: number; pal: { low: number[]; mid: number[]; high: number[] }; cut: 'inner' | 'home' | null }[] = [
    { type: 'volcanic', radius: 58 + rng.int(10), g: 6.4 + rng.next() * 1.2, rough: 0.16, pal: PAL.scorched, cut: 'inner' },
    { type: 'rock', radius: 66 + rng.int(12), g: 4.8 + rng.next() * 1.0, rough: 0.12, pal: PAL.rock, cut: 'home' },
    { type: 'ice', radius: 46 + rng.int(12), g: 3.4 + rng.next() * 0.8, rough: 0.14, pal: PAL.ice, cut: null },
  ];
  for (let i = 0; i < specs.length; i++) {
    const sp = specs[i];
    const body = createBody({ name: names.world(), kind: 'planet', type: sp.type, radius: sp.radius, surfaceG: sp.g, roughness: sp.rough, orbit: { parent: star, radius: orbits[i], period: kepler(orbits[i]), phase }, palette: sp.pal, seed: seed + 101 * (i + 1), landable: true, soiMul: 5, segments: sp.cut ? clamp(Math.round(TAU * sp.radius / 5.2), 64, 160) : undefined });
    const br = makeBodyRng(seed, 31 + i); body.rotates = true; body.spin = br.sign() * (0.005 + br.next() * 0.005);
    if (sp.cut) geos.push(sculptPlanet(body, sp.cut, seed));
    w.bodies.push(body);
    worlds.push(body);
    phase += TAU / 3 * (0.7 + rng.next() * 0.6);
  }
  // one small moon on the outer world
  {
    const b = worlds[2];
    const mr = 18 + rng.int(8);
    const moon = createBody({ name: names.moon(), kind: 'moon', type: 'rock', radius: mr, surfaceG: 2.0 + rng.next(), roughness: 0.15, orbit: { parent: b, radius: b.radius * 3.0 + 30, period: 300 + rng.int(120), phase: rng.next() * TAU }, palette: PAL.rock, seed: seed + 977, soiMul: 4.5 });
    const mr2 = makeBodyRng(seed, 61); moon.rotates = true; moon.spin = mr2.sign() * 0.007;
    w.bodies.push(moon);
  }
  w.systemRadius = orbits[2] + worlds[2].soi + 500;
  for (const b of w.bodies) if (b.orbit) {
    const a = b.orbit.phase;
    b.pos.x = b.orbit.parent.pos.x + Math.cos(a) * b.orbit.radius;
    b.pos.y = b.orbit.parent.pos.y + Math.sin(a) * b.orbit.radius;
    const wv = b.orbit.angularSpeed * b.orbit.radius;
    b.vel.x = b.orbit.parent.vel.x - Math.sin(a) * wv; b.vel.y = b.orbit.parent.vel.y + Math.cos(a) * wv;
  }

  // ---------------- pads: the mine on the scorched world, a colony on the rock world
  const scorched = worlds[0], temperate = worlds[1];
  const gInner = geos.find(g => g.body === scorched)!, gRock = geos.find(g => g.body === temperate)!;
  {
    const p = addPad(scorched, 'mine', names.mine(), padAngleFor(gInner, ['mine', 'works'], 4), 4);
    p.stock = 6; p.fuel = true;
  }
  {
    const p = addPad(temperate, 'colony', names.colony(temperate.name), padAngleFor(gRock, ['colony', 'settlement'], 5), 4.5 + rng.next());
    p.population = 5 + rng.int(4); p.fuel = true; p.repair = true;
  }
  for (const g of geos) { dressPlanet(w, g, names); GEOGRAPHY.set(g.body, g); }
  for (const b of w.bodies) for (const p of b.pads) w.pads.push(p);

  // ---------------- the free port, over the rock world
  const port = createStation(w, { name: `${starName} PORT`, kind: 'outpost', parent: temperate, orbitRadius: Math.max(temperate.maxRadius + 140, temperate.radius * 3.2), period: 700 + rng.int(200), phase: rng.next() * TAU, radius: 12, spin: 0.24 });
  port.upgrades = ['tank', 'cargo', 'strafe', 'struts', 'scatter', 'sensors'];
  port.fuelPrice = 3;
  port.orePrice = 18; port.salvagePrice = 70;
  // the port sits over a mine: ore is cheap and plentiful here, parts are dear
  port.market = makeMarket({ ore: { base: 18, stock: 60, buys: true, sells: true }, salvage: { base: 70, stock: 8 } });
  w.respawnStation = port;

  // ---------------- a thin belt between the rock and ice worlds
  {
    const r0 = orbits[1], r1 = orbits[2];
    const beltR = (r0 + r1) / 2, width = Math.min(60, (r1 - r0) * 0.12);
    const n = 50 + rng.int(30);
    for (let i = 0; i < n; i++) {
      const a = rng.next() * TAU;
      const rr = beltR + (rng.next() - 0.5) * 2 * width;
      const v = Math.sqrt(star.farMass / rr) * (0.97 + rng.next() * 0.06);
      const ast = createAsteroid(w, Math.cos(a) * rr, Math.sin(a) * rr, -Math.sin(a) * v, Math.cos(a) * v, rng.next() < 0.3 ? 3 : rng.next() < 0.6 ? 2 : 1, 1);
      ast.rich = rng.chance(0.2);
    }
  }
  for (const b of w.bodies) if (b.fissures.length) markOpenings(b);
  w.asteroids = w.asteroids.filter(a => a.field === PLACED_ROCK || w.bodies.every(b => Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) > b.maxRadius + a.radius + 3));
  w.asteroids = w.asteroids.filter(a => a.field !== 1 || w.bodies.every(b => b.kind === 'star' || Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) > b.soi * 0.8));

  // ---------------- a freighter already on its way; no machines
  {
    const from = w.pads.find(p => p.kind === 'mine') ?? w.pads[0];
    const fb = from.body;
    const a = from.angle + fb.spinAngle;
    const f = spawnAiShip(w, 'freighter', 'civ', fb.pos.x + Math.cos(a) * (fb.radius * 1.6 + 30), fb.pos.y + Math.sin(a) * (fb.radius * 1.6 + 30), a, 'travel', null);
    f.ai!.home = port;
  }
  w.enemyCore = null;

  // ---------------- the player: docked at the port until the sector puts them somewhere else
  const player = createShip(w, 'kestrel', 'player', port.pos.x, port.pos.y, 0);
  player.docked = port;
  player.vel.x = port.vel.x; player.vel.y = port.vel.y;
  w.player = player;
  w.credits = 0;
  w.threat = 0;
  return w;
}
