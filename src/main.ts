import { Game } from './game/game';
import { SIM_DT } from './sim/world';
import { hashString } from './engine/math';
import type { Controls } from './engine/input';
import { forceEvent } from './sim/director';
import { spawnAiShip } from './sim/ai';
import { makeWeapon, type EventKind, type ShipKind, type WeaponKind } from './sim/world';
import { applyUpgrades, installWeapon } from './sim/upgrades';
import { damageBase } from './sim/physics';
import { attach, release } from './sim/tether';
import { emitPing } from './sim/ping';
import { bodyToWorld } from './sim/walls';
import { padWorldPos } from './sim/bodies';
import { poweredAt, socketWorld } from './sim/power';
import { structurePos } from './sim/structures';
import { checkDrive } from './sim/drive';
import { GEOGRAPHY, validatePlanet } from './gen/planet';
import { canSense, losBlocker, signature, sunlight } from './sim/sense';
import { createAsteroid, gravityAt, predictTrajectory, spawnPickup, type Trajectory } from './sim/physics';
import type { PickupKind } from './sim/world';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const periTraj: Trajectory = { pts: new Float32Array(2000), count: 0, impact: false, impactBody: null, impactX: 0, impactY: 0, impactSpeed: 0 };
/** World-space centreline of a fissure built from a path: midpoints of matching right/left vertices. */
function centreline(b: import('./sim/bodies').Body, f: import('./sim/walls').Fissure): { x: number; y: number }[] {
  const n = f.outline.length, half = n / 2;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < half; i++) {
    const a = bodyToWorld(b, f.outline[i]), c = bodyToWorld(b, f.outline[n - 1 - i]);
    out.push({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 });
  }
  return out;
}
function centrelineLocal(f: import('./sim/walls').Fissure): { x: number; y: number }[] {
  const n = f.outline.length, half = n / 2;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < half; i++) {
    const a = f.outline[i], c = f.outline[n - 1 - i];
    out.push({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 });
  }
  return out;
}
function pilgrimPeri(pil: import('./sim/bodies').Body): number {
  const w = game.world;
  predictTrajectory(w, pil.pos.x, pil.pos.y, pil.vel.x, pil.vel.y, 1, 900, 1.0, periTraj, pil);
  let m = 1e9;
  for (let i = 0; i < periTraj.count; i++) m = Math.min(m, Math.hypot(periTraj.pts[i * 2] - w.star.pos.x, periTraj.pts[i * 2 + 1] - w.star.pos.y));
  return m;
}
let game: Game;
try {
  game = new Game(canvas);
} catch (e) {
  document.body.innerHTML = `<pre style="color:#f88;font:14px monospace;padding:20px;white-space:pre-wrap">STARFALL could not start.\n\n${(e as Error).message}\n\nThis game needs a browser with WebGL2.</pre>`;
  throw e;
}
canvas.focus();

// Test harness (used by playtest scripts). Harmless for players.
const harness = {
  game,
  step(n: number): void { for (let i = 0; i < n; i++) game.simTick(SIM_DT); },
  manual(on: boolean): void { game.manual = on; },
  controls(c: Partial<Controls> | null): void {
    if (!c) { game.input.override = null; return; }
    game.input.override = { turn: 0, thrust: 0, retro: 0, strafe: 0, fire: false, boost: false, ...c };
  },
  press(code: string): void { game.input.overridePressed.add(code); },
  mode(m: string): void { game.mode = m as typeof game.mode; },
  /** Skip the title and station: put the player in flight just outside the harbour. */
  launch(): void { game.mode = 'docked'; game.launch(); },
  forceEvent(kind: string): void { forceEvent(game.world, kind as EventKind); },
  spawnEnemy(kind: string, dx: number, dy: number, mode = 'patrol'): void {
    const p = game.world.player;
    spawnAiShip(game.world, kind as ShipKind, 'enemy', p.pos.x + dx, p.pos.y + dy, Math.atan2(-dy, -dx), mode, null);
  },
  /** A civilian bound for a pad (by name) from a world point. */
  spawnCiv(kind: string, x: number, y: number, padName: string): number {
    const w = game.world;
    const pad = w.pads.find(q => q.name === padName);
    const s = spawnAiShip(w, kind as ShipKind, 'civ', x, y, 0, 'travel', null);
    s.ai!.home = pad ?? null;
    if (pad) { s.vel.x = pad.body.vel.x; s.vel.y = pad.body.vel.y; }
    return s.id;
  },
  teleport(x: number, y: number, vx = 0, vy = 0, angle = 0): void {
    const p = game.world.player;
    p.pos.x = x; p.pos.y = y; p.vel.x = vx; p.vel.y = vy; p.angle = angle; p.landed = null; p.docked = null;
    p.alive = true; p.hull = p.hullMax; game.respawnTimer = 0; game.deathTime = -1;
    game.camPos.x = x; game.camPos.y = y; game.mode = 'flight';
  },
  give(credits: number): void { game.world.credits += credits; },
  unlockAudio(): void { game.audio.unlock(); },
  kill(): void { const p = game.world.player; p.hull = 0; p.alive = false; p.lastDamageSource = 'weapon'; p.lastHitBy = 'enemy'; },
  setLives(n: number): void { game.world.lives = n; },
  winNow(): void { const c = game.world.enemyCore; if (c) { c.enemyHealth = 1; damageBase(game.world, c, 5); } },
  buyAll(): void {
    const p = game.world.player;
    for (const u of ['retro', 'strafe', 'struts', 'tank', 'engine', 'armour', 'cargo', 'gravdamp', 'sensors', 'tractor', 'heatshield']) if (!p.upgrades.includes(u)) p.upgrades.push(u);
    applyUpgrades(p);
  },
  weapon(kind: string): void { installWeapon(game.world.player, kind as WeaponKind); },
  seekers(): void { const p = game.world.player; p.secondary = { ...makeWeapon('seeker'), ammo: 6 }; },
  fireSecondaryNow(): void { game.input.overridePressed.add('KeyX'); },
  raw(): unknown { return game.world; },
  tether(): boolean { const p = game.world.player; if (p.tether) { release(game.world, p); return false; } return attach(game.world, p); },
  /** The jump drive from the test bench: fit it, aim it, hold it, read its gates. */
  drive(target: string | null): void { const p = game.world.player; if (!p.upgrades.includes('drive')) { p.upgrades.push('drive'); applyUpgrades(p); } p.drive.target = target; },
  charge(on: boolean): void { game.harnessCharge = on; },
  driveCheck(): unknown { return checkDrive(game.world, game.sector, game.world.player); },
  sector(): unknown { const s = game.sector; return { time: s.time, current: s.current, systems: s.systems.map(r => ({ id: r.id, name: r.name, tag: r.tag, trait: r.trait, x: r.x, y: r.y })), ledgers: s.ledgers }; },
  ping(): void { const p = game.world.player; emitPing(game.world, p.pos.x, p.pos.y, false, undefined, p); },
  transfer(on: boolean): void { game.harnessTransfer = on; },
  spawnPilgrim(): void { game.world.slices.pilgrimSpawnAt = 0; },
  spawnCrate(dx: number, dy: number, kind = 'salvage', vx = 0, vy = 0): void { const p = game.world.player; spawnPickup(game.world, kind as PickupKind, p.pos.x + dx, p.pos.y + dy, p.vel.x + vx, p.vel.y + vy, 45); },
  spawnRock(dx: number, dy: number, size = 2): void { const p = game.world.player; createAsteroid(game.world, p.pos.x + dx, p.pos.y + dy, p.vel.x, p.vel.y, size, -1); },
  spawnRockAt(x: number, y: number, vx: number, vy: number, size = 2): number { const a = createAsteroid(game.world, x, y, vx, vy, size, -1); return a.id; },
  forceFlare(): void { const w = game.world; w.flare.warned = true; w.flare.timer = 2; w.flare.active = false; w.flare.intensity = 0; },
  sun(x: number, y: number, nx = 0, ny = 0): number { return sunlight(game.world, x, y, nx || ny ? { x: nx, y: ny } : null); },
  los(ax: number, ay: number, bx: number, by: number): string | null { return losBlocker(game.world, ax, ay, bx, by); },
  /** Which enemies currently sense the player, and which the player senses. */
  sense(): unknown {
    const w = game.world, p = w.player;
    const rows: Record<string, unknown>[] = w.ships.filter(s => s.alive && s !== p).map(s => {
      const range = s.kind === 'sentinel' ? ((s.ai?.home as import('./sim/bodies').Pad | null)?.mast?.alive ? 260 : 80) : s.kind === 'wasp' ? 320 : s.kind === 'lancer' ? 300 : 120;
      return { kind: s.kind, id: s.id, x: s.pos.x, y: s.pos.y, d: Math.hypot(s.pos.x - p.pos.x, s.pos.y - p.pos.y), seesPlayer: canSense(w, s.pos.x, s.pos.y, range, p), blocker: losBlocker(w, s.pos.x, s.pos.y, p.pos.x, p.pos.y), playerSees: w.time - s.sensedAt < 0.3, target: s.ai?.target ? s.ai.target.name : null, mode: s.ai?.mode ?? null, heat: s.heat, overheated: s.overheated, powered: s.landed ? poweredAt(w, s.landed.body, s.pos.x, s.pos.y) : null };
    });
    rows.push({ kind: 'player', id: p.id, x: p.pos.x, y: p.pos.y, heat: p.heat, overheated: p.overheated, signature: signature(w, p), thrusting: p.thrusting });
    return rows;
  },
  /** Installations: every enemy base with its structures, power and guns. */
  bases(): unknown {
    const w = game.world;
    return w.pads.filter(p => p.kind === 'enemybase' || p.kind === 'core').map(pad => {
      const pp = padWorldPos(pad, 2);
      const guns = w.ships.filter(s => s.alive && s.kind === 'sentinel' && s.ai?.home === pad);
      const str = (s: import('./sim/structures').Structure | null) => s ? { alive: s.alive, integrity: s.integrity, ...structurePos(s), hot: s.hot } : null;
      const src = w.power.find(q => q.plant === pad.plant && pad.plant) ?? w.power.find(q => q.body === pad.body && q.range === Infinity) ?? null;
      const n = { x: pp.x - pad.body.pos.x, y: pp.y - pad.body.pos.y }; const nl = Math.hypot(n.x, n.y) || 1;
      return { name: pad.name, body: pad.body.name, alive: pad.alive, hp: pad.enemyHealth, x: pp.x, y: pp.y, angle: Math.atan2(n.y, n.x), powered: poweredAt(w, pad.body, pp.x, pp.y), sun: sunlight(w, pp.x, pp.y, { x: n.x / nl, y: n.y / nl }), plant: str(pad.plant), radiator: str(pad.radiator), mast: str(pad.mast),
        socket: src ? { ...socketWorld(src), powered: src.powered, broken: src.broken, core: src.core ? src.core.name : null, range: src.range } : null,
        guns: guns.map(g => ({ id: g.id, x: g.pos.x, y: g.pos.y, heat: g.heat, overheated: g.overheated, target: g.ai?.target ? g.ai.target.name : null, shots: g.ai?.shotsInBurst ?? 0, hull: g.hull })) };
    });
  },
  contact(): unknown { const c = game.world.contact; return c ? { ...c, age: game.world.time - c.time } : null; },
  tracked(): number { return game.tracked; },
  signature(): number { return signature(game.world, game.world.player); },
  /** The authored places: where they are and whether the pilot has found them. */
  places(): unknown {
    const w = game.world;
    const body = (name: string) => { const b = w.bodies.find(x => x.name === name); return b ? { name, x: b.pos.x, y: b.pos.y, vx: b.vel.x, vy: b.vel.y, r: b.radius, secret: b.secret, found: w.discovered.has(name), spin: b.spinAngle, free: b.free, integrity: b.integrity, pads: b.pads.map(q => q.name) } : null; };
    const pad = (name: string) => { const q = w.pads.find(x => x.name === name); if (!q) return null; const pp = padWorldPos(q, 0); return { name, body: q.body.name, x: pp.x, y: pp.y, alive: q.alive, guns: q.guns }; };
    return { slipway: body('THE SLIPWAY'), lighthouse: body('THE LIGHTHOUSE'), hollow: body('HOLLOW'), fault: body('THE FAULT'), pilgrim: body('PILGRIM'), kiln: pad('THE KILN'), relay: pad('THE RELAY'), mike: pad('BASE MIKE'), core: pad('THE STARFALL'), logs: w.slices.logs.map(l => ({ from: l.from, alive: l.pickup.alive, line: l.line, x: l.pickup.pos.x, y: l.pickup.pos.y })), discovered: [...w.discovered] };
  },
  /** The cut worlds: motifs, pads, cave mouths and rooms in world coordinates, and any physical problems. */
  geo(): unknown {
    const w = game.world;
    return w.bodies.filter(b => GEOGRAPHY.has(b)).map(b => {
      const g = GEOGRAPHY.get(b)!;
      const wp = (l: { x: number; y: number }) => bodyToWorld(b, l);
      const ang = (a: number) => { const r = b.maxRadius; return wp({ x: Math.cos(a) * r, y: Math.sin(a) * r }); };
      return {
        name: b.name, role: g.role, x: b.pos.x, y: b.pos.y, vx: b.vel.x, vy: b.vel.y, r: b.radius, maxR: b.maxRadius, spin: b.spinAngle,
        motifs: g.motifs.map(m => ({ kind: m.kind, angle: (m.s0 + m.length / 2) / b.radius })),
        pads: b.pads.map(q => ({ name: q.name, kind: q.kind, angle: q.angle, ...padWorldPos(q, 0) })),
        mouths: g.mouths.map(a => ({ angle: a, ...ang(a) })),
        networks: g.networks.map(n => ({ name: n.name, kind: n.kind, fissures: n.fissures.length, mouths: n.mouths, entry: n.entry, chambers: n.chambers.map(c => ({ id: c.id, ...wp(c.centre), local: c.centre, r: c.r, kind: c.kind, content: c.content, depth: c.depth, shelf: [wp(c.floorA), wp(c.floorB)] })), links: n.links.map(l => ({ a: l.a, b: l.b, hw: l.hw, narrow: l.narrow, blocked: n.blocked.includes(l), pts: l.pts.map(q => ({ ...wp(q), local: q })) })), rooms: n.rooms.map(r => ({ ...wp(r.centre), local: r.centre, hw: r.hw, depth: r.depth, fissure: r.fissure.name })), points: n.points.map(pt => ({ ...wp(pt.p), local: pt.p, hw: pt.hw, fissure: pt.fissure.name })) })),
        placed: g.placed,
        problems: validatePlanet(w, b),
      };
    });
  },
  cores(): unknown { return game.world.pickups.filter(k => k.alive && k.role === 'core').map(k => ({ name: k.name, origin: k.origin, x: k.pos.x, y: k.pos.y, tethered: !!k.tetheredBy })); },
  journal(): unknown { return game.world.journal.map(e => ({ t: Math.round(e.time), key: e.key, text: e.text })); },
  log(since = 0): unknown { return game.world.log.filter(e => e.time >= since).map(e => ({ t: Math.round(e.time), kind: e.kind, text: e.text, param: e.param ?? 0 })); },
  /** Test tool: turn a world to a given rotation, carrying everything resting on it (the sim only ever turns it slowly). */
  spinTo(name: string, spinAngle: number): void {
    const w = game.world;
    const b = w.bodies.find(x => x.name === name);
    if (!b || !b.rotates) return;
    const delta = spinAngle - b.spinAngle;
    const c = Math.cos(delta), s = Math.sin(delta);
    const rot = (o: { pos: { x: number; y: number }; vel: { x: number; y: number } }) => {
      const dx = o.pos.x - b.pos.x, dy = o.pos.y - b.pos.y;
      o.pos.x = b.pos.x + dx * c - dy * s; o.pos.y = b.pos.y + dx * s + dy * c;
      const vx = o.vel.x - b.vel.x, vy = o.vel.y - b.vel.y;
      o.vel.x = b.vel.x + vx * c - vy * s; o.vel.y = b.vel.y + vx * s + vy * c;
    };
    for (const k of w.pickups) if (k.alive && !k.carriedBy && Math.hypot(k.pos.x - b.pos.x, k.pos.y - b.pos.y) < b.maxRadius + 4) rot(k);
    for (const a of w.asteroids) if (a.alive && Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) < b.maxRadius + a.radius + 2) rot(a);
    b.spinAngle = spinAngle;
  },
  bodySpin(name: string): unknown { const b = game.world.bodies.find(x => x.name === name); return b ? { spin: b.spin, spinAngle: b.spinAngle, rotates: b.rotates } : null; },
  setVel(vx: number, vy: number): void { const p = game.world.player; p.vel.x = vx; p.vel.y = vy; },
  refuel(): void { const p = game.world.player; p.fuel = p.fuelMax; },
  heal(): void { const p = game.world.player; p.hull = p.hullMax; },
  gravity(x: number, y: number): [number, number] { const g = { x: 0, y: 0 }; gravityAt(game.world, x, y, g); return [g.x, g.y]; },
  audio(): string[] { return game.audioLog.splice(0); },
  slice(): unknown {
    const w = game.world, S = w.slices, p = w.player;
    const reg = S.regulator;
    const sp = reg && S.cutBody && reg.socketLocal ? bodyToWorld(S.cutBody, reg.socketLocal) : null;
    const pil = S.pilgrim;
    return {
      cut: S.cutBody ? { body: S.cutBody.name, powered: S.cutPowered, entered: S.cutEntered, path: S.cutFissure ? centreline(S.cutBody, S.cutFissure) : null, pathLocal: S.cutFissure ? centrelineLocal(S.cutFissure) : null, bodyPos: { x: S.cutBody.pos.x, y: S.cutBody.pos.y }, regulator: reg ? { x: reg.pos.x, y: reg.pos.y, tethered: !!reg.tetheredBy, socketDist: sp ? Math.hypot(reg.pos.x - sp.x, reg.pos.y - sp.y) : null } : null, mouth: S.cutFissure ? bodyToWorld(S.cutBody, S.cutFissure.outline[0]) : null, outline: S.cutFissure ? S.cutFissure.outline.map(v => bodyToWorld(S.cutBody!, v)) : null } : null,
      pilgrim: pil ? { x: pil.pos.x, y: pil.pos.y, vx: pil.vel.x, vy: pil.vel.y, angle: pil.spinAngle, angVel: pil.angVel, integrity: pil.integrity, saved: S.pilgrimSaved, lost: S.pilgrimLost, thrusters: pil.thrusters.map(t => ({ name: t.name, fuel: t.fuel, pad: padWorldPos(t.pad, 0) })), starDist: Math.hypot(pil.pos.x - w.star.pos.x, pil.pos.y - w.star.pos.y) } : { lost: S.pilgrimLost, spawnAt: S.pilgrimSpawnAt },
      signal: { rock: S.rock ? { x: S.rock.pos.x, y: S.rock.pos.y, r: S.rock.radius, vx: S.rock.vel.x, vy: S.rock.vel.y, path: S.rock.fissures[0] ? centreline(S.rock, S.rock.fissures[0]) : null, pathLocal: S.rock.fissures[0] ? centrelineLocal(S.rock.fissures[0]) : null } : null, box: S.blackBox ? { alive: S.blackBox.alive, x: S.blackBox.pos.x, y: S.blackBox.pos.y } : null, logPlayed: S.logPlayed, logLine: S.logLine },
      fault: { onBeat: S.faultOnBeat, offBeat: S.faultOffBeat, cooldownUntil: S.faultCooldownUntil, answer: S.faultAnswerKind, answerAt: S.faultAnswerAt, phase: (w.time % 3) / 3, stillUntil: S.tideStillUntil, calledUntil: S.tideCalledUntil },
      tether: p.tether ? { kind: p.tether.kind, length: p.tether.length, tension: p.tether.tension, peak: p.tether.peak, stretch: p.tether.stretch } : null,
      pings: w.pings.length,
      pilgrimPeri: pil ? pilgrimPeri(pil) : null,
    };
  },
  nav(name: string): void {
    const w = game.world;
    const st = w.stations.find(s => s.name === name);
    const b = w.bodies.find(s => s.name === name);
    game.navTarget = st ? { name, station: st } : b ? { name, body: b } : null;
  },
  newGame(seed: string | number): void { game.newGame(typeof seed === 'number' ? seed : hashString(seed), String(seed)); },
  state(): unknown {
    const w = game.world;
    const p = w.player;
    return {
      time: w.time,
      tick: w.tick,
      player: {
        x: p.pos.x, y: p.pos.y, vx: p.vel.x, vy: p.vel.y, angle: p.angle, hull: p.hull, fuel: p.fuel,
        alive: p.alive, landed: p.landed ? { body: p.landed.body.name, pad: p.landed.pad?.name ?? null } : null,
        docked: p.docked ? p.docked.name : null, speed: Math.hypot(p.vel.x, p.vel.y),
        cargo: p.cargo, heat: p.heat, overheated: p.overheated, lastDamageSource: p.lastDamageSource, tethered: !!p.tether, stunned: p.stunned,
      },
      bodies: w.bodies.map(b => ({ name: b.name, kind: b.kind, x: b.pos.x, y: b.pos.y, r: b.radius, pads: b.pads.map(pd => ({ name: pd.name, kind: pd.kind, angle: pd.angle, alive: pd.alive, pop: pd.population })) })),
      stations: w.stations.map(s => ({ name: s.name, x: s.pos.x, y: s.pos.y, vx: s.vel.x, vy: s.vel.y, angle: s.angle, spin: s.spin, r: s.radius, alive: s.alive })),
      ships: w.ships.filter(s => s.alive).map(s => ({ kind: s.kind, faction: s.faction, x: s.pos.x, y: s.pos.y, vx: s.vel.x, vy: s.vel.y, hull: s.hull, mode: s.ai?.mode ?? null, wave: s.ai?.wave ?? 0, carrying: !!s.ai?.carrying, heat: s.heat, overheated: s.overheated, sensed: w.time - s.sensedAt < 0.3 })),
      asteroids: w.asteroids.length,
      journal: w.journal.length,
      structures: w.structures.filter(s => s.alive).length,
      projectiles: w.projectiles.length,
      pickups: w.pickups.filter(p => p.alive).map(p => ({ kind: p.kind, name: p.name, x: p.pos.x, y: p.pos.y, vx: p.vel.x, vy: p.vel.y, tethered: !!p.tetheredBy })),
      events: w.events.map(e => ({ kind: e.kind, label: e.label, timer: e.timer, resolved: e.resolved, failed: e.failed, phase: e.phase })),
      comms: w.comms.slice(-8).map(c => `${c.from}: ${c.text}`),
      score: w.score, credits: w.credits, lives: w.lives, threat: w.threat, kills: w.kills, gameOver: w.gameOver,
      frameTime: game.frameTime, frameCount: game.frameCount,
      cam: { x: game.camPos.x, y: game.camPos.y, h: game.camHeight },
      mode: game.mode,
      underground: game.underground ? game.underground.name : null,
      system: w.systemId,
      sectorTime: game.sector ? game.sector.time : 0,
      nav: game.navTarget?.name ?? null,
      pads: w.pads.map(pd => ({ name: pd.name, kind: pd.kind, body: pd.body.name, alive: pd.alive, pop: pd.population, stock: pd.stock, hp: pd.enemyHealth, angle: pd.angle, height: pd.height })),
    };
  },
};
(window as unknown as { __sf: typeof harness }).__sf = harness;

game.start();
