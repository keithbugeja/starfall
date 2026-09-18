// Ship AI. Every AI ship obeys the same physics as the player; behaviours output Controls.
// Enemies are readable: wasps make strafing runs, lancers pursue and fire bursts, reavers abduct pods,
// dreadnoughts besiege stations, sentinels guard bases. Civilians travel and dock.
import { angleDiff, clamp, TAU, type V2 } from '../engine/math';
import { emptyControls, type Controls } from '../engine/input';
import { maxTerrainRadius, terrainNormalAt, terrainRadiusAt, type Body, type Pad } from './bodies';
import { fireWeapon, gravityAt, spawnPickup } from './physics';
import { hubRadius, localAngle } from './stations';
import { comm, createShip, makeWeapon, sfx, type AiState, type Faction, type Ship, type ShipKind, type Station, type World } from './world';

export function spawnAiShip(w: World, kind: ShipKind, faction: Faction, x: number, y: number, angle: number, mode: string, homeBody: Body | null): Ship {
  const s = createShip(w, kind, faction, x, y, angle);
  s.ai = {
    mode, target: null, targetPos: null, timer: 0, fireTimer: 0, strafeDir: w.rng.sign(), carrying: null, home: null, homeBody,
    wantFire: false, wantSecondary: false, patrolAngle: w.rng.next() * TAU, route: [], routeIndex: 0, convoyLeader: null,
    formationOffset: { x: 0, y: 0 }, fear: 0, memory: -1e9, groupId: 0, wave: 0,
  };
  // per-kind weapons
  switch (kind) {
    case 'wasp': s.weapon = { ...makeWeapon('lance'), cooldown: 0.55, damage: 7, speed: 85, life: 1.3 }; break;
    case 'lancer': s.weapon = { ...makeWeapon('lance'), cooldown: 0.16, damage: 12, speed: 90, life: 1.6 }; break;
    case 'reaver': s.weapon = { ...makeWeapon('lance'), cooldown: 1.0, damage: 16, speed: 70, life: 1.4 }; break;
    case 'dreadnought': s.weapon = { ...makeWeapon('mass'), cooldown: 1.8, damage: 48, speed: 42, life: 6 }; s.secondary = { ...makeWeapon('lance'), cooldown: 1.1, damage: 14, speed: 80, life: 1.6 }; break;
    case 'sentinel': s.weapon = { ...makeWeapon('lance'), cooldown: 1.15, damage: 15, speed: 88, life: 1.8 }; break;
    case 'freighter': s.weapon = { ...makeWeapon('pulse'), cooldown: 0.5, damage: 5 }; break;
    default: break;
  }
  if (faction === 'enemy') s.massMul = 1;
  // orbital velocity around the home body so patrols do not fall out of the sky
  if (homeBody && kind !== 'sentinel') {
    const dx = x - homeBody.pos.x, dy = y - homeBody.pos.y;
    const r = Math.hypot(dx, dy) || 1;
    if (r < homeBody.soi) {
      const v = Math.sqrt(homeBody.mass / r) * 0.9;
      s.vel.x = homeBody.vel.x - dy / r * v; s.vel.y = homeBody.vel.y + dx / r * v;
    }
  }
  return s;
}

/** Place a sentinel turret on an enemy base pad. */
export function spawnSentinel(w: World, pad: Pad): Ship {
  const b = pad.body;
  const n = terrainNormalAt(b, pad.angle);
  const x = b.pos.x + Math.cos(pad.angle) * (pad.height + 1.3), y = b.pos.y + Math.sin(pad.angle) * (pad.height + 1.3);
  const s = spawnAiShip(w, 'sentinel', 'enemy', x, y, Math.atan2(n.y, n.x), 'guard', b);
  s.landed = { body: b, pad, offset: { x: x - b.pos.x, y: y - b.pos.y }, angle: Math.atan2(n.y, n.x) };
  s.ai!.home = pad;
  return s;
}

const gTmp: V2 = { x: 0, y: 0 };

/** Compute controls that drive the ship's velocity toward (wx, wy), compensating gravity. */
function velocityControl(w: World, s: Ship, wx: number, wy: number, gain: number, c: Controls, allowBoost = false): void {
  gravityAt(w, s.pos.x, s.pos.y, gTmp);
  let ax = (wx - s.vel.x) * gain - gTmp.x * s.stats.gravMul;
  let ay = (wy - s.vel.y) * gain - gTmp.y * s.stats.gravMul;
  const am = Math.hypot(ax, ay);
  if (am < 0.4) return;
  const heading = Math.atan2(ay, ax);
  const err = angleDiff(s.angle, heading);
  const st = s.stats;
  // lateral / retro components in the ship frame
  const fx = Math.cos(s.angle), fy = Math.sin(s.angle);
  const forward = ax * fx + ay * fy;
  const lateral = ax * fy - ay * fx; // positive = starboard
  if (st.strafe > 0 && Math.abs(lateral) > 0.5) c.strafe = clamp(lateral / st.strafe, -1, 1);
  if (forward < -0.5 && st.retro > 0) {
    c.retro = clamp(-forward / st.retro, 0, 1);
    // when retro can handle it, do not bother turning around
    if (-forward < st.retro * 1.2) { c.turn = clamp(angleDiff(s.angle, Math.atan2(-ay, -ax)) * 3, -1, 1) * 0.3; return; }
  }
  c.turn = clamp(err * 3.2, -1, 1);
  if (Math.abs(err) < 0.5) {
    c.thrust = clamp(forward / st.thrust, 0, 1);
    if (allowBoost && am > st.thrust * 1.3 && Math.abs(err) < 0.2) c.boost = true;
  }
}

/** Add an avoidance velocity if the ship's near-future path intersects a body or the star. */
function avoidBodies(w: World, s: Ship, want: V2, lookahead = 2.2): void {
  for (const b of w.bodies) {
    const margin = b.kind === 'star' ? b.radius * 1.6 : maxTerrainRadius(b) + 6 + s.radius * 3;
    const dx = s.pos.x - b.pos.x, dy = s.pos.y - b.pos.y;
    const d = Math.hypot(dx, dy);
    if (d > margin + 90) continue;
    // closest approach along current velocity within lookahead
    const rvx = s.vel.x - b.vel.x, rvy = s.vel.y - b.vel.y;
    const t = clamp(-(dx * rvx + dy * rvy) / (rvx * rvx + rvy * rvy + 1e-6), 0, lookahead);
    const cx = dx + rvx * t, cy = dy + rvy * t;
    const cd = Math.hypot(cx, cy);
    if (cd < margin || d < margin) {
      const k = clamp(1.4 - Math.min(cd, d) / margin, 0.2, 1.4);
      const nx = dx / (d || 1), ny = dy / (d || 1);
      want.x += nx * 22 * k; want.y += ny * 22 * k;
      // also add a tangential nudge so we slide around rather than stall against the pull
      want.x += -ny * 8 * k * (s.ai ? s.ai.strafeDir : 1); want.y += nx * 8 * k * (s.ai ? s.ai.strafeDir : 1);
    }
  }
}

function aimLead(s: Ship, t: Ship, speed: number): number {
  const dx = t.pos.x - s.pos.x, dy = t.pos.y - s.pos.y;
  const d = Math.hypot(dx, dy);
  const tt = d / speed;
  const px = dx + (t.vel.x - s.vel.x) * tt, py = dy + (t.vel.y - s.vel.y) * tt;
  return Math.atan2(py, px);
}

function findTarget(w: World, s: Ship, range: number): Ship | null {
  const pl = w.player;
  let best: Ship | null = null, bd = range;
  if (pl.alive && !pl.docked) {
    const d = Math.hypot(pl.pos.x - s.pos.x, pl.pos.y - s.pos.y);
    if (d < bd) { best = pl; bd = d; }
    // once shot at, remember the player for a while
    if (s.ai && w.time - s.ai.memory < 8 && d < range * 1.8) { best = pl; bd = d; }
  }
  for (const o of w.ships) {
    if (!o.alive || o.docked || o.faction !== 'civ' || o.landed) continue;
    const d = Math.hypot(o.pos.x - s.pos.x, o.pos.y - s.pos.y) * 1.3; // prefer the player slightly
    if (d < bd) { best = o; bd = d; }
  }
  return best;
}

export function updateAi(w: World, s: Ship, dt: number): Controls {
  const c = emptyControls();
  const ai = s.ai;
  if (!ai || !s.alive || s.docked) return c;
  ai.timer -= dt;
  ai.fireTimer -= dt;
  ai.wantFire = false;
  ai.wantSecondary = false;
  if (ai.target && (!ai.target.alive || ai.target.docked)) ai.target = null;
  switch (s.kind) {
    case 'wasp': waspAi(w, s, ai, c, dt); break;
    case 'lancer': lancerAi(w, s, ai, c, dt); break;
    case 'reaver': reaverAi(w, s, ai, c, dt); break;
    case 'freighter':
    case 'shuttle': civAi(w, s, ai, c, dt); break;
    case 'dreadnought': dreadAi(w, s, ai, c, dt); break;
    case 'sentinel': sentinelAi(w, s, ai, c, dt); break;
    default: break;
  }
  return c;
}

/** Fire after physics has moved the ship. */
export function aiFire(w: World, s: Ship): void {
  const ai = s.ai;
  if (!ai || !s.alive) return;
  if (s.fireCooldown > 0) s.fireCooldown -= 1 / 120;
  if (ai.wantFire) fireWeapon(w, s, s.weapon, ai.target);
  if (ai.wantSecondary && s.secondary) {
    // turret-style: fire from the ship toward the target regardless of heading (dreadnought)
    const t = ai.target;
    if (t && s.fireCooldown <= 0 && ai.fireTimer <= 0) {
      const save = s.angle;
      s.angle = aimLead(s, t, s.secondary.speed) + (w.rng.next() - 0.5) * 0.08;
      const cd = s.fireCooldown;
      s.fireCooldown = 0;
      fireWeapon(w, s, s.secondary);
      s.fireCooldown = cd;
      s.angle = save;
      ai.fireTimer = s.secondary.cooldown;
    }
  }
}

function patrol(w: World, s: Ship, ai: AiState, c: Controls, radiusMul: number, speed: number): void {
  const b = ai.homeBody;
  const want: V2 = { x: 0, y: 0 };
  if (b) {
    const dx = s.pos.x - b.pos.x, dy = s.pos.y - b.pos.y;
    const d = Math.hypot(dx, dy) || 1;
    const targetR = b.radius * radiusMul;
    const ux = dx / d, uy = dy / d;
    // tangential patrol plus radial correction; orbital speed keeps it cheap
    const orbV = d < b.soi ? Math.sqrt(b.mass / d) : 0;
    const v = Math.max(speed, orbV * 0.95);
    want.x = b.vel.x - uy * v * ai.strafeDir + ux * (targetR - d) * 0.15;
    want.y = b.vel.y + ux * v * ai.strafeDir + uy * (targetR - d) * 0.15;
  } else {
    want.x = Math.cos(ai.patrolAngle) * speed; want.y = Math.sin(ai.patrolAngle) * speed;
    if (ai.timer <= 0) { ai.patrolAngle += (w.rng.next() - 0.5) * 2; ai.timer = 3 + w.rng.next() * 4; }
  }
  avoidBodies(w, s, want);
  velocityControl(w, s, want.x, want.y, 1.2, c);
}

function waspAi(w: World, s: Ship, ai: AiState, c: Controls, dt: number): void {
  if (ai.mode === 'patrol' || ai.mode === 'hunt') {
    const t = findTarget(w, s, ai.mode === 'hunt' ? 900 : 320);
    if (t) { ai.target = t; ai.mode = 'run'; ai.timer = 5 + w.rng.next() * 2; ai.strafeDir = w.rng.sign(); }
    else if (ai.mode === 'hunt' && ai.targetPos) {
      const want: V2 = { x: ai.targetPos.x - s.pos.x, y: ai.targetPos.y - s.pos.y };
      const d = Math.hypot(want.x, want.y) || 1;
      want.x = want.x / d * 60; want.y = want.y / d * 60;
      avoidBodies(w, s, want);
      velocityControl(w, s, want.x, want.y, 1.0, c, true);
      if (d < 60) { ai.mode = 'patrol'; ai.homeBody = null; }
    } else patrol(w, s, ai, c, 2.6, 16);
    return;
  }
  const t = ai.target;
  if (!t) { ai.mode = 'patrol'; return; }
  const dx = t.pos.x - s.pos.x, dy = t.pos.y - s.pos.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d;
  if (d > 700) { ai.target = null; ai.mode = 'patrol'; return; }
  const want: V2 = { x: 0, y: 0 };
  if (ai.mode === 'run') {
    // attack run: close in fast with a sideways component, fire when lined up
    const side = ai.strafeDir;
    const closing = d > 40 ? 52 : 30;
    want.x = t.vel.x + ux * closing - uy * side * 22;
    want.y = t.vel.y + uy * closing + ux * side * 22;
    if (d < 22 || ai.timer <= 0) { ai.mode = 'break'; ai.timer = 2.2 + w.rng.next(); ai.strafeDir = -ai.strafeDir; }
    const aim = aimLead(s, t, s.weapon.speed);
    if (Math.abs(angleDiff(s.angle, aim)) < 0.14 && d < 110) ai.wantFire = true;
  } else {
    // break away, then come back around
    want.x = t.vel.x - ux * 48 + uy * ai.strafeDir * 30;
    want.y = t.vel.y - uy * 48 - ux * ai.strafeDir * 30;
    if (ai.timer <= 0) { ai.mode = 'run'; ai.timer = 4 + w.rng.next() * 2; }
  }
  avoidBodies(w, s, want, 1.4);
  velocityControl(w, s, want.x, want.y, 1.6, c);
  // when lined up during a run, steer to the aim point instead of the velocity vector
  if (ai.mode === 'run' && d < 120) {
    const aim = aimLead(s, t, s.weapon.speed);
    c.turn = clamp(angleDiff(s.angle, aim) * 3.5, -1, 1);
  }
  void dt;
}

function lancerAi(w: World, s: Ship, ai: AiState, c: Controls, dt: number): void {
  if (s.hull < s.hullMax * 0.25 && ai.mode !== 'flee') { ai.mode = 'flee'; ai.timer = 12; comm(w, 'INTERCEPT', 'LANCER BREAKING OFF. IT WILL BE BACK.', [1, 0.6, 0.4], 0); }
  if (ai.mode === 'flee') {
    const t = ai.target ?? w.player;
    const dx = s.pos.x - t.pos.x, dy = s.pos.y - t.pos.y;
    const d = Math.hypot(dx, dy) || 1;
    const want: V2 = { x: dx / d * 60, y: dy / d * 60 };
    avoidBodies(w, s, want);
    velocityControl(w, s, want.x, want.y, 1.2, c, true);
    if (ai.timer <= 0 && s.hull > s.hullMax * 0.25) ai.mode = 'patrol';
    s.hull = Math.min(s.hullMax, s.hull + 2.5 * dt); // repairs while away
    return;
  }
  if (ai.mode === 'patrol' || ai.mode === 'hunt') {
    const t = findTarget(w, s, ai.mode === 'hunt' ? 900 : 300);
    if (t) { ai.target = t; ai.mode = 'pursue'; ai.timer = 0; }
    else if (ai.mode === 'hunt' && ai.targetPos) {
      const want: V2 = { x: ai.targetPos.x - s.pos.x, y: ai.targetPos.y - s.pos.y };
      const d = Math.hypot(want.x, want.y) || 1;
      want.x = want.x / d * 55; want.y = want.y / d * 55;
      avoidBodies(w, s, want);
      velocityControl(w, s, want.x, want.y, 1.0, c, true);
      if (d < 60) { ai.mode = 'patrol'; ai.homeBody = null; }
    } else patrol(w, s, ai, c, 3.2, 14);
    return;
  }
  const t = ai.target;
  if (!t) { ai.mode = 'patrol'; return; }
  const dx = t.pos.x - s.pos.x, dy = t.pos.y - s.pos.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d;
  if (d > 800) { ai.target = null; ai.mode = 'patrol'; return; }
  // hold 40-70 behind/near the target, matching velocity
  const hold = 52;
  const want: V2 = { x: t.vel.x + ux * (d - hold) * 0.8, y: t.vel.y + uy * (d - hold) * 0.8 };
  // slight orbit so it does not sit still in the player's sights
  want.x += -uy * 10 * ai.strafeDir; want.y += ux * 10 * ai.strafeDir;
  if (ai.timer <= 0) { ai.strafeDir = -ai.strafeDir; ai.timer = 3 + w.rng.next() * 3; }
  avoidBodies(w, s, want, 1.6);
  velocityControl(w, s, want.x, want.y, 1.4, c, d > 220);
  // bursts of three
  const aim = aimLead(s, t, s.weapon.speed);
  const aerr = angleDiff(s.angle, aim);
  if (d < 130) c.turn = clamp(aerr * 3.5, -1, 1);
  if (Math.abs(aerr) < 0.1 && d < 120) {
    if (ai.fireTimer <= 0) { ai.wantFire = true; ai.wave++; if (ai.wave >= 3) { ai.wave = 0; ai.fireTimer = 1.6; } }
  }
}

function reaverAi(w: World, s: Ship, ai: AiState, c: Controls, dt: number): void {
  const pad = ai.home as Pad | null;
  // opportunistic fire at the player when close and ahead
  const pl = w.player;
  if (pl.alive && !pl.docked) {
    const d = Math.hypot(pl.pos.x - s.pos.x, pl.pos.y - s.pos.y);
    if (d < 60) {
      const aim = aimLead(s, pl, s.weapon.speed);
      if (Math.abs(angleDiff(s.angle, aim)) < 0.2) { ai.wantFire = true; ai.target = pl; }
    }
  }
  if (ai.mode === 'raid' && pad) {
    const b = pad.body;
    if (!pad.alive || pad.population <= 0) { ai.mode = 'escape'; return; }
    // come in high over the pad first, then straight down: never skim the terrain around it
    const arc = Math.abs(angleDiff(Math.atan2(s.pos.y - b.pos.y, s.pos.x - b.pos.x), pad.angle)) * b.radius;
    const alt = arc > 18 ? 70 : 9;
    const px = b.pos.x + Math.cos(pad.angle) * (pad.height + alt), py = b.pos.y + Math.sin(pad.angle) * (pad.height + alt);
    const dx = px - s.pos.x, dy = py - s.pos.y;
    const d = Math.hypot(dx, dy);
    // approach the hover point above the pad; slow down near it
    const sp = clamp(d * 0.22, 1.5, 30);
    const want: V2 = { x: b.vel.x + dx / (d || 1) * sp, y: b.vel.y + dy / (d || 1) * sp };
    // avoidance only while far out: the whole point is to go down to the surface
    if (d > 110) avoidBodies(w, s, want, 1.5);
    velocityControl(w, s, want.x, want.y, 2.0, c);
    // hover counter (ai.wave) fills while close to the lift point
    if (d < 5) ai.wave += dt; else ai.wave = Math.max(0, ai.wave - dt * 0.5);
    if (ai.wave > 4) {
      {
        // lift a pod
        pad.population = Math.max(0, pad.population - 1);
        const pod = spawnPickup(w, 'pod', s.pos.x, s.pos.y, s.vel.x, s.vel.y, 0, pad, 'POD');
        pod.carriedBy = s;
        ai.carrying = pod;
        ai.mode = 'escape';
        ai.timer = 0; ai.wave = 0;
        sfx(w, 'alarm', s.pos, 0.8);
        comm(w, pad.name, `REAVER HAS LIFTED A POD FROM ${pad.name}! SHOOT IT DOWN!`, [1, 0.5, 0.3], 3, s.pos);
      }
    }
    return;
  }
  if (ai.mode === 'build' && ai.targetPos) {
    // constructor: fly to the site and hold there while the base goes up
    const tp = ai.targetPos;
    const dx = tp.x - s.pos.x, dy = tp.y - s.pos.y;
    const d = Math.hypot(dx, dy) || 1;
    const b = ai.homeBody;
    const bv = b ? b.vel : { x: 0, y: 0 };
    const sp = clamp(d * 0.3, 2, 34);
    const want: V2 = { x: bv.x + dx / d * sp, y: bv.y + dy / d * sp };
    if (d > 110) avoidBodies(w, s, want, 1.5);
    velocityControl(w, s, want.x, want.y, 1.5, c);
    return;
  }
  if (ai.mode === 'escape') {
    const core = w.enemyCore;
    const dest = core ? core.body.pos : { x: s.pos.x * 3, y: s.pos.y * 3 };
    const dx = dest.x - s.pos.x, dy = dest.y - s.pos.y;
    const d = Math.hypot(dx, dy) || 1;
    // climb out of the well first: move radially away from the pad body until clear, then head home
    const want: V2 = { x: dx / d * 34, y: dy / d * 34 };
    if (pad) {
      const b = pad.body;
      const bx = s.pos.x - b.pos.x, by = s.pos.y - b.pos.y;
      const bd = Math.hypot(bx, by) || 1;
      if (bd < b.radius * 2.2) { want.x = b.vel.x + bx / bd * 26; want.y = b.vel.y + by / bd * 26; }
    }
    avoidBodies(w, s, want, 2);
    velocityControl(w, s, want.x, want.y, 1.3, c);
    if (core && d < core.body.radius * 2.4) {
      if (ai.carrying) {
        ai.carrying.alive = false; ai.carrying = null;
        w.lost++;
        comm(w, 'CONTROL', 'A POD HAS BEEN TAKEN INTO THE STARFALL.', [1, 0.35, 0.3], 3, s.pos);
      }
      ai.mode = 'patrol'; ai.homeBody = core.body;
    }
    return;
  }
  patrol(w, s, ai, c, 2.4, 12);
}

function civAi(w: World, s: Ship, ai: AiState, c: Controls, dt: number): void {
  if (ai.mode === 'drift') { if (s.fuel > 0) ai.mode = 'travel'; else return; }
  // flee when shot recently
  const threatened = w.time - s.lastDamageTime < 6;
  if (threatened && ai.mode !== 'flee') { ai.mode = 'flee'; ai.timer = 8; }
  if (ai.mode === 'flee') {
    // run away from the nearest enemy, toward the destination
    let ex = 0, ey = 0, ed = 1e9;
    for (const o of w.ships) if (o.alive && o.faction === 'enemy') { const d = Math.hypot(o.pos.x - s.pos.x, o.pos.y - s.pos.y); if (d < ed) { ed = d; ex = o.pos.x; ey = o.pos.y; } }
    const want: V2 = { x: 0, y: 0 };
    if (ed < 1e8) { const dx = s.pos.x - ex, dy = s.pos.y - ey; const d = Math.hypot(dx, dy) || 1; want.x = dx / d * 40; want.y = dy / d * 40; }
    avoidBodies(w, s, want);
    velocityControl(w, s, want.x, want.y, 1.2, c, true);
    if (ai.timer <= 0) ai.mode = 'travel';
    return;
  }
  const dest = ai.home;
  if (!dest) { patrol(w, s, ai, c, 3, 10); return; }
  if ('spin' in dest) {
    // station: approach, wait for the gap, run in
    const st = dest as Station;
    const dx = st.pos.x - s.pos.x, dy = st.pos.y - s.pos.y;
    const d = Math.hypot(dx, dy) || 1;
    const R = st.radius;
    if (!st.alive) { ai.home = null; return; }
    if (d > R * 2.2) {
      const want: V2 = { x: st.vel.x + dx / d * Math.min(30, d * 0.2 + 6), y: st.vel.y + dy / d * Math.min(30, d * 0.2 + 6) };
      avoidBodies(w, s, want, 2);
      velocityControl(w, s, want.x, want.y, 1.2, c, d > 400);
      return;
    }
    const local = localAngle(st, s.pos.x, s.pos.y);
    const gapOpen = Math.abs(local) < st.bayHalfWidth * 0.55;
    if (ai.mode !== 'dockrun') {
      // hold at 1.7R on the current bearing
      const hx = st.pos.x - dx / d * R * 1.7, hy = st.pos.y - dy / d * R * 1.7;
      const want: V2 = { x: st.vel.x + (hx - s.pos.x) * 0.6, y: st.vel.y + (hy - s.pos.y) * 0.6 };
      velocityControl(w, s, want.x, want.y, 1.6, c);
      // face the hub
      if (Math.hypot(want.x - s.vel.x, want.y - s.vel.y) < 2) c.turn = clamp(angleDiff(s.angle, Math.atan2(dy, dx)) * 3, -1, 1);
      if (gapOpen && d < R * 1.9) ai.mode = 'dockrun';
      return;
    }
    // dock run: straight to the hub at a sedate speed; the station rotates but the run is short
    const want: V2 = { x: st.vel.x + dx / d * 9, y: st.vel.y + dy / d * 9 };
    velocityControl(w, s, want.x, want.y, 2.2, c);
    c.turn = clamp(angleDiff(s.angle, Math.atan2(dy, dx)) * 3, -1, 1);
    if (d < hubRadius(st) + s.radius) { s.docked = st; s.alive = false; }
    return;
  }
  // pad destination: fly to a point above it and descend
  const pad = dest as Pad;
  const b = pad.body;
  if (s.landed) { ai.timer -= 0; if (ai.timer < -20) s.alive = false; return; } // delivered: wait then vanish
  const arcC = Math.abs(angleDiff(Math.atan2(s.pos.y - b.pos.y, s.pos.x - b.pos.x), pad.angle)) * b.radius;
  const altC = arcC > 18 ? 70 : 20;
  const hx = b.pos.x + Math.cos(pad.angle) * (pad.height + altC), hy = b.pos.y + Math.sin(pad.angle) * (pad.height + altC);
  const dx = hx - s.pos.x, dy = hy - s.pos.y;
  const d = Math.hypot(dx, dy) || 1;
  if (d > 6 || altC > 20) {
    const sp = clamp(d * 0.3, 4, 32);
    const want: V2 = { x: b.vel.x + dx / d * sp, y: b.vel.y + dy / d * sp };
    if (d > 110) avoidBodies(w, s, want, 1.5);
    velocityControl(w, s, want.x, want.y, 1.4, c);
    return;
  }
  // descend slowly along the normal
  const n = terrainNormalAt(b, pad.angle);
  const want: V2 = { x: b.vel.x - n.x * 2.2, y: b.vel.y - n.y * 2.2 };
  velocityControl(w, s, want.x, want.y, 2.0, c);
  c.turn = clamp(angleDiff(s.angle, Math.atan2(n.y, n.x)) * 3, -1, 1);
  void dt;
}

function dreadAi(w: World, s: Ship, ai: AiState, c: Controls, dt: number): void {
  const st = ai.home as Station | null;
  const pl = w.player;
  // turrets: track the player within range
  if (pl.alive && !pl.docked) {
    const d = Math.hypot(pl.pos.x - s.pos.x, pl.pos.y - s.pos.y);
    if (d < 120) { ai.target = pl; ai.wantSecondary = true; }
  }
  if (st && st.alive) {
    const dx = st.pos.x - s.pos.x, dy = st.pos.y - s.pos.y;
    const d = Math.hypot(dx, dy) || 1;
    const hold = 95;
    const want: V2 = { x: st.vel.x + dx / d * clamp((d - hold) * 0.3, -10, 18), y: st.vel.y + dy / d * clamp((d - hold) * 0.3, -10, 18) };
    avoidBodies(w, s, want, 3);
    velocityControl(w, s, want.x, want.y, 0.8, c);
    // main gun: fire mass shells at the station when in range; lob them
    if (d < 130) {
      const aim = Math.atan2(dy, dx);
      c.turn = clamp(angleDiff(s.angle, aim) * 2, -1, 1);
      if (Math.abs(angleDiff(s.angle, aim)) < 0.12) { ai.wantFire = true; st.siege = 5; }
    }
    return;
  }
  // no station: drift toward the player and shell them
  if (pl.alive) {
    const dx = pl.pos.x - s.pos.x, dy = pl.pos.y - s.pos.y;
    const d = Math.hypot(dx, dy) || 1;
    const want: V2 = { x: pl.vel.x + dx / d * 12, y: pl.vel.y + dy / d * 12 };
    avoidBodies(w, s, want, 3);
    velocityControl(w, s, want.x, want.y, 0.8, c);
    const aim = aimLead(s, pl, s.weapon.speed);
    c.turn = clamp(angleDiff(s.angle, aim) * 2, -1, 1);
    if (Math.abs(angleDiff(s.angle, aim)) < 0.1 && d < 160) ai.wantFire = true;
  }
  void dt;
}

function sentinelAi(w: World, s: Ship, ai: AiState, c: Controls, dt: number): void {
  const pl = w.player;
  const pad = ai.home as Pad | null;
  if (pad && !pad.alive) { s.alive = false; return; }
  if (!pl.alive || pl.docked) return;
  const dx = pl.pos.x - s.pos.x, dy = pl.pos.y - s.pos.y;
  const d = Math.hypot(dx, dy);
  if (d > 150) return;
  // rotate in place toward the lead point (sentinel stays landed; we rotate the landed angle)
  const aim = aimLead(s, pl, s.weapon.speed);
  const err = angleDiff(s.angle, aim);
  const rot = clamp(err, -s.stats.turnRate * dt, s.stats.turnRate * dt);
  if (s.landed) { s.landed.angle += rot; s.angle = s.landed.angle; }
  // only fire when the target is above the horizon (outward side)
  const b = s.landed?.body;
  if (b) {
    const n = terrainNormalAt(b, Math.atan2(s.pos.y - b.pos.y, s.pos.x - b.pos.x));
    const above = (dx * n.x + dy * n.y) > -2;
    if (Math.abs(err) < 0.12 && above && d < 130) { ai.wantFire = true; ai.target = pl; }
  }
  void c;
}

/** Clean up dead ships and ships that finished their business. */
export function pruneShips(w: World): void {
  for (let i = w.ships.length - 1; i >= 0; i--) {
    const s = w.ships[i];
    if (s === w.player) continue;
    if (!s.alive) w.ships.splice(i, 1);
  }
}

export { terrainRadiusAt };
