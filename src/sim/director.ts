// Director: the living system. Enemy pressure, waves from bases, events with timers and consequences,
// civilian traffic, colony and mine economies. Nothing here is a quest marker; everything is a situation.
import { TAU, type V2 } from '../engine/math';
import { contactGuess, recordContact, spawnAiShip, spawnSentinel } from './ai';
import { canSense } from './sense';
import { structurePos } from './structures';
import { addPad, padWorldAngle, padWorldPos, surfaceVelocity, terrainNormalAt, type Body, type Pad } from './bodies';
import { poweredAt } from './power';
import { equipBase } from './installations';
import { createAsteroid, damageBase, padDamaged, spawnPickup } from './physics';
import { comm, sfx, type Asteroid, type EventKind, type GameEvent, type Ship, type Station, type World } from './world';

interface DirectorState {
  initialized: boolean;
  eventTimer: number;
  trafficTimer: number;
  economyTimer: number;
  nextEventId: number;
  lastEventKind: EventKind | null;
  flareCooldown: number;
  acc: number;
  opening: number;
}

const D = new WeakMap<World, DirectorState>();

/** The part of the director's state that should survive leaving and returning to a system. */
export interface DirectorSnapshot { opening: number; eventTimer: number; flareCooldown: number; lastEventKind: EventKind | null; }
export function directorSnapshot(w: World): DirectorSnapshot { const d = state(w); return { opening: d.opening, eventTimer: d.eventTimer, flareCooldown: d.flareCooldown, lastEventKind: d.lastEventKind }; }
export function directorRestore(w: World, snap: DirectorSnapshot): void { const d = state(w); d.opening = snap.opening; d.eventTimer = Math.max(8, snap.eventTimer); d.flareCooldown = snap.flareCooldown; d.lastEventKind = snap.lastEventKind; }

function state(w: World): DirectorState {
  let d = D.get(w);
  if (!d) {
    d = { initialized: false, eventTimer: 16, trafficTimer: 20, economyTimer: 0, nextEventId: 1, lastEventKind: null, flareCooldown: 300 / Math.max(0.1, w.flareRate), acc: 0, opening: 0 };
    D.set(w, d);
  }
  return d;
}

function livingColonies(w: World): Pad[] { return w.pads.filter(p => p.alive && (p.kind === 'colony' || p.kind === 'mine')); }
function enemyBases(w: World): Pad[] { return w.pads.filter(p => p.alive && (p.kind === 'enemybase' || p.kind === 'core')); }
function dist(a: V2, b: V2): number { return Math.hypot(a.x - b.x, a.y - b.y); }

function padPos(p: Pad, alt = 0): V2 { return padWorldPos(p, alt); }

/** Push a spawn point out of any world it would start inside. */
function outsideBodies(w: World, p: V2): V2 {
  for (const b of w.bodies) { const dx = p.x - b.pos.x, dy = p.y - b.pos.y, d = Math.hypot(dx, dy); const need = (b.kind === 'star' ? b.radius * 2 : b.maxRadius) + 40; if (d < need) { p.x = b.pos.x + dx / (d || 1) * need; p.y = b.pos.y + dy / (d || 1) * need; } }
  return p;
}

/** Direction from the enemy world toward a point (so raids arrive from a consistent side). */
function fromEnemyDir(w: World, target: V2): V2 {
  const core = w.enemyCore;
  const src = core ? core.body.pos : { x: -target.x, y: -target.y };
  const dx = target.x - src.x, dy = target.y - src.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: dx / d, y: dy / d };
}

/** The director thinks at 10 Hz; the sim runs at 120. */
export function updateDirector(w: World, dt: number): void {
  const d = state(w);
  d.acc += dt;
  if (d.acc < 0.1 && d.initialized) return;
  const step = d.acc;
  d.acc = 0;
  directorStep(w, step, d);
}

function directorStep(w: World, dt: number, d: DirectorState): void {
  if (!d.initialized) {
    d.initialized = true;
    for (const b of enemyBases(w)) for (let i = 0; i < b.guns; i++) spawnSentinel(w, b, i);
    comm(w, 'CONTROL', `PATROL KESTREL, CLEARED TO LAUNCH. THE STARFALL ON ${w.enemyCore ? w.enemyCore.body.name : 'THE OUTER WORLD'} IS ACTIVE AGAIN. KEEP THE COLONIES ALIVE. KILL THE CORE WHEN YOU CAN.`, [0.6, 0.9, 1], 1);
  }
  if (w.gameOver) return;
  // threat grows with time and with the number of enemy bases; falls when bases die
  const bases = enemyBases(w);
  if (w.machinePresence > 0) w.threat += dt * (1 / 95) * (1 + bases.filter(b => !b.interior).length * 0.15);
  if (w.coreDestroyed) w.threat = Math.max(0, w.threat - dt * 0.05);

  // bases spawn waves (a gun position under the ground launches nothing)
  for (const b of bases) {
    if (b.interior) continue;
    b.spawnTimer -= dt;
    if (b.spawnTimer <= 0) {
      b.spawnTimer = Math.max(45, 120 - w.threat * 6) + w.rng.next() * 30;
      const enemiesAlive = w.ships.filter(s => s.alive && s.faction === 'enemy' && s.kind !== 'sentinel').length;
      const pp = padPos(b, 2);
      if (!poweredAt(w, b.body, pp.x, pp.y)) { w.log.push({ time: w.time, kind: 'no-launch', text: b.name, x: pp.x, y: pp.y }); continue; }
      if (enemiesAlive < 5 + Math.floor(w.threat * 0.5)) spawnWave(w, b);
    }
  }
  // a powered mast listens on its own: a base with no guns still tells the tide where you are
  if (w.player.alive && !w.player.docked) for (const b of bases) {
    const m = b.mast;
    if (!m || !m.alive) continue;
    const mp = structurePos(m);
    if (!poweredAt(w, b.body, mp.x, mp.y)) continue;
    if (canSense(w, mp.x, mp.y, 260, w.player)) recordContact(w, mp.x, mp.y, b.name + ' MAST');
  }
  // sentinels regrow slowly at bases, and powered bases rebuild broken fins and masts
  for (const b of bases) {
    const pp0 = padPos(b, 2);
    if (poweredAt(w, b.body, pp0.x, pp0.y)) for (const st of [b.radiator, b.mast]) {
      if (st && !st.alive && w.rng.chance(dt / 150)) { st.alive = true; st.integrity = st.integrityMax; st.hot = 0; w.log.push({ time: w.time, kind: 'structure-rebuilt', text: `${st.kind.toUpperCase()} AT ${b.name}`, x: pp0.x, y: pp0.y }); }
    }
    const guards = w.ships.filter(s => s.alive && s.kind === 'sentinel' && s.ai?.home === b).length;
    const pp = padPos(b, 2);
    if (guards < b.guns && poweredAt(w, b.body, pp.x, pp.y) && w.rng.chance(dt / 40)) spawnSentinel(w, b, guards);
  }

  // events
  d.eventTimer -= dt;
  if (d.eventTimer <= 0) {
    d.eventTimer = Math.max(30, 75 - w.threat * 4) + w.rng.next() * 25;
    const active = w.events.filter(e => !e.resolved && !e.failed).length;
    if (d.opening === 0) { d.opening = 1; d.eventTimer = 50; openingSalvage(w, d); }
    else if (d.opening === 1) { d.opening = 2; d.eventTimer = 60; if (w.machinePresence > 0) openingRaid(w, d); }
    else if (active < 3) spawnEvent(w, d);
  }
  d.flareCooldown -= dt;
  // a star with a short flare cadence flares on that cadence; the home star's flares stay in the event lottery
  if (w.flareRate >= 2 && d.flareCooldown <= 0 && !w.flare.active && !w.flare.warned) spawnEventOfKind(w, d, 'flare');
  updateEvents(w, dt);
  updateFlare(w, dt);

  // enemies that wandered far from everything go home
  despawnFarEnemies(w);
  // traffic
  d.trafficTimer -= dt;
  if (d.trafficTimer <= 0) {
    d.trafficTimer = 30 + w.rng.next() * 25;
    const civs = w.ships.filter(s => s.alive && s.faction === 'civ').length;
    if (civs < 4) spawnTraffic(w);
  }
  // economy
  d.economyTimer += dt;
  if (d.economyTimer > 10) {
    d.economyTimer -= 10;
    for (const p of w.pads) {
      if (!p.alive) continue;
      if (p.kind === 'mine' && p.stock < 8 && w.rng.chance(0.45)) p.stock++;
      if (p.kind === 'colony' && p.population < 12 && w.rng.chance(0.12)) p.population++;
    }
  }
}

function despawnFarEnemies(w: World): void {
  const pl = w.player;
  const inEvent = new Set<Ship>();
  for (const e of w.events) if (!e.resolved && !e.failed) for (const s of e.ships) inEvent.add(s);
  for (const s of w.ships) {
    if (!s.alive || s.faction !== 'enemy' || s.kind === 'sentinel' || inEvent.has(s)) continue;
    if (w.time - s.spawnTime < 90) continue;
    if (dist(s.pos, pl.pos) < 1500) continue;
    if (s.ai && (s.ai.mode === 'raid' || s.ai.mode === 'escape' || s.ai.mode === 'siege')) continue;
    s.alive = false; // quietly returns to base
  }
}

function spawnWave(w: World, base: Pad): void {
  const b = base.body;
  const n = w.threat < 3 ? 2 : w.threat < 7 ? 3 : 4;
  const a = padWorldAngle(base) + (w.rng.next() - 0.5) * 0.8;
  const r = b.radius * 1.6 + 20;
  const pl = w.player;
  const colonies = livingColonies(w);
  // hunt the player where the tide's sensors last had it, if that fix is fresh and reachable; else prowl a colony
  const guess = pl.alive && !pl.docked ? contactGuess(w, 45) : null;
  const target = (guess && dist(guess, b.pos) < 1400) ? guess : (colonies.length ? padPos(w.rng.pick(colonies), 40) : null);
  for (let i = 0; i < n; i++) {
    const kind = (i === n - 1 && w.threat > 3) ? 'lancer' : 'wasp';
    const s = spawnAiShip(w, kind, 'enemy', b.pos.x + Math.cos(a + i * 0.15) * (r + i * 4), b.pos.y + Math.sin(a + i * 0.15) * (r + i * 4), a, target ? 'hunt' : 'patrol', b);
    s.ai!.targetPos = target;
    s.ai!.groupId = w.nextId;
  }
  if (target && dist(target, pl.pos) < 200) comm(w, 'CONTROL', `ENEMY SIGNATURES LAUNCHING FROM ${base.name}.`, [1, 0.6, 0.4], 1, b.pos);
}

function newEvent(w: World, kind: EventKind, pos: V2, label: string, timer: number, reward: number): GameEvent {
  const e: GameEvent = { id: state(w).nextEventId++, kind, pos, target: null, ships: [], timer, duration: timer, phase: 0, resolved: false, failed: false, announced: true, label, reward, data: {}, startTime: w.time };
  w.events.push(e);
  return e;
}

/** Opening beat one: a debris field within sight of the harbour, salvage sells at the station. */
function openingSalvage(w: World, d: DirectorState): void {
  const st = w.respawnStation ?? w.stations[0];
  const b = st.orbit ? st.orbit.parent : w.bodies[1];
  const a = Math.atan2(st.pos.y - b.pos.y, st.pos.x - b.pos.x) + 0.55;
  const r = st.orbit ? st.orbit.radius : b.radius * 2.5;
  const x = b.pos.x + Math.cos(a) * r, y = b.pos.y + Math.sin(a) * r;
  const v = Math.sqrt(b.mass / r);
  const vx = b.vel.x - Math.sin(a) * v, vy = b.vel.y + Math.cos(a) * v;
  spawnPickup(w, 'wreck', x, y, vx, vy, 0, null, 'WRECK');
  for (let i = 0; i < 5; i++) {
    const aa = w.rng.next() * TAU;
    const p = spawnPickup(w, 'salvage', x + Math.cos(aa) * 5, y + Math.sin(aa) * 5, vx + Math.cos(aa) * 1.2, vy + Math.sin(aa) * 1.2, 45);
    p.life = 600;
  }
  spawnPickup(w, 'fuel', x + 3, y - 3, vx, vy, 40).life = 600;
  const e = newEvent(w, 'salvage', { x, y }, `DEBRIS FIELD NEAR ${st.name}`, 400, 0);
  e.data.n = 5;
  comm(w, 'CONTROL', `A FREIGHTER BROKE UP NEAR ${st.name} LAST NIGHT. FLY THROUGH THE DEBRIS TO COLLECT IT. IT SELLS AT ANY STATION.`, [0.6, 0.9, 1], 2, { x, y });
  d.lastEventKind = 'salvage';
}

/** Opening beat two: a raid on the nearest home colony, one reaver, one escort. */
function openingRaid(w: World, d: DirectorState): void {
  const st = w.respawnStation ?? w.stations[0];
  const colonies = livingColonies(w).filter(p => p.kind === 'colony' && p.population > 0);
  if (!colonies.length) return;
  const clear = colonies.filter(c => w.stations.every(s => dist(padPos(c), s.pos) > 230));
  const pool = clear.length ? clear : colonies;
  const target = pool.slice().sort((a, b) => dist(padPos(a), st.pos) - dist(padPos(b), st.pos))[0];
  const tp = padPos(target, 0);
  const dir = fromEnemyDir(w, tp);
  const e = newEvent(w, 'raid', tp, `RAID ON ${target.name}`, 150, 300);
  e.target = target;
  const spawn = outsideBodies(w, { x: tp.x - dir.x * 240, y: tp.y - dir.y * 240 });
  const rv = spawnAiShip(w, 'reaver', 'enemy', spawn.x, spawn.y, Math.atan2(dir.y, dir.x), 'raid', target.body);
  rv.ai!.home = target;
  e.ships.push(rv);
  const ws = spawnAiShip(w, 'wasp', 'enemy', spawn.x - dir.x * 12, spawn.y - dir.y * 12, Math.atan2(dir.y, dir.x), 'hunt', target.body);
  ws.ai!.targetPos = { x: tp.x, y: tp.y };
  e.ships.push(ws);
  e.data.popStart = target.population;
  comm(w, target.name, `DISTRESS: A REAVER IS INBOUND ON ${target.name}. IT WILL LIFT OUR PEOPLE. KESTREL, PLEASE.`, [1, 0.5, 0.3], 3, tp);
  d.lastEventKind = 'raid';
}

/** Test hook: force an event of a given kind now. */
export function forceEvent(w: World, kind: EventKind): void {
  const d = state(w);
  if (!d.initialized) updateDirector(w, 0);
  spawnEventOfKind(w, d, kind);
}

function spawnEvent(w: World, d: DirectorState): void {
  const pl = w.player;
  const colonies = livingColonies(w).filter(p => p.kind === 'colony' && p.population > 0);
  const stations = w.stations.filter(s => s.alive);
  const weights: [EventKind, number][] = [
    ['raid', colonies.length && w.machinePresence > 0 ? 3 : 0],
    ['convoy', stations.length ? 2 : 0],
    ['siege', w.threat > 4 && stations.length && w.machinePresence > 0 ? 1.2 : 0],
    ['stranded', 2],
    ['construction', w.threat > 2.5 && w.machinePresence > 0 ? 1 : 0],
    ['rogue', 1.2],
    ['salvage', 1.6],
    ['flare', d.flareCooldown <= 0 ? 1.2 : 0],
    ['hunt', w.threat > 3 && pl.alive && !pl.docked && contactGuess(w, 90) && w.machinePresence > 0 ? 1.5 : 0],
  ];
  // avoid repeating the same kind twice in a row
  const total = weights.reduce((a, [k, v]) => a + (k === d.lastEventKind ? v * 0.3 : v), 0);
  let r = w.rng.next() * total;
  let kind: EventKind = 'salvage';
  for (const [k, v] of weights) { const vv = k === d.lastEventKind ? v * 0.3 : v; if (r < vv) { kind = k; break; } r -= vv; }
  spawnEventOfKind(w, d, kind);
}

function spawnEventOfKind(w: World, d: DirectorState, kind: EventKind): void {
  const pl = w.player;
  const colonies = livingColonies(w).filter(p => p.kind === 'colony' && p.population > 0);
  const stations = w.stations.filter(s => s.alive);
  d.lastEventKind = kind;
  switch (kind) {
    case 'raid': {
      // prefer colonies away from the player: you cannot be everywhere
      const sorted = colonies.slice().sort((a, b) => dist(padPos(b), pl.pos) - dist(padPos(a), pl.pos));
      const target = w.rng.chance(0.65) ? sorted[0] : w.rng.pick(colonies);
      const tp = padPos(target, 0);
      const dir = fromEnemyDir(w, tp);
      const n = w.threat < 3 ? 1 : 2;
      const e = newEvent(w, 'raid', tp, `RAID ON ${target.name}`, 150, 300 + n * 100);
      e.target = target;
      const spawn = outsideBodies(w, { x: tp.x - dir.x * 260 + (w.rng.next() - 0.5) * 60, y: tp.y - dir.y * 260 + (w.rng.next() - 0.5) * 60 });
      for (let i = 0; i < n; i++) {
        const rv = spawnAiShip(w, 'reaver', 'enemy', spawn.x + i * 6, spawn.y + i * 6, Math.atan2(dir.y, dir.x), 'raid', target.body);
        rv.ai!.home = target;
        e.ships.push(rv);
      }
      const esc = w.threat < 2 ? 1 : 2;
      for (let i = 0; i < esc; i++) {
        const ws = spawnAiShip(w, 'wasp', 'enemy', spawn.x - dir.x * 10 + i * 5, spawn.y - dir.y * 10 - i * 5, Math.atan2(dir.y, dir.x), 'hunt', target.body);
        ws.ai!.targetPos = { x: tp.x, y: tp.y };
        e.ships.push(ws);
      }
      e.data.popStart = target.population;
      comm(w, target.name, `DISTRESS: RAIDERS INBOUND ON ${target.name}. ${n} REAVER${n > 1 ? 'S' : ''} WITH ESCORT.`, [1, 0.5, 0.3], 3, tp);
      break;
    }
    case 'convoy': {
      const from = w.rng.pick(livingColonies(w));
      const to = w.rng.pick(stations);
      const fp = padPos(from, from.body.radius * 0.5 + 40);
      const f = spawnAiShip(w, 'freighter', 'civ', fp.x, fp.y, Math.atan2(to.pos.y - fp.y, to.pos.x - fp.x), 'travel', null);
      f.ai!.home = to;
      // put it partway along the route
      const t = 0.3 + w.rng.next() * 0.3;
      f.pos.x = fp.x + (to.pos.x - fp.x) * t; f.pos.y = fp.y + (to.pos.y - fp.y) * t;
      // never inside a world: push out along the radial if the route runs through one
      for (const b of w.bodies) { const dx = f.pos.x - b.pos.x, dy = f.pos.y - b.pos.y, d = Math.hypot(dx, dy); const need = (b.kind === 'star' ? b.radius * 2 : b.maxRadius) + 30; if (d < need) { f.pos.x = b.pos.x + dx / (d || 1) * need; f.pos.y = b.pos.y + dy / (d || 1) * need; } }
      const dir = { x: to.pos.x - f.pos.x, y: to.pos.y - f.pos.y };
      const dl = Math.hypot(dir.x, dir.y) || 1;
      f.vel.x = dir.x / dl * 22; f.vel.y = dir.y / dl * 22;
      const e = newEvent(w, 'convoy', { x: f.pos.x, y: f.pos.y }, `CONVOY UNDER ATTACK`, 120, 250);
      e.target = f;
      e.ships.push(f);
      const n = w.threat < 3 ? 2 : 3;
      for (let i = 0; i < n; i++) {
        const a = w.rng.next() * TAU;
        const ws = spawnAiShip(w, i === 2 ? 'lancer' : 'wasp', 'enemy', f.pos.x + Math.cos(a) * 70, f.pos.y + Math.sin(a) * 70, a + Math.PI, 'hunt', null);
        ws.ai!.target = f; ws.ai!.mode = i === 2 ? 'pursue' : 'run'; ws.ai!.timer = 5;
        e.ships.push(ws);
      }
      comm(w, f.name + ' ' + f.id, `MAYDAY MAYDAY. FREIGHTER UNDER ATTACK EN ROUTE TO ${to.name}.`, [1, 0.6, 0.3], 3, f.pos);
      break;
    }
    case 'siege': {
      const st = w.rng.pick(stations);
      const dir = fromEnemyDir(w, st.pos);
      const sp = { x: st.pos.x - dir.x * 330, y: st.pos.y - dir.y * 330 };
      const e = newEvent(w, 'siege', { x: st.pos.x, y: st.pos.y }, `SIEGE OF ${st.name}`, 400, 1500);
      e.target = st;
      const dn = spawnAiShip(w, 'dreadnought', 'enemy', sp.x, sp.y, Math.atan2(dir.y, dir.x), 'siege', null);
      dn.ai!.home = st;
      e.ships.push(dn);
      for (let i = 0; i < 2; i++) {
        const l = spawnAiShip(w, 'lancer', 'enemy', sp.x - dir.x * 15 + (i ? 12 : -12) * dir.y, sp.y - dir.y * 15 - (i ? 12 : -12) * dir.x, Math.atan2(dir.y, dir.x), 'patrol', null);
        l.ai!.homeBody = null; l.escortOf = dn;
        e.ships.push(l);
      }
      comm(w, st.name, `ALERT: DREADNOUGHT SIGNATURE APPROACHING ${st.name}. WE CANNOT HOLD ALONE.`, [1, 0.4, 0.3], 3, st.pos);
      break;
    }
    case 'stranded': {
      // a shuttle drifting into a well
      const bodies = w.bodies.filter(b => b.kind !== 'star' && b.kind !== 'gas' && b.radius > 20);
      const b = w.rng.pick(bodies);
      const a = w.rng.next() * TAU;
      const r = b.radius * 3.2;
      const x = b.pos.x + Math.cos(a) * r, y = b.pos.y + Math.sin(a) * r;
      const sh = spawnAiShip(w, 'shuttle', 'civ', x, y, a, 'drift', null);
      sh.fuel = 0;
      // sub-orbital velocity: it will come down in a minute or so
      const v = Math.sqrt(b.mass / r) * 0.55;
      sh.vel.x = b.vel.x - Math.sin(a) * v; sh.vel.y = b.vel.y + Math.cos(a) * v;
      sh.ai!.mode = 'drift';
      const e = newEvent(w, 'stranded', { x, y }, `MAYDAY: SHUTTLE FALLING INTO ${b.name}`, 140, 220);
      e.target = sh;
      e.ships.push(sh);
      comm(w, 'SHUTTLE ' + sh.id, `MAYDAY. OUT OF FUEL, FALLING TOWARD ${b.name}. NEED 15 UNITS. COME ALONGSIDE UNDER 6 AND HOLD F.`, [1, 0.8, 0.4], 3, { x, y });
      break;
    }
    case 'construction': {
      // enemy builder heads for a free stretch of a moon or planet
      const cands = w.bodies.filter(b => b.kind === 'moon' || (b.kind === 'planet' && b.landable && b.pads.every(p => p.kind !== 'core')));
      const b = w.rng.pick(cands);
      let angle = w.rng.next() * TAU;
      for (let tries = 0; tries < 12; tries++) {
        angle = w.rng.next() * TAU;
        if (b.pads.every(p => Math.abs(Math.atan2(Math.sin(p.angle - angle), Math.cos(p.angle - angle))) * b.radius > 30)) break;
      }
      const wa = angle + (b.rotates ? b.spinAngle : 0);
      const site = { x: b.pos.x + Math.cos(wa) * (b.radius + 40), y: b.pos.y + Math.sin(wa) * (b.radius + 40) };
      const dir = fromEnemyDir(w, site);
      const builder = spawnAiShip(w, 'reaver', 'enemy', site.x - dir.x * 300, site.y - dir.y * 300, Math.atan2(dir.y, dir.x), 'build', b);
      const e = newEvent(w, 'construction', site, `ENEMY CONSTRUCTION AT ${b.name}`, 150, 500);
      e.target = null;
      e.ships.push(builder);
      e.data.body = b; e.data.angle = angle;
      builder.ai!.targetPos = site;
      const guard = spawnAiShip(w, 'wasp', 'enemy', site.x - dir.x * 310, site.y - dir.y * 290, 0, 'hunt', b);
      guard.ai!.targetPos = site;
      e.ships.push(guard);
      comm(w, 'CONTROL', `SENSORS: ENEMY CONSTRUCTOR HEADING FOR ${b.name}. A NEW BASE MEANS MORE RAIDS.`, [1, 0.6, 0.4], 2, site);
      break;
    }
    case 'rogue': {
      const targets: (Pad | Station)[] = [...livingColonies(w), ...stations];
      const tgt = w.rng.pick(targets);
      const tp = 'spin' in tgt ? tgt.pos : padPos(tgt as Pad, 0);
      const a = w.rng.next() * TAU;
      const r = 520 + w.rng.next() * 200;
      const x = tp.x + Math.cos(a) * r, y = tp.y + Math.sin(a) * r;
      const ast = createAsteroid(w, x, y, 0, 0, 3, -1);
      ast.radius = 5.2; ast.hp = 110; ast.rogue = true;
      // aim: straight at the target with a lead for its motion
      const tv = 'spin' in tgt ? tgt.vel : surfaceVelocity((tgt as Pad).body, tp.x, tp.y);
      const speed = 8.5;
      const tt = r / speed;
      const ax = tp.x + tv.x * tt - x, ay = tp.y + tv.y * tt - y;
      const al = Math.hypot(ax, ay) || 1;
      ast.vel.x = ax / al * speed; ast.vel.y = ay / al * speed;
      const e = newEvent(w, 'rogue', { x, y }, `ROGUE ASTEROID: ${'spin' in tgt ? tgt.name : (tgt as Pad).name}`, tt + 5, 300);
      e.target = tgt;
      e.data.asteroid = ast;
      comm(w, 'CONTROL', `TRACKING: LARGE ROCK ON COLLISION COURSE WITH ${'spin' in tgt ? tgt.name : (tgt as Pad).name}. IMPACT IN ${Math.round(tt)}S. BREAK IT UP.`, [1, 0.8, 0.4], 3, { x, y });
      break;
    }
    case 'salvage': {
      const bodies = w.bodies.filter(b => b.kind !== 'star');
      const b = w.rng.pick(bodies);
      const a = w.rng.next() * TAU;
      const r = b.radius * (2.2 + w.rng.next() * 1.5);
      const x = b.pos.x + Math.cos(a) * r, y = b.pos.y + Math.sin(a) * r;
      const v = Math.sqrt(b.mass / r);
      const vx = b.vel.x - Math.sin(a) * v, vy = b.vel.y + Math.cos(a) * v;
      spawnPickup(w, 'wreck', x, y, vx, vy, 0, null, 'WRECK');
      const n = 4 + w.rng.int(3);
      for (let i = 0; i < n; i++) {
        const aa = w.rng.next() * TAU;
        const p = spawnPickup(w, 'salvage', x + Math.cos(aa) * 6, y + Math.sin(aa) * 6, vx + Math.cos(aa) * 1.5, vy + Math.sin(aa) * 1.5, 45);
        p.life = 400;
      }
      if (w.rng.chance(0.3)) spawnPickup(w, 'fuel', x + 3, y - 3, vx, vy, 40).life = 400;
      const e = newEvent(w, 'salvage', { x, y }, `DEBRIS FIELD NEAR ${b.name}`, 300, 0);
      e.data.n = n;
      comm(w, 'CONTROL', `SENSORS: DEBRIS FIELD DETECTED NEAR ${b.name}. SALVAGE BEFORE IT DISPERSES.`, [0.6, 0.9, 1], 1, { x, y });
      break;
    }
    case 'flare': {
      d.flareCooldown = 360 / Math.max(0.1, w.flareRate);
      w.flare.warned = true; w.flare.timer = 28; w.flare.active = false; w.flare.intensity = 0;
      const e = newEvent(w, 'flare', { x: 0, y: 0 }, `SOLAR FLARE`, 50, 0);
      e.data.phase = 'warning';
      comm(w, w.star.name, `FLARE WARNING. RADIATION FRONT IN 28 SECONDS. GET INTO A SHADOW, LAND, OR DOCK.`, [1, 0.85, 0.3], 3, null);
      sfx(w, 'alarm', null, 1);
      break;
    }
    case 'hunt': {
      // the pack is sent to the last fix, not to the player
      const fix = contactGuess(w, 90) ?? { x: pl.pos.x, y: pl.pos.y };
      const dir = fromEnemyDir(w, fix);
      const sp = { x: fix.x - dir.x * 380, y: fix.y - dir.y * 380 };
      const e = newEvent(w, 'hunt', sp, `HUNTER PACK`, 200, 200);
      const n = 2 + Math.floor(w.threat / 3);
      for (let i = 0; i < n; i++) {
        const k = i === 0 && w.threat > 4 ? 'lancer' : 'wasp';
        const s = spawnAiShip(w, k, 'enemy', sp.x + i * 8, sp.y - i * 8, Math.atan2(dir.y, dir.x), 'hunt', null);
        s.ai!.targetPos = { x: fix.x, y: fix.y };
        e.ships.push(s);
      }
      comm(w, 'CONTROL', `WARNING: ${n} HOSTILES VECTORING ON YOUR POSITION.`, [1, 0.5, 0.3], 2, sp);
      break;
    }
  }
}

function resolve(w: World, e: GameEvent, success: boolean, msg: string, from = 'CONTROL'): void {
  if (e.resolved || e.failed) return;
  if (success) {
    e.resolved = true;
    w.stats.eventsResolved++;
    if (e.reward > 0) { w.credits += e.reward; w.score += e.reward * 2; w.colonyRep += 1; }
    comm(w, from, msg + (e.reward > 0 ? ` +${e.reward} CR` : ''), [0.6, 1, 0.7], 2);
    sfx(w, 'success', null, 0.8);
  } else {
    e.failed = true;
    w.stats.eventsFailed++;
    comm(w, from, msg, [1, 0.4, 0.3], 2);
  }
}

function updateEvents(w: World, dt: number): void {
  const pl = w.player;
  for (const e of w.events) {
    if (e.resolved || e.failed) continue;
    e.timer -= dt;
    const alive = e.ships.filter(s => s.alive);
    switch (e.kind) {
      case 'raid': {
        const target = e.target as Pad;
        const reavers = alive.filter(s => s.kind === 'reaver');
        const carrying = reavers.some(s => s.ai?.carrying);
        if (target) e.pos = padPos(target, 0);
        if (reavers.length === 0) {
          const lost = (e.data.popStart as number) - target.population - w.pickups.filter(p => p.alive && p.kind === 'pod' && p.home === target).length;
          const playerKills = e.ships.filter(s => !s.alive && s.faction === 'enemy' && s.lastHitBy === 'player').length;
          if (playerKills === 0) { e.reward = 0; resolve(w, e, lost <= 0, lost <= 0 ? `RAIDERS GONE FROM ${target.name}. NOTHING TAKEN.` : `RAID OVER. ${lost} POD${lost > 1 ? 'S' : ''} LOST FROM ${target.name}.`, target.name); }
          else if (lost <= 0) resolve(w, e, true, `RAID ON ${target.name} REPELLED. NO PODS LOST.`, target.name);
          else { e.reward = Math.round(e.reward * 0.4); resolve(w, e, true, `RAID OVER. ${lost} POD${lost > 1 ? 'S' : ''} LOST FROM ${target.name}.`, target.name); }
        } else if (!carrying && reavers.every(s => s.ai?.mode === 'patrol')) {
          resolve(w, e, false, `RAIDERS WITHDRAWN FROM ${target.name}.`, target.name);
        } else if (e.timer <= 0) {
          e.timer = 60; // keep tracking while reavers exist
        }
        // escaping reaver: keep the marker on it
        const esc = reavers.find(s => s.ai?.mode === 'escape' && s.ai.carrying);
        if (esc) { e.pos = { x: esc.pos.x, y: esc.pos.y }; e.label = `REAVER ESCAPING WITH POD`; } else e.label = `RAID ON ${target.name}`;
        break;
      }
      case 'convoy': {
        const f = e.target as Ship;
        if (f.alive) e.pos = { x: f.pos.x, y: f.pos.y };
        const attackers = alive.filter(s => s.faction === 'enemy');
        if (!f.alive && !f.docked) resolve(w, e, false, `THE FREIGHTER IS GONE. SALVAGE WHAT YOU CAN.`);
        else if (f.docked) resolve(w, e, true, `FREIGHTER MADE IT IN. THANK YOU, KESTREL.`);
        else if (attackers.length === 0) resolve(w, e, true, `CONVOY CLEAR. ATTACKERS DESTROYED.`);
        else if (e.timer <= 0) { e.timer = 60; }
        break;
      }
      case 'siege': {
        const st = e.target as Station;
        const dn = e.ships.find(s => s.kind === 'dreadnought');
        if (!st.alive) resolve(w, e, false, `${st.name} HAS FALLEN.`);
        else if (dn && !dn.alive) { resolve(w, e, true, `SIEGE BROKEN. ${st.name} STANDS.`, st.name); w.stats.basesDestroyed += 0; }
        else if (e.timer <= 0) { e.timer = 120; }
        break;
      }
      case 'stranded': {
        const sh = e.target as Ship;
        if (!sh.alive) { resolve(w, e, false, `SHUTTLE LOST. NO SURVIVORS.`); break; }
        e.pos = { x: sh.pos.x, y: sh.pos.y };
        if (sh.fuel > 0) {
          resolve(w, e, true, `SHUTTLE REFUELLED. "WE OWE YOU ONE, KESTREL."`, 'SHUTTLE ' + sh.id);
          sh.ai!.mode = 'travel';
          sh.ai!.home = w.rng.pick(w.stations.filter(s => s.alive)) ?? null;
          w.rescued++;
          break;
        }
        // player refuel by gentle contact
        if (pl.alive && !pl.docked) {
          const d = dist(pl.pos, sh.pos);
          const rel = Math.hypot(pl.vel.x - sh.vel.x, pl.vel.y - sh.vel.y);
          if (d < pl.radius + sh.radius + 1.6 && rel < 6 && pl.transferHeld) {
            if (pl.fuel >= 15) { pl.fuel -= 15; sh.fuel = 40; sfx(w, 'pickup', sh.pos, 1, 2); }
            else if (w.tick % 120 === 0) comm(w, 'SHUTTLE ' + sh.id, 'YOU DO NOT HAVE 15 UNITS TO SPARE.', [1, 0.7, 0.3], 1);
          }
        }
        if (e.timer <= 0) resolve(w, e, false, `LOST CONTACT WITH THE SHUTTLE.`);
        break;
      }
      case 'construction': {
        const builder = e.ships[0];
        const b = e.data.body as Body;
        const angle = e.data.angle as number;
        if (!builder.alive) { resolve(w, e, true, `CONSTRUCTOR DESTROYED. ${b.name} STAYS OURS.`); break; }
        // builder flies to the site and then 'lands' by proximity to the surface point
        const wa = angle + (b.rotates ? b.spinAngle : 0);
        const site = { x: b.pos.x + Math.cos(wa) * (b.radius * 1.0 + 12), y: b.pos.y + Math.sin(wa) * (b.radius + 12) };
        e.pos = site;
        builder.ai!.targetPos = site;
        builder.ai!.mode = 'build';
        const d = dist(builder.pos, site);
        if (d < 8) {
          e.phase += dt;
          e.label = `BASE CONSTRUCTION ${Math.min(100, Math.round(e.phase / 45 * 100))}%`;
          if (e.phase > 45) {
            // base complete: carve a pad, spawn a sentinel; the renderer rebuilds the body mesh
            const pad = addPad(b, 'enemybase', `BASE ${['NOVEMBER', 'OSCAR', 'PAPA', 'QUEBEC', 'ROMEO'][w.pads.filter(p => p.kind === 'enemybase').length % 5]}`, angle, 5);
            pad.enemyHealth = 300; pad.spawnTimer = 30;
            w.pads.push(pad);
            equipBase(w, pad, w.power.some(src => src.body === b && src.range === Infinity), w.rng);
            (b as unknown as { meshDirty: boolean }).meshDirty = true;
            builder.alive = false;
            spawnSentinel(w, pad);
            resolve(w, e, false, `ENEMY BASE ESTABLISHED ON ${b.name}.`);
          }
        }
        if (e.timer <= 0 && d >= 8) resolve(w, e, true, `CONSTRUCTOR NEVER ARRIVED.`);
        break;
      }
      case 'rogue': {
        const ast = e.data.asteroid as Asteroid;
        const tgt = e.target as Pad | Station;
        const tp = 'spin' in tgt ? tgt.pos : padPos(tgt as Pad, 0);
        if (!ast.alive) {
          const hit = e.data.hit as boolean;
          const name = 'spin' in tgt ? tgt.name : (tgt as Pad).name;
          if (hit) resolve(w, e, false, `IMPACT. ${name} TOOK THE HIT.`);
          else if (ast.killedBy === 'player') resolve(w, e, true, `ROCK BROKEN UP. ${name} IS SAFE.`);
          else { e.reward = 0; resolve(w, e, true, `THE ROCK CAME DOWN ELSEWHERE. ${name} IS SAFE.`); }
          break;
        }
        e.pos = { x: ast.pos.x, y: ast.pos.y };
        const d = dist(ast.pos, tp);
        if ('spin' in tgt && d < tgt.radius + ast.radius) {
          tgt.health -= 260; ast.alive = false; e.data.hit = true;
          w.explosions.push({ pos: { x: ast.pos.x, y: ast.pos.y }, time: w.time, size: 3, color: [1, 0.7, 0.4] });
          w.screenShake = 0.5;
        } else if (!('spin' in tgt)) {
          // pad impact is handled by asteroid terrain collision; detect by asteroid death near the target
          if (d < 12 && !ast.alive) e.data.hit = true;
        }
        if (e.timer <= -10 && ast.alive) resolve(w, e, true, `THE ROCK MISSED. GRAVITY IS A FICKLE THING.`);
        // padDamaged marks the hit when the asteroid strikes; check after
        if (!ast.alive && !e.data.hit && d < 14) e.data.hit = true;
        break;
      }
      case 'salvage': {
        if (e.timer <= 0) { e.resolved = true; }
        break;
      }
      case 'flare': {
        // handled by updateFlare; resolve when over
        if (!w.flare.active && !w.flare.warned) { e.resolved = true; }
        break;
      }
      case 'hunt': {
        if (alive.length === 0) resolve(w, e, true, `HUNTER PACK DESTROYED.`);
        else { const near = alive.find(s => dist(s.pos, pl.pos) < 500); e.pos = near ? { x: near.pos.x, y: near.pos.y } : e.pos; if (e.timer <= 0) e.resolved = true; }
        break;
      }
      default: break;
    }
  }
  // trim old events
  if (w.events.length > 20) w.events.splice(0, w.events.length - 20);
}

function updateFlare(w: World, dt: number): void {
  const f = w.flare;
  if (f.warned && !f.active) {
    f.timer -= dt;
    if (f.timer <= 0) {
      f.active = true; f.warned = false; f.timer = 22; f.intensity = 1;
      comm(w, w.star.name, `RADIATION FRONT ARRIVING. HULLS IN SUNLIGHT WILL COOK.`, [1, 0.6, 0.2], 3, null);
      sfx(w, 'flare', null, 1);
    }
  } else if (f.active) {
    f.timer -= dt;
    f.intensity = f.timer > 18 ? (22 - f.timer) / 4 : f.timer < 4 ? f.timer / 4 : 1;
    if (f.timer <= 0) { f.active = false; f.intensity = 0; comm(w, w.star.name, `FLARE SUBSIDING. RADIATION LEVELS NORMAL.`, [0.6, 1, 0.7], 1); }
  }
}

function spawnTraffic(w: World): void {
  const stations = w.stations.filter(s => s.alive);
  const pads = livingColonies(w);
  if (!stations.length || !pads.length) return;
  if (w.rng.chance(0.6)) {
    // freighter from a pad to a station
    const from = w.rng.pick(pads);
    const to = w.rng.pick(stations);
    const fp = padPos(from, from.body.radius * 0.6 + 30);
    const f = spawnAiShip(w, 'freighter', 'civ', fp.x, fp.y, Math.atan2(to.pos.y - fp.y, to.pos.x - fp.x), 'travel', null);
    f.ai!.home = to;
    const n = terrainNormalAt(from.body, padWorldAngle(from));
    f.vel.x = from.body.vel.x + n.x * 12; f.vel.y = from.body.vel.y + n.y * 12;
  } else {
    // shuttle from a station to a pad
    const from = w.rng.pick(stations);
    const to = w.rng.pick(pads);
    const a = from.angle;
    const s = spawnAiShip(w, 'shuttle', 'civ', from.pos.x + Math.cos(a) * (from.radius + 6), from.pos.y + Math.sin(a) * (from.radius + 6), a, 'travel', null);
    s.ai!.home = to;
    s.vel.x = from.vel.x + Math.cos(a) * 14; s.vel.y = from.vel.y + Math.sin(a) * 14;
  }
}

export { padDamaged, damageBase };
