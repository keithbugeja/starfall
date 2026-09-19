// Star system generation. One dense, designed system per seed: a star, a handful of distinct worlds,
// moons, belts, three stations, colonies and mines to protect, derelicts to find, and an enemy foothold.
import { clamp, Rng, TAU } from '../engine/math';
import { addPad, createBody, makeBodyRng, resetBodyIds, type Body, type Pad, type PlanetType } from '../sim/bodies';
import { authorKiln, equipBase } from '../sim/installations';
import { createAsteroid, spawnPickup } from '../sim/physics';
import { addPowerSource } from '../sim/power';
import { bodyToWorld } from '../sim/walls';
import { createStation } from '../sim/stations';
import { createEmptyWorld, createShip, type World } from '../sim/world';
import { makeNamer } from './names';
import { spawnAiShip } from '../sim/ai';
import { authorSlices } from '../sim/slices';
import { makeMarket } from '../sim/market';
import { markOpenings } from '../sim/walls';
import { dressPlanet, GEOGRAPHY, padAngleFor, PLACED_ROCK, sculptPlanet, type Geography } from './planet';

const PALETTES: Record<string, { low: number[]; mid: number[]; high: number[] }> = {
  rock: { low: [0.36, 0.28, 0.24], mid: [0.58, 0.48, 0.38], high: [0.74, 0.7, 0.64] },
  rock2: { low: [0.3, 0.32, 0.3], mid: [0.5, 0.55, 0.48], high: [0.72, 0.74, 0.66] },
  ice: { low: [0.4, 0.55, 0.72], mid: [0.66, 0.8, 0.92], high: [0.95, 0.97, 1.0] },
  volcanic: { low: [0.95, 0.28, 0.06], mid: [0.26, 0.2, 0.2], high: [0.4, 0.36, 0.34] },
  desert: { low: [0.66, 0.4, 0.18], mid: [0.86, 0.64, 0.34], high: [0.96, 0.86, 0.6] },
  crystal: { low: [0.22, 0.32, 0.5], mid: [0.42, 0.58, 0.8], high: [0.78, 0.9, 1.0] },
  gas: { low: [0.84, 0.58, 0.32], mid: [0.95, 0.8, 0.55], high: [0.68, 0.42, 0.28] },
  gas2: { low: [0.32, 0.48, 0.74], mid: [0.55, 0.7, 0.9], high: [0.28, 0.32, 0.58] },
  gas3: { low: [0.5, 0.7, 0.55], mid: [0.75, 0.9, 0.7], high: [0.35, 0.5, 0.4] },
  star: { low: [1.8, 1.3, 0.5], mid: [1.8, 1.3, 0.5], high: [1.8, 1.3, 0.5] },
  fault: { low: [0.08, 0.02, 0.12], mid: [0.16, 0.05, 0.22], high: [0.35, 0.1, 0.45] },
};

interface PlanetPlan {
  body: Body;
  role: 'home' | 'inner' | 'mid' | 'outer' | 'gas' | 'enemy' | 'fault';
  moons: Body[];
}

export function generateSystem(seed: number, seedName: string): World {
  resetBodyIds();
  const w = createEmptyWorld(seed, seedName);
  const rng = new Rng(seed);
  const names = makeNamer(rng.fork());

  // ---------------- star
  const starName = names.star();
  const starR = 200 + rng.int(50);
  const star = createBody({ name: starName, kind: 'star', type: 'star', radius: starR, surfaceG: 13 + rng.next() * 4, soiMul: 3.0, palette: PALETTES.star, landable: false, seed, oblate: 1 });
  w.star = star;
  w.bodies.push(star);

  // ---------------- planets: five worlds in fixed roles. Their rails obey the star's weak far field, so
  // free things (rocks, pods, hulls) keep station with them; the star's deep near well ends at 3.5 radii.
  const plans: PlanetPlan[] = [];
  const geos = new Map<string, Geography>();
  const roles: PlanetPlan['role'][] = ['inner', 'home', 'mid', 'gas', 'enemy'];
  const orbits = [1050, 1900, 2800, 4200, 5700].map(r => Math.round(r * (0.98 + rng.next() * 0.04)));
  const homeOrbit = orbits[1];
  star.farMass = 4 * Math.PI * Math.PI * homeOrbit * homeOrbit * homeOrbit / (2500 * 2500); // the home world's year is 2500 s
  const kepler = (r: number): number => TAU * Math.sqrt(r * r * r / star.farMass);
  let phase = rng.next() * TAU;
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i];
    const orbit = orbits[i];
    let type: PlanetType, radius: number, g: number, rough: number, pal: { low: number[]; mid: number[]; high: number[] };
    switch (role) {
      case 'inner': type = 'volcanic'; radius = 66 + rng.int(14); g = 6.5 + rng.next() * 1.5; rough = 0.16; pal = PALETTES.volcanic; break;
      case 'home': type = 'rock'; radius = 86 + rng.int(16); g = 5.6 + rng.next() * 1.2; rough = 0.11; pal = rng.chance(0.5) ? PALETTES.rock : PALETTES.rock2; break;
      case 'mid': type = rng.chance(0.5) ? 'desert' : 'crystal'; radius = 68 + rng.int(20); g = type === 'desert' ? 4.6 + rng.next() : 3.6 + rng.next(); rough = type === 'desert' ? 0.08 : 0.14; pal = PALETTES[type]; break;
      case 'gas': type = 'gas'; radius = 160 + rng.int(30); g = 9 + rng.next() * 2; rough = 0; pal = rng.pick([PALETTES.gas, PALETTES.gas2, PALETTES.gas3]); break;
      default: type = 'ice'; radius = 78 + rng.int(18); g = 4.8 + rng.next() * 1.2; rough = 0.13; pal = PALETTES.ice; break;
    }
    // the home and inner worlds are cut finely: their profiles are levels, not backdrops
    const cut = role === 'home' || role === 'inner';
    const body = createBody({ name: names.world(), kind: type === 'gas' ? 'gas' : 'planet', type, radius, surfaceG: g, roughness: rough, orbit: { parent: star, radius: orbit, period: kepler(orbit), phase }, palette: pal, seed: seed + 101 * (i + 1), landable: type !== 'gas', soiMul: type === 'gas' ? 5.5 : 5, segments: cut ? clamp(Math.round(TAU * radius / 5.2), 64, 160) : undefined });
    if (type !== 'gas') { const br = makeBodyRng(seed, 31 + i); body.rotates = true; body.spin = br.sign() * (0.005 + br.next() * 0.005); }
    if (cut) geos.set(role, sculptPlanet(body, role, seed));
    w.bodies.push(body);
    const plan: PlanetPlan = { body, role, moons: [] };
    plans.push(plan);
    // moons: the home world one, the mid world one (a quiet place for a listening post), the gas giant two, the enemy world one
    const moonCount = role === 'inner' ? 0 : role === 'gas' ? 2 : 1;
    let mOrbit = role === 'home' ? radius * 4.6 + 40 : radius * 2.8 + 40;
    for (let m = 0; m < moonCount; m++) {
      const mr = 24 + rng.int(14);
      const moon = createBody({ name: names.moon(), kind: 'moon', type: rng.chance(0.5) ? 'ice' : 'rock', radius: mr, surfaceG: 2.2 + rng.next() * 1.4, roughness: 0.12 + rng.next() * 0.06, orbit: { parent: body, radius: mOrbit, period: 260 + mOrbit * 1.2 + rng.int(200), phase: rng.next() * TAU }, palette: rng.chance(0.5) ? PALETTES.ice : PALETTES.rock2, seed: seed + 977 * (i + 1) + m * 31, soiMul: 4.5 });
      { const mr2 = makeBodyRng(seed, 61 + i * 7 + m); moon.rotates = true; moon.spin = mr2.sign() * (0.005 + mr2.next() * 0.006); }
      w.bodies.push(moon);
      plan.moons.push(moon);
      mOrbit += mr * 3 + 70 + rng.int(40);
    }
    phase += TAU / roles.length * (0.7 + rng.next() * 0.6);
  }
  // gravity anomaly: "the Fault" - tiny, brutally heavy, guards a prize; at the edge of the system, past the enemy world
  const faultOrbit = Math.round(orbits[4] + plans[4].body.soi + 320);
  w.systemRadius = faultOrbit + 400;
  const fault = createBody({ name: 'THE FAULT', kind: 'planet', type: 'crystal', radius: 14, surfaceG: 60, roughness: 0.2, orbit: { parent: star, radius: faultOrbit, period: kepler(faultOrbit), phase: rng.next() * TAU }, palette: PALETTES.fault, seed: seed + 4242, landable: false, soiMul: 16 });
  w.bodies.push(fault);
  plans.push({ body: fault, role: 'fault', moons: [] });

  // the Lighthouse: a dead sun station on a slow rail inside the star's near well, its vane toward the star
  {
    const r = Math.round(starR * 2.6);
    const vane = (t: number): number => { const c = Math.abs(Math.cos(t)), s2 = Math.abs(Math.sin(t)); const n = 3.2; return Math.pow(Math.pow(c / 7, n) + Math.pow(s2 / 26, n), -1 / n); };
    const lh = createBody({ name: 'THE LIGHTHOUSE', kind: 'hull', type: 'rock', radius: 26, surfaceG: 0, roughness: 0, orbit: { parent: star, radius: r, period: 1200, phase: rng.next() * TAU }, palette: { low: [0.2, 0.2, 0.24], mid: [0.4, 0.42, 0.48], high: [0.68, 0.7, 0.78] }, seed: seed + 6161, landable: true, soiMul: 1, oblate: 0.14, rotates: true, faceParent: true, tetherable: true, profile: vane, segments: 96, secret: true });
    lh.mass = 0; lh.soi = 0;
    w.bodies.push(lh);
  }

  // initial orbital positions (parents first: bodies array is in creation order, parents precede children)
  for (const b of w.bodies) if (b.orbit) {
    const a = b.orbit.phase;
    b.pos.x = b.orbit.parent.pos.x + Math.cos(a) * b.orbit.radius;
    b.pos.y = b.orbit.parent.pos.y + Math.sin(a) * b.orbit.radius;
    const wv = b.orbit.angularSpeed * b.orbit.radius;
    b.vel.x = b.orbit.parent.vel.x - Math.sin(a) * wv; b.vel.y = b.orbit.parent.vel.y + Math.cos(a) * wv;
    if (b.faceParent) b.spinAngle = a + Math.PI;
  }

  // ---------------- pads
  const home = plans.find(p => p.role === 'home')!;
  const inner = plans.find(p => p.role === 'inner')!;
  const mid = plans.find(p => p.role === 'mid')!;
  const gas = plans.find(p => p.role === 'gas')!;
  const enemy = plans.find(p => p.role === 'enemy')!;
  const spreadAngles = (n: number, r: Rng): number[] => {
    const base = r.next() * TAU;
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(base + (i / n) * TAU + (r.next() - 0.5) * (TAU / n) * 0.5);
    return out;
  };
  const colony = (b: Body, angle: number): Pad => {
    const p = addPad(b, 'colony', names.colony(b.name), angle, 4.5 + rng.next());
    p.population = 6 + rng.int(6); p.fuel = true; p.repair = true;
    return p;
  };
  const mine = (b: Body, angle: number): Pad => {
    const p = addPad(b, 'mine', names.mine(), angle, 4);
    p.stock = 6 + rng.int(3); p.fuel = true;
    return p;
  };
  // home world: two colonies and a mine, each where the ground asks for it (a crater floor, a valley, a canyon); a mine on its moon
  {
    const g = geos.get('home')!;
    colony(home.body, padAngleFor(g, ['colony', 'settlement'], 5));
    colony(home.body, padAngleFor(g, ['colony', 'settlement'], 5));
    mine(home.body, padAngleFor(g, ['mine', 'works'], 4));
    for (const m of home.moons) mine(m, rng.next() * TAU);
  }
  // mid world: colony + mine; THE KILN goes in beside the colony later
  {
    const a = spreadAngles(2, rng);
    colony(mid.body, a[0]); mine(mid.body, a[1]);
  }
  // inner world: a hardy colony and a mine in the heat
  {
    const g = geos.get('inner')!;
    colony(inner.body, padAngleFor(g, ['colony'], 5)).population = 4 + rng.int(3);
    mine(inner.body, padAngleFor(g, ['mine', 'works'], 4)).stock = 5;
  }
  // the rest of what those two worlds hold: settlements, works, wreck fields, old plants, and the ground under them
  for (const role of ['home', 'inner']) { const g = geos.get(role)!; dressPlanet(w, g, names); GEOGRAPHY.set(g.body, g); }
  // gas giant moons: mine + derelict
  mine(gas.moons[0], rng.next() * TAU).stock = 4;
  { const d = addPad(gas.moons[1], 'derelict', names.derelict(), rng.next() * TAU, 4); d.stock = 1; }
  // enemy world: the Starfall site (core) and two bases; BASE MIKE on its moon
  {
    const a = spreadAngles(3, rng);
    const core = addPad(enemy.body, 'core', 'THE STARFALL', a[0], 6);
    core.enemyHealth = 800; core.spawnTimer = 30; core.guns = 2;
    w.enemyCore = core;
    for (let i = 1; i < 3; i++) { const b = addPad(enemy.body, 'enemybase', `BASE ${i === 1 ? 'KILO' : 'LIMA'}`, a[i], 5); b.enemyHealth = 240; b.spawnTimer = 20 + i * 15; }
    for (const m of enemy.moons) { const b = addPad(m, 'enemybase', 'BASE MIKE', rng.next() * TAU, 5); b.enemyHealth = 200; b.spawnTimer = 40; }
  }
  // THE RELAY: a listening post on the mid world's moon. No guns, no fins: a mast, a plant, a core, and launches.
  const relayPad = addPad(mid.moons[0], 'enemybase', 'THE RELAY', rng.next() * TAU, 4);
  relayPad.enemyHealth = 160; relayPad.spawnTimer = 50; relayPad.guns = 0;
  // THE KILN: an enemy gun position in a crater within reach of the mid world's colony
  const instRng = makeBodyRng(seed, 777);
  const midColony = mid.body.pads.find(p => p.kind === 'colony');
  const kiln = midColony ? authorKiln(w, mid.body, midColony, instRng) : null;
  for (const b of w.bodies) for (const p of b.pads) if (p !== kiln) w.pads.push(p);
  // every base gets the same machinery: a mast, radiator fins, and a plant unless the world's grid feeds it
  for (const p of w.pads) if ((p.kind === 'enemybase' || p.kind === 'core') && p !== kiln && !p.interior) equipBase(w, p, p.body === enemy.body, instRng, { radiator: p !== relayPad });

  // ---------------- stations
  /** Pick a station orbit radius around a parent that stays clear of its moons' orbits. */
  const clearOrbit = (parent: Body, wanted: number): number => {
    const moons = w.bodies.filter(b => b.kind === 'moon' && b.orbit && b.orbit.parent === parent);
    // never closer to the surface than ~1.3 radii: launches must not drop straight into the well
    const minR = Math.max(parent.maxRadius + 140, parent.radius * 2.3);
    const clear = (r: number): boolean => moons.every(m => Math.abs(r - m.orbit!.radius) >= m.maxRadius + 95);
    const want = Math.max(wanted, minR);
    if (clear(want)) return want;
    // the nearest clear radius to the wanted one, at or beyond the minimum, among the edges of every moon band
    const cands = moons.flatMap(m => { const mr = m.orbit!.radius, gap = m.maxRadius + 95; return [mr - gap, mr + gap]; }).filter(r => r >= minR && clear(r));
    cands.sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
    return cands.length ? cands[0] : Math.max(...moons.map(m => m.orbit!.radius + m.maxRadius + 95), minR);
  };
  const harbour = createStation(w, { name: names.station('harbour', home.body.name), kind: 'harbour', parent: home.body, orbitRadius: clearOrbit(home.body, home.body.radius * 3.4), period: 900 + rng.int(300), phase: rng.next() * TAU, radius: 14 });
  harbour.upgrades = ['drive', 'retro', 'strafe', 'struts', 'tank', 'armour', 'scatter', 'mass', 'seeker', 'sensors', 'cargo'];
  // fuel is made over the giant and imported here; repairs are cheap at the yard
  harbour.fuelPrice = 1.2;
  // the harbour takes ore and salvage at fair prices; the refinery pays for ore and sells the parts it makes; research pays for parts
  harbour.market = makeMarket({ ore: { base: 30, stock: 40 }, salvage: { base: 45, stock: 20 } });
  // start the harbour on the far side from every moon of its world so the first launch has room
  {
    const moons = home.moons;
    let bestPhase = harbour.orbit!.phase, bestSep = -1;
    for (let i = 0; i < 24; i++) {
      const ph = (i / 24) * TAU;
      let sep = Math.PI;
      for (const m of moons) {
        const d = Math.abs(Math.atan2(Math.sin(m.orbit!.phase - ph), Math.cos(m.orbit!.phase - ph)));
        if (d < sep) sep = d;
      }
      if (sep > bestSep) { bestSep = sep; bestPhase = ph; }
    }
    harbour.orbit!.phase = bestPhase;
    const a = bestPhase, r = harbour.orbit!.radius;
    harbour.pos.x = home.body.pos.x + Math.cos(a) * r; harbour.pos.y = home.body.pos.y + Math.sin(a) * r;
  }
  const refineryHost = gas.moons.length ? gas.body : mid.body;
  const refinery = createStation(w, { name: names.station('refinery', refineryHost.name), kind: 'refinery', parent: refineryHost, orbitRadius: clearOrbit(refineryHost, refineryHost.radius * (refineryHost.kind === 'gas' ? 2.4 : 3.2)), period: 1000 + rng.int(300), phase: rng.next() * TAU, radius: 12, spin: 0.27 });
  refinery.upgrades = ['engine', 'tank', 'cargo', 'armour', 'retro', 'mass', 'heatshield', 'tractor', 'struts'];
  refinery.orePrice = 42; refinery.salvagePrice = 40;
  refinery.fuelPrice = 0.8;
  refinery.market = makeMarket({ ore: { base: 42, stock: 30 }, salvage: { base: 28, stock: 30, buys: false, sells: true } });
  const research = createStation(w, { name: names.station('research', mid.body.name), kind: 'research', parent: mid.body, orbitRadius: clearOrbit(mid.body, mid.body.radius * 4.0), period: 1100 + rng.int(300), phase: rng.next() * TAU, radius: 11, spin: -0.22 });
  research.upgrades = ['gravdamp', 'sensors', 'rail', 'tractor', 'heatshield', 'strafe', 'seeker'];
  research.salvagePrice = 60;
  research.fuelPrice = 2;
  research.market = makeMarket({ salvage: { base: 60, stock: 10 } });
  w.respawnStation = harbour;

  // ---------------- THE SLIPWAY: a dead cruiser in a low orbit of the home world, fuel still in its bunker
  {
    const b = home.body;
    const a = 36, bHalf = 9;
    const profile = (t: number): number => { const c = Math.abs(Math.cos(t)), s2 = Math.abs(Math.sin(t)); const n = 4; const rr = Math.pow(Math.pow(c / a, n) + Math.pow(s2 / bHalf, n), -1 / n); const ang = Math.atan2(Math.sin(t), Math.cos(t)); return rr + (Math.abs(ang) < 0.14 ? 2.5 : 0) + (Math.abs(Math.abs(ang) - Math.PI) < 0.2 ? 2 : 0); };
    const hull = createBody({ name: 'THE SLIPWAY', kind: 'hull', type: 'rock', radius: a + 2.5, surfaceG: 0, roughness: 0, palette: { low: [0.24, 0.22, 0.2], mid: [0.44, 0.4, 0.36], high: [0.66, 0.62, 0.56] }, seed: seed + 7272, landable: true, soiMul: 1, oblate: 0.14, free: true, rotates: true, bodyMass: 120, inertia: 120 * (a * a + bHalf * bHalf) * 2.5, tetherable: true, profile, segments: 96, secret: true });
    hull.mass = 0; hull.soi = 0;
    const r = b.maxRadius + 36;
    const ph = harbour.orbit!.phase + 0.9;
    hull.pos.x = b.pos.x + Math.cos(ph) * r; hull.pos.y = b.pos.y + Math.sin(ph) * r;
    const v = Math.sqrt(b.mass / r);
    hull.vel.x = b.vel.x - Math.sin(ph) * v; hull.vel.y = b.vel.y + Math.cos(ph) * v;
    hull.spinAngle = ph + Math.PI / 2; hull.angVel = 0.003;
    const bunker = addPad(hull, 'outpost', 'SLIPWAY BUNKER', Math.PI / 2, 3.5); bunker.fuel = true; bunker.repair = false;
    const drive = addPad(hull, 'thruster', 'SLIPWAY DRIVE TANK', Math.PI, 3.5); drive.fuel = false;
    hull.thrusters.push({ name: 'SLIPWAY DRIVE TANK', pad: drive, dirLocal: { x: 1, y: 0 }, force: 40, fuel: 0, capacity: 60, burn: 1 });
    w.pads.push(bunker, drive);
    w.bodies.push(hull);
    (hull as unknown as { meshDirty: boolean }).meshDirty = true;
    const lp = bodyToWorld(hull, { x: 8, y: bHalf + 1.2 });
    const log = spawnPickup(w, 'log', lp.x, lp.y, hull.vel.x, hull.vel.y, 0, null, 'SLIPWAY RECORDER');
    log.radius = 0.6; log.mass = 0.2; log.glow = 0.4;
    w.slices.logs.push({ pickup: log, from: 'SLIPWAY', lines: [
      'CRUISER SLIPWAY, LAST WATCH. WE CAME IN FROM THE DARK WITH FOUR THOUSAND BEHIND US ON THE ARK.',
      'THE DRIVE LISTENED TO THAT THING ON THE OUTER WORLD AND STOPPED. THE ARK KEPT FALLING. WE COULD NOT FOLLOW.',
      'BUNKER IS FULL. TAKE WHAT YOU NEED. IF THE ARK EVER COMES ROUND AGAIN, SOMEBODY FEED HER TANKS.',
    ], line: 0, next: 0, noteKey: 'slipway-log', noteText: 'THE SLIPWAY\'S LAST WATCH SAID THEIR DRIVE STOPPED WHEN IT "LISTENED" TO SOMETHING ON THE OUTER WORLD. THE ARK THEY ESCORTED KEPT FALLING.' });
  }
  // ---------------- THE LIGHTHOUSE: a deck on its dark side, a socket with nothing in it, a recorder
  {
    const lh = w.bodies.find(x => x.name === 'THE LIGHTHOUSE')!;
    const deck = addPad(lh, 'outpost', 'LIGHTHOUSE DECK', Math.PI, 3.5); deck.fuel = false; deck.repair = false;
    w.pads.push(deck);
    addPowerSource(w, lh, { x: -9.5, y: 4.5 }, 40, 'THE LIGHTHOUSE', null);
    (lh as unknown as { meshDirty: boolean }).meshDirty = true;
    const lp = bodyToWorld(lh, { x: -9, y: -5 });
    const log = spawnPickup(w, 'log', lp.x, lp.y, lh.vel.x, lh.vel.y, 0, null, 'ARRAY RECORDER');
    log.radius = 0.6; log.mass = 0.2; log.glow = 0.4;
    w.slices.logs.push({ pickup: log, from: 'THE ARRAY', lines: [
      'SUN STATION ARRAY, MAINTENANCE LOG. THE VANE HOLDS. NOTHING BEHIND IT COOKS, NOT EVEN IN A FLARE.',
      'THE TRANSMITTER WANTS A REGULATOR IN THE SOCKET BEFORE IT WILL SPEAK. WE NEVER HAD ONE THAT FITTED.',
      'THE OLD HANDS SAID IT ONLY LISTENS ON THE PEAK. THREE TIMES. I NEVER FOUND OUT WHAT IT SAYS.',
    ], line: 0, next: 0, noteKey: 'array-log', noteText: 'THE ARRAY\'S LOG: THE VANE SHADES WHAT IS BEHIND IT EVEN IN A FLARE; THE TRANSMITTER WANTS A "REGULATOR" IN ITS SOCKET; IT "LISTENS ON THE PEAK, THREE TIMES".' });
  }

  // ---------------- asteroids
  // main belt between the mid world and the next world out (never straddling an orbit: a world that
  // sweeps through a belt rains rocks on everything it carries)
  {
    const r0 = mid.body.orbit!.radius, r1 = gas.body.orbit!.radius;
    const beltR = (r0 + r1) / 2;
    const width = Math.min(110, (r1 - r0) * 0.12);
    const n = 170 + rng.int(60);
    for (let i = 0; i < n; i++) {
      const a = rng.next() * TAU;
      const r = beltR + (rng.next() - 0.5) * 2 * width * (0.6 + rng.next() * 0.4);
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      const v = Math.sqrt(star.farMass / r) * (0.97 + rng.next() * 0.06);
      const size = rng.next() < 0.35 ? 3 : rng.next() < 0.6 ? 2 : 1;
      const ast = createAsteroid(w, x, y, -Math.sin(a) * v, Math.cos(a) * v, size, 1);
      ast.rich = rng.chance(0.12);
    }
  }
  // dense cluster beyond the home world's moons and harbour (mining ground, and a hazard on approach)
  {
    const b = home.body;
    let outer = harbour.orbit!.radius;
    for (const m of home.moons) outer = Math.max(outer, m.orbit!.radius + m.maxRadius);
    // inside the world's unfaded well (the SOI fades over its outer quarter), beyond the harbour and the moon
    const cr = b.soi * 0.5; // between the Slipway and the harbour, inside the world's unfaded well
    for (let i = 0; i < 34; i++) {
      const a = rng.next() * TAU;
      const r = cr + (rng.next() - 0.5) * 60;
      const x = b.pos.x + Math.cos(a) * r, y = b.pos.y + Math.sin(a) * r;
      const v = Math.sqrt(b.mass / r);
      const ast = createAsteroid(w, x, y, b.vel.x - Math.sin(a) * v, b.vel.y + Math.cos(a) * v, rng.next() < 0.5 ? 3 : 2, 2);
      ast.rich = rng.chance(0.25);
    }
  }
  // debris ring around the Fault: rich ore, lethal gravity
  for (let i = 0; i < 26; i++) {
    const a = rng.next() * TAU;
    const r = 42 + rng.next() * 58;
    const v = Math.sqrt(fault.mass / r);
    const ast = createAsteroid(w, fault.pos.x + Math.cos(a) * r, fault.pos.y + Math.sin(a) * r, fault.vel.x - Math.sin(a) * v, fault.vel.y + Math.cos(a) * v, rng.next() < 0.5 ? 2 : 1, 3);
    ast.rich = rng.chance(0.6);
  }
  // nothing starts inside a body, and belt rocks born inside a world's well (they would fall within seconds) are culled
  w.asteroids = w.asteroids.filter(a => a.field === PLACED_ROCK || w.bodies.every(b => Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) > b.maxRadius + a.radius + 3));
  w.asteroids = w.asteroids.filter(a => a.field !== 1 || w.bodies.every(b => b.kind === 'star' || Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) > b.soi * 0.8));
  // unique module orbiting the Fault
  {
    const a = rng.next() * TAU, r = 48;
    const v = Math.sqrt(fault.mass / r);
    spawnPickup(w, 'module', fault.pos.x + Math.cos(a) * r, fault.pos.y + Math.sin(a) * r, fault.vel.x - Math.sin(a) * v, fault.vel.y + Math.cos(a) * v, 0, null, 'GRAVITIC LENS').moduleId = 'gravlens';
  }

  // ---------------- initial traffic and enemies
  const enemyPos = enemy.body.pos;
  for (let i = 0; i < 3; i++) {
    const a = rng.next() * TAU, r = enemy.body.radius * 2 + 40 + rng.int(60);
    spawnAiShip(w, 'wasp', 'enemy', enemyPos.x + Math.cos(a) * r, enemyPos.y + Math.sin(a) * r, rng.next() * TAU, 'patrol', enemy.body);
  }
  spawnAiShip(w, 'lancer', 'enemy', enemyPos.x + enemy.body.radius * 3, enemyPos.y, 0, 'patrol', enemy.body);
  // a couple of freighters already on their way
  for (let i = 0; i < 2; i++) {
    const from = rng.pick(w.pads.filter(p => p.kind === 'colony' || p.kind === 'mine'));
    const fb = from.body;
    const a = from.angle + (fb.rotates ? fb.spinAngle : 0);
    const f = spawnAiShip(w, 'freighter', 'civ', fb.pos.x + Math.cos(a) * (fb.radius * 1.6 + 30), fb.pos.y + Math.sin(a) * (fb.radius * 1.6 + 30), a, 'travel', null);
    f.ai!.home = rng.pick(w.stations);
  }

  // ---------------- hand-authored experiences
  authorSlices(w);
  for (const b of w.bodies) if (b.fissures.length) markOpenings(b);
  // the hollow rock sits in the belt: nothing starts inside it either
  w.asteroids = w.asteroids.filter(a => a.field === PLACED_ROCK || w.bodies.every(b => Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) > b.maxRadius + a.radius + 3));

  // ---------------- player: docked at the harbour
  const player = createShip(w, 'kestrel', 'player', harbour.pos.x, harbour.pos.y, 0);
  player.docked = harbour;
  player.vel.x = harbour.vel.x; player.vel.y = harbour.vel.y;
  w.player = player;
  w.credits = 350;
  w.threat = 0;
  return w;
}

export type { Body };
