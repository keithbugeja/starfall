// Star system generation. One dense, designed system per seed: a star, a handful of distinct worlds,
// moons, belts, three stations, colonies and mines to protect, derelicts to find, and an enemy foothold.
import { Rng, TAU } from '../engine/math';
import { addPad, createBody, resetBodyIds, type Body, type Pad, type PlanetType } from '../sim/bodies';
import { createAsteroid, spawnPickup } from '../sim/physics';
import { createStation } from '../sim/stations';
import { createEmptyWorld, createShip, type World } from '../sim/world';
import { makeNamer } from './names';
import { spawnAiShip } from '../sim/ai';

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
  const star = createBody({ name: starName, kind: 'star', type: 'star', radius: starR, surfaceG: 13 + rng.next() * 4, soiMul: 22, palette: PALETTES.star, landable: false, seed, oblate: 1 });
  w.star = star;
  w.bodies.push(star);

  // ---------------- planets
  const planetCount = 5 + (rng.chance(0.35) ? 1 : 0);
  const plans: PlanetPlan[] = [];
  let orbit = 780 + rng.int(120);
  const roles: PlanetPlan['role'][] = planetCount === 6 ? ['inner', 'home', 'mid', 'gas', 'outer', 'enemy'] : ['inner', 'home', 'mid', 'gas', 'enemy'];
  // sometimes the gas giant is the outermost and the enemy sits on a mid world
  if (rng.chance(0.3)) { const gi = roles.indexOf('gas'); const ei = roles.indexOf('enemy'); roles[gi] = 'enemy'; roles[ei] = 'gas'; }
  let phase = rng.next() * TAU;
  for (let i = 0; i < planetCount; i++) {
    const role = roles[i];
    let type: PlanetType, radius: number, g: number, rough: number, pal: { low: number[]; mid: number[]; high: number[] };
    switch (role) {
      case 'inner': type = rng.chance(0.6) ? 'volcanic' : 'desert'; radius = 62 + rng.int(28); g = type === 'volcanic' ? 6.5 + rng.next() * 1.5 : 4.8 + rng.next(); rough = type === 'volcanic' ? 0.16 : 0.09; pal = PALETTES[type]; break;
      case 'home': type = 'rock'; radius = 82 + rng.int(24); g = 5.6 + rng.next() * 1.2; rough = 0.11; pal = rng.chance(0.5) ? PALETTES.rock : PALETTES.rock2; break;
      case 'mid': type = rng.chance(0.5) ? 'desert' : 'crystal'; radius = 60 + rng.int(35); g = type === 'desert' ? 4.6 + rng.next() : 3.6 + rng.next(); rough = type === 'desert' ? 0.08 : 0.14; pal = PALETTES[type]; break;
      case 'gas': type = 'gas'; radius = 150 + rng.int(40); g = 9 + rng.next() * 2; rough = 0; pal = rng.pick([PALETTES.gas, PALETTES.gas2, PALETTES.gas3]); break;
      case 'outer': type = 'ice'; radius = 55 + rng.int(30); g = 3.2 + rng.next(); rough = 0.07; pal = PALETTES.ice; break;
      default: type = rng.chance(0.5) ? 'ice' : 'rock'; radius = 70 + rng.int(30); g = 4.5 + rng.next() * 1.5; rough = 0.13; pal = type === 'ice' ? PALETTES.ice : PALETTES.rock2; break;
    }
    const period = 1500 + orbit * 1.4 + rng.int(800);
    const body = createBody({ name: role === 'enemy' ? names.world() : names.world(), kind: type === 'gas' ? 'gas' : 'planet', type, radius, surfaceG: g, roughness: rough, orbit: { parent: star, radius: orbit, period, phase }, palette: pal, seed: seed + 101 * (i + 1), landable: type !== 'gas', soiMul: type === 'gas' ? 5.5 : 7 });
    w.bodies.push(body);
    const plan: PlanetPlan = { body, role, moons: [] };
    plans.push(plan);
    // moons
    const moonCount = type === 'gas' ? 2 + rng.int(2) : role === 'inner' ? 0 : rng.int(2) + (role === 'home' ? 1 : 0);
    let mOrbit = radius * 2.8 + 40;
    for (let m = 0; m < moonCount; m++) {
      const mr = 22 + rng.int(18);
      const moon = createBody({ name: names.moon(), kind: 'moon', type: rng.chance(0.5) ? 'ice' : 'rock', radius: mr, surfaceG: 2.2 + rng.next() * 1.4, roughness: 0.12 + rng.next() * 0.06, orbit: { parent: body, radius: mOrbit, period: 260 + mOrbit * 1.2 + rng.int(200), phase: rng.next() * TAU }, palette: rng.chance(0.5) ? PALETTES.ice : PALETTES.rock2, seed: seed + 977 * (i + 1) + m * 31, soiMul: 4.5 });
      w.bodies.push(moon);
      plan.moons.push(moon);
      mOrbit += mr * 3 + 70 + rng.int(40);
    }
    orbit = Math.round(orbit * (1.42 + rng.next() * 0.16)) + (type === 'gas' ? 150 : 0);
    phase += TAU / planetCount * (0.7 + rng.next() * 0.6);
  }
  w.systemRadius = orbit * 0.85 + 300;

  // gravity anomaly: "the Fault" - tiny, brutally heavy, guards a prize
  const faultOrbit = Math.round((plans[2].body.orbit!.radius + plans[3].body.orbit!.radius) / 2);
  const fault = createBody({ name: 'THE FAULT', kind: 'planet', type: 'crystal', radius: 14, surfaceG: 60, roughness: 0.2, orbit: { parent: star, radius: faultOrbit, period: 3200, phase: rng.next() * TAU }, palette: PALETTES.fault, seed: seed + 4242, landable: false, soiMul: 16 });
  w.bodies.push(fault);
  plans.push({ body: fault, role: 'fault', moons: [] });

  // initial orbital positions (parents first: bodies array is in creation order, parents precede children)
  for (const b of w.bodies) if (b.orbit) {
    const a = b.orbit.phase;
    b.pos.x = b.orbit.parent.pos.x + Math.cos(a) * b.orbit.radius;
    b.pos.y = b.orbit.parent.pos.y + Math.sin(a) * b.orbit.radius;
    // orbital velocity for landed/relative motion
    const wv = b.orbit.angularSpeed * b.orbit.radius;
    b.vel.x = b.orbit.parent.vel.x - Math.sin(a) * wv; b.vel.y = b.orbit.parent.vel.y + Math.cos(a) * wv;
  }

  // ---------------- pads
  const home = plans.find(p => p.role === 'home')!;
  const inner = plans.find(p => p.role === 'inner')!;
  const mid = plans.find(p => p.role === 'mid')!;
  const gas = plans.find(p => p.role === 'gas')!;
  const enemy = plans.find(p => p.role === 'enemy')!;
  const outer = plans.find(p => p.role === 'outer');
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
    p.stock = 2 + rng.int(4); p.fuel = true;
    return p;
  };
  // home world: two colonies and a mine
  {
    const a = spreadAngles(3, rng);
    colony(home.body, a[0]); colony(home.body, a[1]); mine(home.body, a[2]);
    for (const m of home.moons) mine(m, rng.next() * TAU);
  }
  // mid world: colony + mine (+ derelict on a moon)
  {
    const a = spreadAngles(2, rng);
    colony(mid.body, a[0]); mine(mid.body, a[1]);
    if (mid.moons.length) { const d = addPad(mid.moons[0], 'derelict', names.derelict(), rng.next() * TAU, 4); d.stock = 1; }
  }
  // inner world: a hardy colony and a mine in the heat
  {
    const a = spreadAngles(2, rng);
    colony(inner.body, a[0]).population = 4 + rng.int(3);
    mine(inner.body, a[1]).stock = 5;
  }
  // gas giant moons: mine + derelict
  if (gas.moons.length) {
    mine(gas.moons[0], rng.next() * TAU).stock = 4;
    if (gas.moons.length > 1) { const d = addPad(gas.moons[1], 'derelict', names.derelict(), rng.next() * TAU, 4); d.stock = 1; }
  }
  if (outer) {
    colony(outer.body, rng.next() * TAU).population = 5;
    for (const m of outer.moons) { const d = addPad(m, 'derelict', names.derelict(), rng.next() * TAU, 4); d.stock = 1; }
  }
  // enemy world: the Starfall site (core) and two bases
  {
    const a = spreadAngles(3, rng);
    const core = addPad(enemy.body, 'core', 'THE STARFALL', a[0], 6);
    core.enemyHealth = 1400; core.spawnTimer = 30;
    w.enemyCore = core;
    for (let i = 1; i < 3; i++) { const b = addPad(enemy.body, 'enemybase', `BASE ${i === 1 ? 'KILO' : 'LIMA'}`, a[i], 5); b.enemyHealth = 420; b.spawnTimer = 20 + i * 15; }
    for (const m of enemy.moons) { const b = addPad(m, 'enemybase', 'BASE MIKE', rng.next() * TAU, 5); b.enemyHealth = 320; b.spawnTimer = 40; }
  }
  for (const b of w.bodies) for (const p of b.pads) w.pads.push(p);

  // ---------------- stations
  /** Pick a station orbit radius around a parent that stays clear of its moons' orbits. */
  const clearOrbit = (parent: Body, wanted: number): number => {
    const moons = w.bodies.filter(b => b.kind === 'moon' && b.orbit && b.orbit.parent === parent);
    const minR = parent.maxRadius + 70;
    let r = Math.max(wanted, minR);
    for (let i = 0; i < 6; i++) {
      let moved = false;
      for (const m of moons) {
        const mr = m.orbit!.radius;
        const gap = m.maxRadius + 95;
        if (Math.abs(r - mr) < gap) {
          // prefer the inside of the moon's orbit (closer to port), else outside
          r = (mr - gap >= minR) ? mr - gap : mr + gap;
          moved = true;
        }
      }
      if (!moved) break;
    }
    return r;
  };
  const harbour = createStation(w, { name: names.station('harbour', home.body.name), kind: 'harbour', parent: home.body, orbitRadius: clearOrbit(home.body, home.body.radius * 2.4), period: 900 + rng.int(300), phase: rng.next() * TAU, radius: 14 });
  harbour.upgrades = ['retro', 'strafe', 'struts', 'tank', 'armour', 'scatter', 'mass', 'seeker', 'sensors', 'cargo'];
  const refineryHost = gas.moons.length ? gas.body : mid.body;
  const refinery = createStation(w, { name: names.station('refinery', refineryHost.name), kind: 'refinery', parent: refineryHost, orbitRadius: clearOrbit(refineryHost, refineryHost.radius * (refineryHost.kind === 'gas' ? 2.4 : 3.2)), period: 1000 + rng.int(300), phase: rng.next() * TAU, radius: 12, spin: 0.27 });
  refinery.upgrades = ['engine', 'tank', 'cargo', 'armour', 'retro', 'mass', 'heatshield', 'tractor', 'struts'];
  refinery.orePrice = 42; refinery.salvagePrice = 40;
  const researchHost = outer ? outer.body : enemy.body === plans[plans.length - 2].body ? mid.body : enemy.body;
  const research = createStation(w, { name: names.station('research', researchHost === enemy.body ? 'FAR' : researchHost.name), kind: 'research', parent: researchHost === enemy.body ? mid.body : researchHost, orbitRadius: clearOrbit(researchHost === enemy.body ? mid.body : researchHost, (researchHost === enemy.body ? mid.body : researchHost).radius * 4.0), period: 1100 + rng.int(300), phase: rng.next() * TAU, radius: 11, spin: -0.22 });
  research.upgrades = ['gravdamp', 'sensors', 'rail', 'tractor', 'heatshield', 'strafe', 'seeker'];
  research.salvagePrice = 60;
  w.respawnStation = harbour;

  // ---------------- asteroids
  // main belt between mid and gas orbits
  {
    const r0 = mid.body.orbit!.radius, r1 = gas.body.orbit!.radius;
    const beltR = (r0 + r1) / 2;
    const width = Math.min(160, (r1 - r0) * 0.22);
    const n = 170 + rng.int(60);
    for (let i = 0; i < n; i++) {
      const a = rng.next() * TAU;
      const r = beltR + (rng.next() - 0.5) * 2 * width * (0.6 + rng.next() * 0.4);
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      const v = Math.sqrt(star.mass / r) * (0.97 + rng.next() * 0.06);
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
    const cr = outer + 170;
    for (let i = 0; i < 34; i++) {
      const a = rng.next() * TAU;
      const r = cr + (rng.next() - 0.5) * 90;
      const x = b.pos.x + Math.cos(a) * r, y = b.pos.y + Math.sin(a) * r;
      const v = Math.sqrt(b.mass / r);
      const ast = createAsteroid(w, x, y, b.vel.x - Math.sin(a) * v, b.vel.y + Math.cos(a) * v, rng.next() < 0.5 ? 3 : 2, 2);
      ast.rich = rng.chance(0.25);
    }
  }
  // debris ring around the Fault: rich ore, lethal gravity
  for (let i = 0; i < 26; i++) {
    const a = rng.next() * TAU;
    const r = 70 + rng.next() * 90;
    const v = Math.sqrt(fault.mass / r);
    const ast = createAsteroid(w, fault.pos.x + Math.cos(a) * r, fault.pos.y + Math.sin(a) * r, fault.vel.x - Math.sin(a) * v, fault.vel.y + Math.cos(a) * v, rng.next() < 0.5 ? 2 : 1, 3);
    ast.rich = rng.chance(0.6);
  }
  // nothing starts inside a body
  w.asteroids = w.asteroids.filter(a => w.bodies.every(b => Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) > b.maxRadius + a.radius + 3));
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
    const a = from.angle;
    const f = spawnAiShip(w, 'freighter', 'civ', fb.pos.x + Math.cos(a) * (fb.radius * 1.6 + 30), fb.pos.y + Math.sin(a) * (fb.radius * 1.6 + 30), a, 'travel', null);
    f.ai!.home = rng.pick(w.stations);
  }

  // ---------------- player: docked at the harbour
  const player = createShip(w, 'kestrel', 'player', harbour.pos.x, harbour.pos.y, 0);
  player.docked = harbour;
  player.vel.x = harbour.vel.x; player.vel.y = harbour.vel.y;
  w.player = player;
  w.credits = 250;
  w.threat = 0;
  return w;
}

export type { Body };
