// Hand-authored experiences: THE CUT, PILGRIM, THE SIGNAL IN THE BELT and THE FAULT'S ANSWER.
// Nothing here is marked on the HUD; the world shows things and the player interprets them.
import { angleDiff, clamp, TAU, type V2 } from '../engine/math';
import { addPad, createBody, padWorldAngle, padWorldPos, surfaceVelocity, terrainRadiusAt, type Body, type Pad } from './bodies';
import { damageBase, damageShip, gravityAt, inShadow, padDamaged, predictTrajectory, spawnPickup, type Trajectory } from './physics';
import { bodyToWorld, fissureFromPath, notchTerrain } from './walls';
import { comm, sfx, type Pickup, type World } from './world';
import { addPowerSource, spawnCore } from './power';
import { note } from './journal';

export const TIDE_PERIOD = 3.0;

/** Shared rhythm of the tide: 0 at the peak, 0.5 at the trough. */
export function tidePhase(w: World): number { return (w.time % TIDE_PERIOD) / TIDE_PERIOD; }
/** 0..1 brightness of anything that keeps the tide's time. */
export function tideGlow(w: World): number { return 0.5 + 0.5 * Math.cos(tidePhase(w) * TAU); }

const traj: Trajectory = { pts: new Float32Array(2000), count: 0, impact: false, impactBody: null, impactX: 0, impactY: 0, impactSpeed: 0 };

const PILGRIM_PALETTE = { low: [0.22, 0.24, 0.28], mid: [0.42, 0.45, 0.5], high: [0.62, 0.66, 0.72] };
const ROCK_PALETTE = { low: [0.28, 0.26, 0.24], mid: [0.46, 0.43, 0.4], high: [0.6, 0.58, 0.55] };

// ------------------------------------------------------------------ authoring

export function authorSlices(w: World): void {
  authorTheCut(w);
  authorSignalRock(w);
  w.slices.fault = w.bodies.find(b => b.name === 'THE FAULT') ?? null;
}

/** THE CUT: a fissure into the enemy world ending in a chamber that holds the sentinel power regulator. */
function authorTheCut(w: World): void {
  const core = w.enemyCore;
  if (!core) return;
  const b = core.body;
  // a mouth well away from every pad on the world
  let mouth = 0, bestSep = -1;
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * TAU;
    let sep = Math.PI;
    for (const p of b.pads) sep = Math.min(sep, Math.abs(angleDiff(p.angle, a)));
    if (sep > bestSep) { bestSep = sep; mouth = a; }
  }
  const rim = terrainRadiusAt(b, mouth);
  notchTerrain(b, mouth, 7, 3);
  const rimNow = terrainRadiusAt(b, mouth);
  const path = [
    { d: -6, v: 0, hw: 7 },
    { d: 0, v: 0, hw: 5.2 },
    { d: 6, v: 0, hw: 3.4 },
    { d: 12, v: 0, hw: 3.4 },
    { d: 15, v: -2, hw: 3.2 },
    { d: 18, v: -6, hw: 3.2 },
    { d: 22, v: -7.5, hw: 3.4 },
    { d: 27, v: -5.5, hw: 3.4 },
    { d: 31, v: -3, hw: 2.3 },
    { d: 34, v: -3, hw: 2.3 },
    { d: 37, v: -3, hw: 6 },
    { d: 42, v: -2, hw: 12 },
    { d: 47, v: -2, hw: 12 },
    { d: 50, v: -2, hw: 9 },
  ];
  const f = fissureFromPath(b, 'THE CUT', mouth, rimNow, path, -6, false);
  void rim;
  // the regulator sits in a socket near the chamber floor
  const socketLocal = localFromPath(mouth, rimNow, 47, -2);
  const wp = bodyToWorld(b, socketLocal);
  // the regulator feeds the whole world: every base on it draws from this one socket
  const src = addPowerSource(w, b, socketLocal, Infinity, b.name);
  const reg = spawnCore(w, src, 'REGULATOR');
  reg.socketBody = b; reg.socketLocal = socketLocal;
  void wp;
  w.slices.cutBody = b; w.slices.cutSource = src; w.slices.cutFissure = f; w.slices.regulator = reg; w.slices.cutPowered = true;
}

function localFromPath(mouth: number, rim: number, d: number, v: number): V2 {
  const ux = Math.cos(mouth), uy = Math.sin(mouth), px = -uy, py = ux;
  const r = rim - d;
  return { x: ux * r + px * v, y: uy * r + py * v };
}

/** THE SIGNAL: a hollow rock in the belt with a cave, a dead Kestrel and its black box. */
function authorSignalRock(w: World): void {
  const belt = w.asteroids.filter(a => a.field === 1);
  const star = w.star;
  // orbit radius: the belt's mean radius
  let r = 0;
  for (const a of belt) r += Math.hypot(a.pos.x, a.pos.y);
  r = (belt.length ? r / belt.length : 2000) + 95;
  // never share the Fault's position on the ring
  const fault = w.bodies.find(b => b.name === 'THE FAULT');
  let phase = w.rng.next() * TAU;
  if (fault && fault.orbit) { for (let i = 0; i < 8 && Math.abs(angleDiff(phase, fault.orbit.phase)) < 0.6; i++) phase = w.rng.next() * TAU; }
  const rock = createBody({ name: 'HOLLOW', kind: 'planet', type: 'rock', radius: 22, surfaceG: 0.5, roughness: 0.18, orbit: { parent: star, radius: r, period: TAU * Math.sqrt(r * r * r / star.farMass), phase }, palette: ROCK_PALETTE, seed: w.seed + 9090, landable: true, soiMul: 3, hollow: true, segments: 56, secret: true });
  w.bodies.push(rock);
  // initial position
  rock.pos.x = star.pos.x + Math.cos(phase) * r; rock.pos.y = star.pos.y + Math.sin(phase) * r;
  const wv = rock.orbit!.angularSpeed * r;
  rock.vel.x = -Math.sin(phase) * wv; rock.vel.y = Math.cos(phase) * wv;
  const mouth = w.rng.next() * TAU;
  notchTerrain(rock, mouth, 4, 2);
  const rim = terrainRadiusAt(rock, mouth);
  const path = [
    { d: -4, v: 0, hw: 4 },
    { d: 0, v: 0, hw: 2.7 },
    { d: 4, v: 0.5, hw: 2.3 },
    { d: 8, v: 3, hw: 2.3 },
    { d: 12, v: 5.5, hw: 2.4 },
    { d: 16, v: 4.5, hw: 4.5 },
    { d: 20, v: 2.5, hw: 5.5 },
    { d: 24, v: 1.5, hw: 4.5 },
    { d: 27, v: 1, hw: 2.5 },
  ];
  fissureFromPath(rock, 'HOLLOW', mouth, rim, path, -4, true);
  const wreckL = localFromPath(mouth, rim, 22, 3);
  const boxL = localFromPath(mouth, rim, 24.5, 0.5);
  const wp = bodyToWorld(rock, wreckL), bp = bodyToWorld(rock, boxL);
  const wreck = spawnPickup(w, 'wreck', wp.x, wp.y, rock.vel.x, rock.vel.y, 0, null, 'KESTREL SEVEN');
  wreck.radius = 2.0; wreck.mass = 2.5;
  const box = spawnPickup(w, 'log', bp.x, bp.y, rock.vel.x, rock.vel.y, 0, null, 'BLACK BOX');
  box.radius = 0.6; box.mass = 0.2; box.beacon = true; box.glow = 0.4;
  w.slices.rock = rock; w.slices.wreck = wreck; w.slices.blackBox = box;
  // Kestrel Seven came apart on the way in: a trail of pieces points at the mouth from well outside
  {
    const mx = Math.cos(mouth), my = Math.sin(mouth);
    for (let i = 0; i < 7; i++) {
      const dist = 40 + i * 48 + w.rng.next() * 14;
      const side = (w.rng.next() - 0.5) * (6 + i * 4);
      const x = rock.pos.x + mx * dist - my * side, y = rock.pos.y + my * dist + mx * side;
      const k = spawnPickup(w, i === 6 ? 'wreck' : 'salvage', x, y, rock.vel.x, rock.vel.y, 35, null, i === 6 ? 'DRIVE SECTION' : '');
      k.life = 1e9; if (i === 6) { k.radius = 1.8; k.mass = 2.0; }
    }
  }
}

/** PILGRIM: a generation ship falling toward the star. Spawned by the runtime once the game is under way. */
export function spawnPilgrim(w: World): Body {
  const star = w.star;
  const a = 60, bHalf = 11;
  const profile = (t: number): number => {
    const c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
    const n = 4.2;
    const rr = Math.pow(Math.pow(c / a, n) + Math.pow(s / bHalf, n), -1 / n);
    // engine block at the stern, bridge tower at the bow
    const ang = Math.atan2(Math.sin(t), Math.cos(t));
    const stern = Math.abs(angleDiff(ang, Math.PI)) < 0.22 ? 3 : 0;
    const bow = Math.abs(ang) < 0.12 ? 2 : 0;
    return rr + stern + bow;
  };
  const hull = createBody({ name: 'PILGRIM', kind: 'hull', type: 'rock', radius: a + 3, surfaceG: 0, roughness: 0, palette: PILGRIM_PALETTE, seed: w.seed + 5150, landable: true, soiMul: 1, oblate: 0.14, free: true, rotates: true, bodyMass: 300, inertia: 300 * (a * a + bHalf * bHalf) * 2.5, tetherable: true, profile, segments: 112 });
  hull.mass = 0; hull.soi = 0;
  // start inside the star's full well, on a path that dives deep into the heat: the tangential
  // speed is found numerically against the real gravity model so the closest approach is ~250
  const rpWant = 210;
  let r0 = 3400;
  for (const b of w.bodies) if (b.orbit && b.orbit.parent === star && b.kind !== 'hull') r0 = Math.max(r0, b.orbit.radius + b.soi + 150);
  const inward = 18; // it is already falling when it appears
  // the clearest radial line: farthest from every world's well, with the worlds where they will be as it falls
  let ang = 0, bestClear = -1;
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * TAU;
    let clear = 1e9;
    for (const b of w.bodies) {
      if (!b.orbit || b.orbit.parent !== star || b.kind === 'hull') continue;
      for (let t = 0; t <= 480; t += 40) {
        const hr = r0 - inward * t; if (hr < b.orbit.radius - b.soi) break;
        const ba = b.orbit.phase + b.orbit.angularSpeed * (w.time + t);
        const bx = Math.cos(ba) * b.orbit.radius, by = Math.sin(ba) * b.orbit.radius;
        const d = Math.hypot(Math.cos(a) * hr - bx, Math.sin(a) * hr - by);
        clear = Math.min(clear, d - b.soi);
      }
    }
    if (clear > bestClear) { bestClear = clear; ang = a; }
  }
  hull.pos.x = star.pos.x + Math.cos(ang) * r0; hull.pos.y = star.pos.y + Math.sin(ang) * r0;
  const dir = w.rng.sign();
  void bestClear;
  let lo = 0, hi = Math.sqrt(star.mass / r0);
  const periFor = (v: number): number => {
    predictTrajectory(w, hull.pos.x, hull.pos.y, -Math.sin(ang) * v * dir - Math.cos(ang) * inward, Math.cos(ang) * v * dir - Math.sin(ang) * inward, 1, 900, 1.0, traj, hull);
    let m = 1e9;
    for (let i = 0; i < traj.count; i++) m = Math.min(m, Math.hypot(traj.pts[i * 2] - star.pos.x, traj.pts[i * 2 + 1] - star.pos.y));
    return m;
  };
  for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; if (periFor(mid) < rpWant) lo = mid; else hi = mid; }
  const vApo = (lo + hi) / 2;
  hull.vel.x = -Math.sin(ang) * vApo * dir - Math.cos(ang) * inward; hull.vel.y = Math.cos(ang) * vApo * dir - Math.sin(ang) * inward;
  hull.spinAngle = ang + Math.PI * 0.5 * dir; // hull axis roughly along its motion
  hull.angVel = 0.004 * dir;
  // three surviving thrusters as pads with tanks
  const mk = (name: string, angle: number, dirLocal: V2): void => {
    const pad = addPad(hull, 'thruster', name, angle, 3.5);
    pad.fuel = false; pad.repair = false;
    hull.thrusters.push({ name, pad, dirLocal, force: 30, fuel: 0, capacity: 40, burn: 1 });
    w.pads.push(pad);
  };
  mk('BOW PORT TANK', 0.2, { x: 0, y: -1 });
  mk('STERN PORT TANK', Math.PI - 0.2, { x: 0, y: -1 });
  mk('STERN MAIN TANK', Math.PI, { x: 1, y: 0 });
  w.bodies.push(hull);
  (hull as unknown as { meshDirty: boolean }).meshDirty = true;
  w.slices.pilgrim = hull;
  w.slices.pilgrimNextComm = w.time + 8;
  comm(w, 'CONTROL', 'A LARGE UNREGISTERED HULL HAS ENTERED THE SYSTEM ON A STAR-BOUND TRACK. IT DOES NOT ANSWER HAILS.', [0.6, 0.9, 1], 2, hull.pos);
  return hull;
}

// ------------------------------------------------------------------ runtime

const gTmp: V2 = { x: 0, y: 0 };

/** Integrate free bodies (the Pilgrim): gravity, thrusters, heat. */
export function stepFreeBodies(w: World, dt: number): void {
  for (let bi = w.bodies.length - 1; bi >= 0; bi--) {
    const b = w.bodies[bi];
    if (!b.free) continue;
    // gravity from everything else (a hull has no mass of its own, so the sum excludes it)
    gravityAt(w, b.pos.x, b.pos.y, gTmp);
    let ax = gTmp.x, ay = gTmp.y;
    // thrusters
    for (const t of b.thrusters) {
      if (t.fuel <= 0) continue;
      t.fuel = Math.max(0, t.fuel - t.burn * dt);
      const c = Math.cos(b.spinAngle), s = Math.sin(b.spinAngle);
      const fx = (t.dirLocal.x * c - t.dirLocal.y * s) * t.force, fy = (t.dirLocal.x * s + t.dirLocal.y * c) * t.force;
      ax += fx / b.bodyMass; ay += fy / b.bodyMass;
      const pp = padWorldPos(t.pad, 0);
      const rx = pp.x - b.pos.x, ry = pp.y - b.pos.y;
      b.angVel += (rx * fy - ry * fx) / b.inertia * dt;
    }
    b.vel.x += ax * dt; b.vel.y += ay * dt;
    b.pos.x += b.vel.x * dt; b.pos.y += b.vel.y * dt;
    // heat and the star
    const star = w.star;
    const d = Math.hypot(b.pos.x - star.pos.x, b.pos.y - star.pos.y);
    if (d < star.heatRadius && !inShadow(w, b.pos)) {
      const f = 1 - (d - star.radius) / (star.heatRadius - star.radius);
      b.integrity -= Math.max(0, f) * 1.2 * dt;
    }
    // a hull that meets a world breaks up on it, and what it lands on suffers
    let struck: Body | null = null;
    for (const o of w.bodies) {
      if (o === b || o.kind === 'star' || o.kind === 'hull' || o.free) continue;
      const dd = Math.hypot(b.pos.x - o.pos.x, b.pos.y - o.pos.y);
      if (dd < o.maxRadius + b.radius * 0.45) { struck = o; break; }
    }
    if (struck) {
      const ang = Math.atan2(b.pos.y - struck.pos.y, b.pos.x - struck.pos.x);
      for (const p of struck.pads) { const arc = Math.abs(angleDiff(padWorldAngle(p), ang)) * struck.radius; if (arc < b.radius && p.alive) { if (p.kind === 'enemybase' || p.kind === 'core') damageBase(w, p, 400); else padDamaged(w, p, 80); } }
      comm(w, 'CONTROL', `${b.name} HAS COME DOWN ON ${struck.name}.`, [1, 0.4, 0.3], 3, b.pos);
      b.integrity = 0;
    }
    if (d < star.radius * 1.05 || b.integrity <= 0) {
      // lost
      w.explosions.push({ pos: { x: b.pos.x, y: b.pos.y }, time: w.time, size: 6, color: [1, 0.7, 0.4] });
      sfx(w, 'bigboom', b.pos, 1, 8);
      w.bodies.splice(bi, 1);
      for (const p of b.pads) { const i = w.pads.indexOf(p); if (i >= 0) w.pads.splice(i, 1); }
      for (const s of w.ships) if (s.landed && s.landed.body === b) {
        const n = { x: s.pos.x - b.pos.x, y: s.pos.y - b.pos.y }; const l = Math.hypot(n.x, n.y) || 1;
        s.landed = null; s.vel.x = b.vel.x + n.x / l * 14; s.vel.y = b.vel.y + n.y / l * 14; s.invuln = 2;
        damageShip(w, s, 40, 'none', 'explosion');
        if (s === w.player) comm(w, 'KESTREL', 'THROWN CLEAR. THE HULL IS BREAKING UP UNDER US.', [1, 0.5, 0.3], 3);
      }
      if (b === w.slices.pilgrim) { w.slices.pilgrimLost = true; comm(w, 'CONTROL', 'THE PILGRIM IS GONE. FOUR THOUSAND SOULS.', [1, 0.35, 0.3], 3); }
    }
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

export function updateSlices(w: World, dt: number): void {
  const S = w.slices;
  const p = w.player;
  // ---- the Cut: the power state is the world grid's (see power.ts)
  if (S.cutSource && S.cutBody) {
    const b = S.cutBody;
    if (S.cutSource.powered !== S.cutPowered) { S.cutPowered = S.cutSource.powered; if (!S.cutPowered) S.cutPowerLostAt = w.time; }
    if (!S.cutEntered && S.cutFissure) {
      const l = bodyToWorld(b, S.cutFissure.outline[0]);
      if (Math.hypot(p.pos.x - l.x, p.pos.y - l.y) < 40 && Math.hypot(p.pos.x - b.pos.x, p.pos.y - b.pos.y) < b.radius - 4) { S.cutEntered = true; }
    }
  }
  // ---- Pilgrim
  if (!S.pilgrim && !S.pilgrimLost && w.time >= S.pilgrimSpawnAt) spawnPilgrim(w);
  if (S.pilgrim && !S.pilgrimLost) {
    const h = S.pilgrim;
    const d = Math.hypot(h.pos.x - p.pos.x, h.pos.y - p.pos.y);
    if (d < 450 && w.time >= S.pilgrimNextComm) {
      const lines = [
        '...THIS IS THE PILGRIM... OUR DRIVE IS GONE... WE ARE FALLING...',
        '...THREE TANKS STILL HOLD PRESSURE... WE HAVE NOTHING TO FEED THEM...',
        '...IF ANYONE CAN HEAR THIS... WE ARE FOUR THOUSAND SOULS...',
        '...THE HEAT IS RISING ON THE SUNWARD DECKS...',
      ];
      const done = S.pilgrimSaved;
      if (!done) {
        comm(w, 'PILGRIM', lines[S.pilgrimCommIdx % lines.length], [0.8, 0.85, 1.0], 1, h.pos);
        if (S.pilgrimCommIdx % lines.length === 1) note(w, 'pilgrim-tanks', `THE PILGRIM SAYS THREE OF HER TANKS STILL HOLD PRESSURE. HER DRIVE IS COLD, NOT BROKEN.`);
        S.pilgrimCommIdx++;
        S.pilgrimNextComm = w.time + 26;
      }
    }
    // is it safe? predicted closest approach to the star over the next few minutes
    if (w.tick % 60 === 0) {
      predictTrajectory(w, h.pos.x, h.pos.y, h.vel.x, h.vel.y, 1, 900, 1.0, traj, h);
      let minD = 1e9;
      for (let i = 0; i < traj.count; i++) {
        const dd = Math.hypot(traj.pts[i * 2] - w.star.pos.x, traj.pts[i * 2 + 1] - w.star.pos.y);
        if (dd < minD) minD = dd;
      }
      const dNow = Math.hypot(h.pos.x - w.star.pos.x, h.pos.y - w.star.pos.y);
      const safe = minD > w.star.heatRadius + 60 && !traj.impact;
      if (safe && !S.pilgrimSaved && dNow > w.star.heatRadius) {
        S.pilgrimSaved = true;
        comm(w, 'PILGRIM', 'WE SEE THE TURN. WE SEE IT. THANK YOU, WHOEVER YOU ARE.', [0.6, 1, 0.7], 3, h.pos);
        sfx(w, 'success', null, 1);
        w.score += 5000;
      } else if (!safe && S.pilgrimSaved) {
        S.pilgrimSaved = false;
        comm(w, 'PILGRIM', '...WE ARE FALLING AGAIN...', [1, 0.7, 0.4], 2, h.pos);
      }
    }
  }
  // ---- fuel transfer while landed on a thruster pad
  if (p.landed && p.landed.pad && p.landed.pad.kind === 'thruster' && p.transferHeld && p.fuel > 0) {
    const pad = p.landed.pad;
    const t = pad.body.thrusters.find(x => x.pad === pad);
    if (t) note(w, 'pilgrim-valve', `THE VALVE ON THE PILGRIM'S ${t.name} TOOK MY FUEL. WHOEVER BUILT HER LEFT THE FITTINGS STANDARD.`);
    if (t && t.fuel < t.capacity) {
      const amt = Math.min(6 * dt, p.fuel, t.capacity - t.fuel);
      t.fuel += amt; p.fuel -= amt;
      if (w.tick % 20 === 0) sfx(w, 'transfer', p.pos, 0.5);
    }
  }
  // ---- the signal: beacon blips, the log
  if (S.blackBox && S.blackBox.alive) {
    const bx = S.blackBox;
    const d = Math.hypot(bx.pos.x - p.pos.x, bx.pos.y - p.pos.y);
    if (d < 1800 && w.time >= S.beaconNext) {
      const interval = clamp(d / 280, 0.2, 4);
      S.beaconNext = w.time + interval;
      w.audioEvents.push({ kind: 'blip', pos: null, volume: 0.45 * (1 - d / 1800), param: clamp(1 - d / 1800, 0, 1) });
      w.hudFlicker = 0.35 * (1 - d / 1800);
    }
  }
  for (const lg of S.logs) {
    if (lg.pickup.alive || lg.line >= lg.lines.length) continue;
    if (w.time >= lg.next) { comm(w, lg.from, lg.lines[lg.line], [1, 0.9, 0.5], 2); lg.line++; lg.next = w.time + 5; if (lg.line >= lg.lines.length && lg.noteKey) note(w, lg.noteKey, lg.noteText); }
  }
  if (S.blackBox && !S.blackBox.alive && !S.logPlayed) {
    // collected: the log plays out
    const lines = [
      'KESTREL SEVEN, FINAL ENTRY. THE FAULT IS NOT A ROCK. IT KEEPS TIME WITH THE STARFALL.',
      'I PINGED IT ON THE BEAT AND THE WHOLE TIDE WENT STILL. THREE TIMES, ON THE PEAK.',
      'OFF THE BEAT THEY CAME FOR IT INSTEAD. GOD HELP ANYONE INSIDE ITS RINGS WHEN THEY DO.',
    ];
    if (w.time >= S.logNext) {
      comm(w, 'KESTREL SEVEN', lines[S.logLine], [1, 0.9, 0.5], 2);
      S.logLine++;
      S.logNext = w.time + 5;
      if (S.logLine >= lines.length) { S.logPlayed = true; note(w, 'kestrel-seven', `KESTREL SEVEN'S LOG, FROM THE CAVE IN THE HOLLOW ROCK. ANOTHER PATROL PILOT, YEARS BACK. THE FAULT 'KEEPS TIME WITH THE STARFALL', THE LOG SAYS.`); }
    }
  }
  // ---- the Lighthouse: fed, it carries the beat further than the Fault ever could
  {
    const lh = w.bodies.find(b => b.name === 'THE LIGHTHOUSE');
    const src = lh ? w.power.find(q => q.body === lh) : null;
    if (lh && src) for (const ev of w.pingEvents) {
      if (ev.body !== lh) continue;
      lh.flashUntil = w.time + 1.5;
      if (!src.powered) { S.lighthouseOnBeat = 0; continue; }
      if (w.time < S.lighthouseCooldownUntil) continue;
      const ph = (ev.time % TIDE_PERIOD) / TIDE_PERIOD;
      const onBeat = Math.min(ph, 1 - ph) < 0.13;
      if (w.time - S.lighthouseLastPing > 10) S.lighthouseOnBeat = 0;
      S.lighthouseLastPing = w.time;
      S.lighthouseOnBeat = onBeat ? S.lighthouseOnBeat + 1 : 0;
      if (S.lighthouseOnBeat >= 3) {
        S.lighthouseOnBeat = 0; S.lighthouseCooldownUntil = w.time + 600;
        S.tideStillUntil = w.time + 300;
        for (const s of w.ships) if (s.faction === 'enemy' && s.alive) s.stunned = 300;
        w.pings.push({ x: lh.pos.x, y: lh.pos.y, t0: w.time, r: 0, speed: 220, maxR: 6000, echo: true, hit: new Set(), bodiesHit: new Set() });
        comm(w, 'SENSORS', 'EVERY HOSTILE EMISSION IN THE SYSTEM HAS FLATLINED. THE ARRAY IS STILL TRANSMITTING.', [0.85, 0.45, 1.0], 3);
        sfx(w, 'faultanswer', null, 1, 0);
        note(w, 'lighthouse-still', 'THE ARRAY SPOKE WHEN IT HAD A CORE AND I SCANNED IT THREE TIMES ON THE PEAK. THE WHOLE TIDE WENT QUIET, AND STAYED QUIET.');
      }
    }
  }
  // ---- the Fault's answer
  if (S.fault) {
    for (const ev of w.pingEvents) {
      if (ev.body !== S.fault) continue;
      note(w, 'fault-flash', `THE FAULT FLASHED WHEN MY SCAN REACHED IT. ROCKS DO NOT DO THAT.`);
      if (w.time < S.faultCooldownUntil) { S.faultFlash = 0.3; continue; }
      const ph = (ev.time % TIDE_PERIOD) / TIDE_PERIOD;
      const onBeat = Math.min(ph, 1 - ph) < 0.13;
      const offBeat = Math.abs(ph - 0.5) < 0.13;
      if (w.time - S.faultLastPing > 10) { S.faultOnBeat = 0; S.faultOffBeat = 0; }
      S.faultLastPing = w.time;
      if (onBeat) { S.faultOnBeat++; S.faultOffBeat = 0; S.faultFlash = 1; faultRing(w, 220); }
      else if (offBeat) { S.faultOffBeat++; S.faultOnBeat = 0; S.faultFlash = 1; faultRing(w, 220); }
      else { S.faultOnBeat = 0; S.faultOffBeat = 0; S.faultFlash = 0.4; }
      if (S.faultOnBeat >= 3) {
        S.faultOnBeat = 0; S.faultCooldownUntil = w.time + 150; S.faultAnswerAt = w.time; S.faultAnswerKind = 'still';
        S.tideStillUntil = w.time + 60;
        for (const s of w.ships) if (s.faction === 'enemy' && s.alive) s.stunned = 60;
        faultRing(w, 900);
        comm(w, 'SENSORS', 'ENEMY EMISSIONS ACROSS THE SYSTEM HAVE FLATLINED.', [0.85, 0.45, 1.0], 3);
        sfx(w, 'faultanswer', null, 1, 0);
      } else if (S.faultOffBeat >= 3) {
        S.faultOffBeat = 0; S.faultCooldownUntil = w.time + 240; S.faultAnswerAt = w.time; S.faultAnswerKind = 'call';
        S.tideCalledUntil = w.time + 120;
        for (const s of w.ships) if (s.faction === 'enemy' && s.alive && s.ai && s.kind !== 'sentinel') { s.ai.mode = 'called'; s.ai.target = null; s.stunned = 0; }
        faultRing(w, 900);
        comm(w, 'SENSORS', 'EVERY HOSTILE CONTACT JUST TURNED. THEY ARE HEADING FOR THE FAULT.', [1, 0.5, 0.3], 3);
        sfx(w, 'faultanswer', null, 1, 1);
      }
    }
    S.faultFlash = Math.max(0, S.faultFlash - dt * 0.8);
  }
  w.pingEvents.length = 0;
  for (const s of w.ships) if (s.stunned > 0) s.stunned -= dt;
  w.hudFlicker = Math.max(0, w.hudFlicker - dt * 2);
}

function faultRing(w: World, maxR: number): void {
  const f = w.slices.fault!;
  w.pings.push({ x: f.pos.x, y: f.pos.y, t0: w.time, r: 0, speed: 160, maxR, echo: true, hit: new Set(), bodiesHit: new Set() });
}

/** Deliver a tethered pod to a pad or station. */
export function podDelivered(w: World, pod: Pickup, where: Pad | null): void {
  pod.alive = false;
  w.rescued++;
  w.score += 400;
  w.credits += 150;
  if (where && pod.home === where) where.population++;
  void gravityAt; void gTmp;
}
