// Physics: gravity, ship integration, terrain contact + landing, projectiles, asteroids, pickups,
// trajectory prediction. Everything lives in the sim plane.
import { angleDiff, clamp, damp, TAU, v2len, wrapAngle, type V2 } from '../engine/math';
import type { Controls } from '../engine/input';
import { gravityFrom, maxTerrainRadius, terrainNormalAt, terrainRadiusAt, terrainSegmentAt, type Body, type Pad } from './bodies';
import { comm, sfx, type Asteroid, type Pickup, type Projectile, type Ship, type World } from './world';

const tmpG: V2 = { x: 0, y: 0 };

/** Net gravitational acceleration at a point. Returns magnitude. */
export function gravityAt(w: World, x: number, y: number, out: V2): number {
  out.x = 0; out.y = 0;
  for (const b of w.bodies) {
    gravityFrom(b, x, y, tmpG);
    out.x += tmpG.x; out.y += tmpG.y;
  }
  return Math.hypot(out.x, out.y);
}

/** Strongest single body influence at a point (for HUD and AI). */
export function dominantBody(w: World, x: number, y: number): { body: Body | null; g: number } {
  let best: Body | null = null, bg = 0;
  for (const b of w.bodies) {
    const g = gravityFrom(b, x, y, tmpG);
    if (g > bg) { bg = g; best = b; }
  }
  return { body: best, g: bg };
}

export const LAND_VN = 4.5;   // max approach speed into the surface
export const LAND_VT = 2.6;   // max sideways speed
export const LAND_ANG = 0.48; // max heading error from surface normal (rad)

const gAcc: V2 = { x: 0, y: 0 };

export function stepShip(w: World, s: Ship, c: Controls, dt: number): void {
  if (!s.alive) return;
  if (s.docked) return;
  const st = s.stats;
  const hasFuel = s.fuel > 0;
  const massInv = 1 / s.massMul;

  if (s.landed) {
    const L = s.landed;
    s.pos.x = L.body.pos.x + L.offset.x;
    s.pos.y = L.body.pos.y + L.offset.y;
    s.vel.x = L.body.vel.x; s.vel.y = L.body.vel.y;
    s.angle = L.angle;
    s.angVel = 0;
    s.thrusting = 0; s.retroing = 0; s.strafing = 0; s.boosting = false;
    if (c.thrust > 0.2 && hasFuel) {
      // lift off
      s.landed = null;
      const n = terrainNormalAt(L.body, Math.atan2(L.offset.y, L.offset.x));
      s.pos.x += n.x * 0.08; s.pos.y += n.y * 0.08;
      s.vel.x += n.x * 1.5; s.vel.y += n.y * 1.5;
      if (s === w.player) { w.stats.launches++; sfx(w, 'launch', s.pos, 0.8); }
    } else {
      return;
    }
  }

  // rotation
  const turnTarget = c.turn * st.turnRate / Math.sqrt(s.massMul);
  s.angVel = damp(s.angVel, turnTarget, 18, dt);
  s.angle = wrapAngle(s.angle + s.angVel * dt);

  // forces
  const gmag = gravityAt(w, s.pos.x, s.pos.y, gAcc);
  let ax = gAcc.x * st.gravMul, ay = gAcc.y * st.gravMul;
  const cx = Math.cos(s.angle), cy = Math.sin(s.angle);
  let thrust = hasFuel ? clamp(c.thrust, 0, 1) : 0;
  const boosting = hasFuel && c.boost && thrust > 0 && !s.overheated;
  s.boosting = boosting;
  if (boosting) {
    ax += cx * st.boostThrust * massInv; ay += cy * st.boostThrust * massInv;
    s.fuel = Math.max(0, s.fuel - st.boostBurn * dt);
    s.thrusting = 1;
  } else if (thrust > 0) {
    ax += cx * st.thrust * thrust * massInv; ay += cy * st.thrust * thrust * massInv;
    s.fuel = Math.max(0, s.fuel - st.fuelBurn * thrust * dt);
    s.thrusting = thrust;
  } else {
    s.thrusting = 0;
  }
  const retro = hasFuel && st.retro > 0 ? clamp(c.retro, 0, 1) : 0;
  if (retro > 0) {
    ax -= cx * st.retro * retro * massInv; ay -= cy * st.retro * retro * massInv;
    s.fuel = Math.max(0, s.fuel - st.fuelBurn * 0.5 * retro * dt);
  }
  s.retroing = retro;
  const strafe = hasFuel && st.strafe > 0 ? clamp(c.strafe, -1, 1) : 0;
  if (strafe !== 0) {
    // starboard is heading rotated -90deg: (cy, -cx)
    ax += cy * st.strafe * strafe * massInv; ay -= cx * st.strafe * strafe * massInv;
    s.fuel = Math.max(0, s.fuel - st.fuelBurn * 0.5 * Math.abs(strafe) * dt);
  }
  s.strafing = strafe;

  s.vel.x += ax * dt; s.vel.y += ay * dt;

  // soft speed cap
  const cap = boosting ? st.boostMax : st.maxSpeed;
  const sp = Math.hypot(s.vel.x, s.vel.y);
  if (sp > cap) {
    const excess = sp - cap;
    const decel = excess * 0.7 + 2;
    const k = Math.max(0, 1 - (decel / sp) * dt);
    s.vel.x *= k; s.vel.y *= k;
  }

  const ox = s.pos.x, oy = s.pos.y;
  s.pos.x += s.vel.x * dt; s.pos.y += s.vel.y * dt;
  if (s === w.player) w.stats.distance += Math.hypot(s.pos.x - ox, s.pos.y - oy);

  // star heat
  const star = w.star;
  const dStar = Math.hypot(s.pos.x - star.pos.x, s.pos.y - star.pos.y);
  if (dStar < star.heatRadius) {
    const f = 1 - (dStar - star.radius) / (star.heatRadius - star.radius);
    const dmg = Math.max(0, f) * 28 / st.heatResist * dt;
    if (dmg > 0) damageShip(w, s, dmg, 'none', 'heat');
    if (dStar < star.radius * 1.02) damageShip(w, s, 1000, 'none', 'star');
  }
  // solar flare radiation: exposed unless in a planet's shadow cone
  if (w.flare.active && w.flare.intensity > 0 && !inShadow(w, s.pos)) {
    damageShip(w, s, 7 * w.flare.intensity / st.heatResist * dt, 'none', 'flare');
  }
  if (s.invuln > 0) s.invuln -= dt;
  s.heat = Math.max(0, s.heat - dt * 0.35);
  if (s.overheated && s.heat < 0.3) s.overheated = false;
  void gmag;
  resolveTerrain(w, s, dt);
  outOfBounds(w, s);
}

/** True if the point is within a planet's shadow (star light blocked). */
export function inShadow(w: World, p: V2): boolean {
  const sx = w.star.pos.x, sy = w.star.pos.y;
  for (const b of w.bodies) {
    if (b.kind === 'star') continue;
    const bx = b.pos.x - sx, by = b.pos.y - sy;
    const bl = Math.hypot(bx, by);
    if (bl < 1) continue;
    const ux = bx / bl, uy = by / bl;
    const px = p.x - sx, py = p.y - sy;
    const along = px * ux + py * uy;
    if (along < bl) continue;
    const perp = Math.abs(px * uy - py * ux);
    if (perp < b.radius * 1.15 && along < bl + b.radius * 14) return true;
  }
  return false;
}

function outOfBounds(w: World, s: Ship): void {
  const d = Math.hypot(s.pos.x, s.pos.y);
  const lim = w.systemRadius * 1.15;
  if (d > lim) {
    // nudge back toward the system: the edge of known space
    const k = (d - lim) / d;
    s.vel.x -= s.pos.x * k * 0.6; s.vel.y -= s.pos.y * k * 0.6;
  }
}

/** Terrain contact for a ship: landing, crashing, sliding. */
function resolveTerrain(w: World, s: Ship, dt: number): void {
  for (const b of w.bodies) {
    const dx = s.pos.x - b.pos.x, dy = s.pos.y - b.pos.y;
    const dist = Math.hypot(dx, dy);
    const maxR = maxTerrainRadius(b) + s.radius + 2;
    if (dist > maxR) continue;
    if (b.kind === 'star') {
      if (dist < b.radius) damageShip(w, s, 1000, 'none', 'star');
      continue;
    }
    const ang = Math.atan2(dy, dx);
    const surf = terrainRadiusAt(b, ang);
    const pen = surf + s.radius * 0.72 - dist;
    if (pen <= 0) continue;
    if (b.kind === 'gas') {
      // gas giant atmosphere: no solid surface, but crushing pressure deeper in
      const depth = pen / (b.radius * 0.1);
      damageShip(w, s, (4 + 40 * depth) * dt, 'none', 'atmosphere');
      // drag (thick atmosphere) and fuel scooping
      const k = Math.exp(-1.2 * dt);
      s.vel.x = b.vel.x + (s.vel.x - b.vel.x) * k;
      s.vel.y = b.vel.y + (s.vel.y - b.vel.y) * k;
      if (s === w.player && s.fuel < s.fuelMax) {
        s.fuel = Math.min(s.fuelMax, s.fuel + 9 * dt);
        if (w.tick % 30 === 0) sfx(w, 'scoop', s.pos, 0.4);
      }
      continue;
    }
    const n = terrainNormalAt(b, ang);
    const rvx = s.vel.x - b.vel.x, rvy = s.vel.y - b.vel.y;
    const vn = rvx * n.x + rvy * n.y;           // negative = moving into surface
    const tvx = rvx - vn * n.x, tvy = rvy - vn * n.y;
    const vt = Math.hypot(tvx, tvy);
    // push out
    s.pos.x += n.x * pen; s.pos.y += n.y * pen;
    if (vn >= 0) continue; // moving away (just launched or bouncing)

    const seg = terrainSegmentAt(b, ang);
    let pad: Pad | null = null;
    for (const p of b.pads) if (p.segIndex === seg && p.alive !== false) { pad = p; break; }
    const radial = { x: dx / dist, y: dy / dist };
    const slope = Math.acos(clamp(n.x * radial.x + n.y * radial.y, -1, 1));
    const headingErr = Math.abs(angleDiff(s.angle, Math.atan2(n.y, n.x)));
    const tol = s.stats.landTol;
    const flatEnough = pad !== null || slope < 0.20;
    const gentle = -vn < LAND_VN * tol && vt < LAND_VT * tol && headingErr < LAND_ANG * tol;

    if (flatEnough && gentle && !(s.ai && s.faction === 'enemy' && s.kind !== 'reaver')) {
      // touchdown: seat the ship on its struts just outside the rim so it stays visible
      s.pos.x += n.x * 0.3; s.pos.y += n.y * 0.3;
      s.landed = { body: b, pad, offset: { x: s.pos.x - b.pos.x, y: s.pos.y - b.pos.y }, angle: Math.atan2(n.y, n.x) };
      s.vel.x = b.vel.x; s.vel.y = b.vel.y;
      s.angle = s.landed.angle;
      s.angVel = 0;
      s.crashSpeed = -vn;
      if (s === w.player) {
        w.stats.landings++;
        sfx(w, 'land', s.pos, 0.9, -vn / LAND_VN);
      }
      return;
    }
    // impact
    const impact = -vn;
    let dmg = 0;
    if (impact > 2.2) dmg += Math.pow(impact - 2.2, 1.55) * 1.7;
    if (vt > 3) dmg += (vt - 3) * 1.5;
    if (!flatEnough && impact <= 2.2 && vt <= 3) dmg += 0.5; // grinding on a slope
    if (headingErr > LAND_ANG * tol && impact <= LAND_VN * tol && flatEnough) dmg += 4 + impact * 2; // came in on the wrong side
    if (dmg > 0) {
      damageShip(w, s, dmg, 'none', 'impact');
      if (s === w.player) { w.stats.crashes++; w.screenShake = Math.min(1, w.screenShake + Math.min(1, dmg / 30)); }
      sfx(w, 'impact', s.pos, Math.min(1, 0.3 + dmg / 40), impact);
      w.explosions.push({ pos: { x: s.pos.x, y: s.pos.y }, time: w.time, size: Math.min(2.5, 0.4 + dmg / 25), color: [1, 0.7, 0.3] });
    }
    // bounce with restitution, friction along the surface
    const rest = impact > 6 ? 0.35 : 0.15;
    const fric = 0.55;
    s.vel.x = b.vel.x + tvx * fric - vn * rest * n.x;
    s.vel.y = b.vel.y + tvy * fric - vn * rest * n.y;
    // sliding on slopes: gravity component along the slope keeps acting, that's fine
    s.angVel += (Math.random() - 0.5) * impact * 0.4;
  }
}

export type DamageSource = 'weapon' | 'impact' | 'heat' | 'star' | 'collision' | 'flare' | 'atmosphere' | 'explosion' | 'none';

export function damageShip(w: World, s: Ship, amount: number, by: import('./world').Faction, source: DamageSource): void {
  if (!s.alive || amount <= 0) return;
  if (s.invuln > 0 && source === 'weapon') return;
  if (s.shield > 0) {
    const absorbed = Math.min(s.shield, amount * 0.7);
    s.shield -= absorbed;
    amount -= absorbed;
  }
  s.hull -= amount;
  s.lastHitBy = by;
  s.lastDamageTime = w.time;
  s.lastDamageSource = source;
  if (s === w.player) {
    w.lastPlayerHit = w.time;
    if (source === 'weapon' || source === 'collision' || source === 'explosion') w.screenShake = Math.min(1, w.screenShake + 0.15 + amount / 60);
  }
  if (s.hull <= 0) {
    s.hull = 0;
    killShip(w, s, source);
  }
}

export function killShip(w: World, s: Ship, source: DamageSource): void {
  if (!s.alive) return;
  s.alive = false;
  const big = s.radius > 2;
  w.explosions.push({ pos: { x: s.pos.x, y: s.pos.y }, time: w.time, size: big ? 4 : 1.6, color: s.faction === 'enemy' ? [1, 0.35, 0.2] : [1, 0.8, 0.4] });
  sfx(w, big ? 'bigboom' : 'explode', s.pos, 1, s.radius);
  if (s.towing) { s.towing.carriedBy = null; s.towing = null; }
  if (s.ai?.carrying) {
    const p = s.ai.carrying;
    p.carriedBy = null;
    p.vel.x = s.vel.x; p.vel.y = s.vel.y;
    s.ai.carrying = null;
  }
  if (s.faction === 'enemy' && s.lastHitBy === 'player') {
    w.kills++;
    w.score += s.bounty;
    w.credits += Math.round(s.bounty * 0.5);
    w.bounties += Math.round(s.bounty * 0.5);
    if (s.kind === 'dreadnought') comm(w, 'CONTROL', 'DREADNOUGHT DESTROYED. OUTSTANDING, PILOT.', [1, 0.9, 0.5], 1);
  }
  if (s.faction === 'civ' && s.kind === 'freighter') {
    // drop cargo
    for (let i = 0; i < 3; i++) spawnPickup(w, 'salvage', s.pos.x + (w.rng.next() - 0.5) * 3, s.pos.y + (w.rng.next() - 0.5) * 3, s.vel.x + (w.rng.next() - 0.5) * 6, s.vel.y + (w.rng.next() - 0.5) * 6, 40);
  }
  if (s.faction === 'enemy' && (s.kind === 'lancer' || s.kind === 'reaver' || s.kind === 'dreadnought') && w.rng.chance(0.5)) {
    spawnPickup(w, 'salvage', s.pos.x, s.pos.y, s.vel.x * 0.5, s.vel.y * 0.5, s.kind === 'dreadnought' ? 200 : 30);
  }
  if (s === w.player) {
    w.stats.deaths++;
    w.screenShake = 1;
  }
}

export function spawnPickup(w: World, kind: Pickup['kind'], x: number, y: number, vx: number, vy: number, value: number, home: Pad | null = null, name = ''): Pickup {
  const p: Pickup = {
    id: w.nextId++, kind, pos: { x, y }, vel: { x: vx, y: vy }, radius: kind === 'pod' ? 1.0 : kind === 'wreck' ? 2.2 : 0.7,
    life: kind === 'pod' ? 1e9 : kind === 'module' || kind === 'wreck' ? 1e9 : 90, value, alive: true, carriedBy: null,
    fragile: kind === 'pod', home, moduleId: name, name, spin: (w.rng.next() - 0.5) * 3,
  };
  w.pickups.push(p);
  return p;
}

const pAcc: V2 = { x: 0, y: 0 };

export function stepProjectiles(w: World, dt: number): void {
  const list = w.projectiles;
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    p.life -= dt;
    if (p.life <= 0) { list.splice(i, 1); continue; }
    if (p.gravMul !== 0) {
      gravityAt(w, p.pos.x, p.pos.y, pAcc);
      p.vel.x += pAcc.x * p.gravMul * dt; p.vel.y += pAcc.y * p.gravMul * dt;
    }
    if (p.seekTarget && p.seekTarget.alive) {
      const t = p.seekTarget;
      const dx = t.pos.x - p.pos.x, dy = t.pos.y - p.pos.y;
      const d = Math.hypot(dx, dy) || 1;
      const sp = Math.hypot(p.vel.x, p.vel.y) || 1;
      const turn = 2.6 * dt;
      const want = Math.atan2(dy, dx), have = Math.atan2(p.vel.y, p.vel.x);
      const diff = angleDiff(have, want);
      const na = have + clamp(diff, -turn, turn);
      const nsp = Math.min(sp + 25 * dt, 90);
      p.vel.x = Math.cos(na) * nsp; p.vel.y = Math.sin(na) * nsp;
      void d;
    }
    p.prevPos.x = p.pos.x; p.prevPos.y = p.pos.y;
    p.pos.x += p.vel.x * dt; p.pos.y += p.vel.y * dt;
    // terrain / star
    let dead = false;
    for (const b of w.bodies) {
      const dx = p.pos.x - b.pos.x, dy = p.pos.y - b.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist > maxTerrainRadius(b) + 1) continue;
      const ang = Math.atan2(dy, dx);
      const surf = b.kind === 'star' ? b.radius : terrainRadiusAt(b, ang);
      if (dist < surf + 0.2) {
        dead = true;
        if (b.kind !== 'star' && b.kind !== 'gas') {
          w.explosions.push({ pos: { x: p.pos.x, y: p.pos.y }, time: w.time, size: 0.25, color: p.color });
          if (p.faction === 'player') {
            for (const pad of b.pads) {
              if (!pad.alive || (pad.kind !== 'enemybase' && pad.kind !== 'core')) continue;
              const arc = Math.abs(angleDiff(pad.angle, ang)) * b.radius;
              if (arc < pad.halfWidth * 1.6) { damageBase(w, pad, p.damage); w.explosions.push({ pos: { x: p.pos.x, y: p.pos.y }, time: w.time, size: 0.6, color: [1, 0.4, 0.3] }); }
            }
          }
        }
        break;
      }
    }
    if (dead) { list.splice(i, 1); continue; }
    const d0 = Math.hypot(p.pos.x, p.pos.y);
    if (d0 > w.systemRadius * 1.3) list.splice(i, 1);
  }
}

export function stepAsteroids(w: World, dt: number): void {
  const list = w.asteroids;
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    if (!a.alive) { list.splice(i, 1); continue; }
    gravityAt(w, a.pos.x, a.pos.y, pAcc);
    a.vel.x += pAcc.x * dt; a.vel.y += pAcc.y * dt;
    a.pos.x += a.vel.x * dt; a.pos.y += a.vel.y * dt;
    a.spinAngle += a.spinRate * dt;
    // bodies
    for (const b of w.bodies) {
      const dx = a.pos.x - b.pos.x, dy = a.pos.y - b.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist > maxTerrainRadius(b) + a.radius + 1) continue;
      const surf = b.kind === 'star' ? b.radius : terrainRadiusAt(b, Math.atan2(dy, dx));
      if (dist < surf + a.radius * 0.6) {
        a.alive = false;
        if (b.kind !== 'star') {
          w.explosions.push({ pos: { x: a.pos.x, y: a.pos.y }, time: w.time, size: 0.6 + a.size * 0.5, color: [1, 0.75, 0.4] });
          sfx(w, 'impact', a.pos, 0.6, 12);
          // meteor strike on a pad?
          const ang = Math.atan2(dy, dx);
          for (const p of b.pads) {
            const d = Math.abs(angleDiff(p.angle, ang)) * b.radius;
            if (d < p.halfWidth + a.radius * 2 && p.alive && p.kind !== 'enemybase' && p.kind !== 'core') {
              padDamaged(w, p, a.rogue ? 45 : 4 * a.size);
            }
          }
        }
        break;
      }
    }
  }
}

/** Enemy base pads take damage from player fire. */
export function damageBase(w: World, pad: Pad, amount: number): void {
  if (!pad.alive) return;
  pad.enemyHealth -= amount;
  if (pad.enemyHealth <= 0) {
    pad.alive = false;
    w.stats.basesDestroyed++;
    const px = pad.body.pos.x + Math.cos(pad.angle) * (pad.height + 2), py = pad.body.pos.y + Math.sin(pad.angle) * (pad.height + 2);
    w.explosions.push({ pos: { x: px, y: py }, time: w.time, size: 4, color: [1, 0.4, 0.3] });
    sfx(w, 'bigboom', { x: px, y: py }, 1, 5);
    if (pad.kind === 'core') {
      w.coreDestroyed = true;
      w.score += 10000;
      w.credits += 3000;
      comm(w, 'CONTROL', 'THE STARFALL IS DARK. THE SYSTEM IS YOURS, KESTREL. +10000', [1, 0.9, 0.5], 3);
    } else {
      w.score += 2500;
      w.credits += 600;
      comm(w, 'CONTROL', `${pad.name} DESTROYED. RAIDS WILL THIN OUT. +600 CR`, [0.6, 1, 0.7], 2);
    }
  }
}

export function padDamaged(w: World, p: Pad, amount: number): void {
  if (!p.alive) return;
  if (p.kind === 'colony' || p.kind === 'mine' || p.kind === 'outpost') {
    p.integrity -= amount;
    if (p.kind === 'colony' && amount >= 15) p.population = Math.max(0, p.population - 1);
    if (p.integrity <= 0) {
      p.alive = false;
      p.integrity = 0;
      w.explosions.push({ pos: { x: p.body.pos.x + Math.cos(p.angle) * (p.height + 2), y: p.body.pos.y + Math.sin(p.angle) * (p.height + 2) }, time: w.time, size: 3, color: [1, 0.5, 0.3] });
      comm(w, p.name, `${p.name} HAS GONE SILENT.`, [1, 0.4, 0.3], 3, p.body.pos);
      w.lost += p.population;
      p.population = 0;
    } else if (amount >= 15) {
      comm(w, p.name, `${p.name} HIT. STRUCTURAL INTEGRITY ${Math.round(p.integrity)}%.`, [1, 0.6, 0.3], 2, p.body.pos);
    }
  }
}

export function stepPickups(w: World, dt: number): void {
  const list = w.pickups;
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    if (!p.alive) { list.splice(i, 1); continue; }
    if (p.carriedBy) {
      if (!p.carriedBy.alive) { p.carriedBy = null; }
      else {
        const c = p.carriedBy;
        // trail slightly behind the carrier
        const bx = c.pos.x - Math.cos(c.angle) * (c.radius + p.radius + 0.6);
        const by = c.pos.y - Math.sin(c.angle) * (c.radius + p.radius + 0.6);
        p.pos.x = damp(p.pos.x, bx, 12, dt); p.pos.y = damp(p.pos.y, by, 12, dt);
        p.vel.x = c.vel.x; p.vel.y = c.vel.y;
        continue;
      }
    }
    p.life -= dt;
    if (p.life <= 0) { list.splice(i, 1); continue; }
    gravityAt(w, p.pos.x, p.pos.y, pAcc);
    p.vel.x += pAcc.x * dt; p.vel.y += pAcc.y * dt;
    p.pos.x += p.vel.x * dt; p.pos.y += p.vel.y * dt;
    for (const b of w.bodies) {
      const dx = p.pos.x - b.pos.x, dy = p.pos.y - b.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist > maxTerrainRadius(b) + p.radius + 1) continue;
      if (b.kind === 'star') { if (dist < b.radius) { p.alive = false; } continue; }
      const ang = Math.atan2(dy, dx);
      const surf = terrainRadiusAt(b, ang);
      const pen = surf + p.radius * 0.6 - dist;
      if (pen > 0) {
        const n = terrainNormalAt(b, ang);
        const rvx = p.vel.x - b.vel.x, rvy = p.vel.y - b.vel.y;
        const vn = rvx * n.x + rvy * n.y;
        p.pos.x += n.x * pen; p.pos.y += n.y * pen;
        if (vn < 0) {
          if (p.fragile && -vn > 6) {
            p.alive = false;
            w.explosions.push({ pos: { x: p.pos.x, y: p.pos.y }, time: w.time, size: 0.8, color: [1, 0.5, 0.3] });
            sfx(w, 'impact', p.pos, 0.6, 8);
            if (p.kind === 'pod') { w.lost++; comm(w, 'CONTROL', 'POD LOST ON IMPACT.', [1, 0.4, 0.3], 2, p.pos); }
          } else if (p.kind === 'pod' && p.home && p.home.body === b) {
            // pod came home: it re-enters the colony
            const d = Math.abs(angleDiff(p.home.angle, ang)) * b.radius;
            if (d < p.home.halfWidth * 3) {
              p.alive = false;
              p.home.population += 1;
              w.score += 150;
              comm(w, p.home.name, 'POD RECOVERED. THANK YOU, KESTREL.', [0.6, 1, 0.7], 1, p.pos);
              sfx(w, 'pickup', p.pos, 0.8);
              continue;
            }
            p.vel.x = b.vel.x + (rvx - vn * n.x) * 0.5; p.vel.y = b.vel.y + (rvy - vn * n.y) * 0.5;
          } else {
            p.vel.x = b.vel.x + (rvx - vn * n.x) * 0.5 - vn * 0.2 * n.x;
            p.vel.y = b.vel.y + (rvy - vn * n.y) * 0.5 - vn * 0.2 * n.y;
          }
        }
      }
    }
  }
}

export interface Trajectory {
  pts: Float32Array; // x, y pairs
  count: number;
  impact: boolean;
  impactBody: Body | null;
  impactX: number;
  impactY: number;
  impactSpeed: number;
}

/** Integrate ahead with gravity only. Uses coarse steps; stops at terrain. */
export function predictTrajectory(w: World, x: number, y: number, vx: number, vy: number, gravMul: number, seconds: number, step: number, out: Trajectory, ignoreBody: Body | null = null): void {
  const n = Math.floor(seconds / step);
  if (out.pts.length < n * 2) out.pts = new Float32Array(n * 2);
  out.count = 0; out.impact = false; out.impactBody = null; out.impactSpeed = 0;
  let px = x, py = y, pvx = vx, pvy = vy;
  const acc: V2 = { x: 0, y: 0 };
  for (let i = 0; i < n; i++) {
    gravityAt(w, px, py, acc);
    pvx += acc.x * gravMul * step; pvy += acc.y * gravMul * step;
    px += pvx * step; py += pvy * step;
    out.pts[i * 2] = px; out.pts[i * 2 + 1] = py;
    out.count = i + 1;
    for (const b of w.bodies) {
      if (b === ignoreBody) continue;
      const dx = px - b.pos.x, dy = py - b.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > maxTerrainRadius(b) + 1) continue;
      const surf = b.kind === 'star' ? b.radius : terrainRadiusAt(b, Math.atan2(dy, dx));
      if (d < surf + 0.7) {
        out.impact = true; out.impactBody = b; out.impactX = px; out.impactY = py;
        out.impactSpeed = Math.hypot(pvx - b.vel.x, pvy - b.vel.y);
        return;
      }
    }
  }
}

/** Circle-circle collisions between ships, ships and asteroids, projectiles and targets, pickups. */
export function collide(w: World, dt: number): void {
  const ships = w.ships;
  // projectiles vs ships and asteroids
  const pr = w.projectiles;
  for (let i = pr.length - 1; i >= 0; i--) {
    const p = pr[i];
    let hit = false;
    for (const s of ships) {
      if (!s.alive || s.docked) continue;
      if (s.faction === p.faction) continue;
      if (p.faction === 'civ' && s.faction === 'player') continue;
      if (s.id === p.owner) continue;
      if (segCircle(p.prevPos.x, p.prevPos.y, p.pos.x, p.pos.y, s.pos.x, s.pos.y, s.radius + p.radius)) {
        damageShip(w, s, p.damage, p.faction, 'weapon');
        if (s.ai) s.ai.memory = w.time;
        w.explosions.push({ pos: { x: p.pos.x, y: p.pos.y }, time: w.time, size: 0.35, color: p.color });
        sfx(w, s === w.player ? 'hitme' : 'hit', p.pos, 0.6);
        hit = true;
        break;
      }
    }
    if (!hit) {
      for (const a of w.asteroids) {
        if (!a.alive) continue;
        if (segCircle(p.prevPos.x, p.prevPos.y, p.pos.x, p.pos.y, a.pos.x, a.pos.y, a.radius + p.radius)) {
          a.hp -= p.damage;
          // push the asteroid a little
          const m = a.radius * a.radius;
          a.vel.x += p.vel.x * 0.02 / m * p.damage; a.vel.y += p.vel.y * 0.02 / m * p.damage;
          w.explosions.push({ pos: { x: p.pos.x, y: p.pos.y }, time: w.time, size: 0.3, color: [1, 0.85, 0.6] });
          if (a.hp <= 0) breakAsteroid(w, a, p.faction);
          else sfx(w, 'rockhit', p.pos, 0.5);
          hit = true;
          break;
        }
      }
    }
    if (!hit) {
      for (const st of w.stations) {
        if (!st.alive || p.faction !== 'enemy') continue;
        if (segCircle(p.prevPos.x, p.prevPos.y, p.pos.x, p.pos.y, st.pos.x, st.pos.y, st.radius)) {
          st.health -= p.damage * 0.5;
          w.explosions.push({ pos: { x: p.pos.x, y: p.pos.y }, time: w.time, size: 0.4, color: p.color });
          hit = true;
          break;
        }
      }
    }
    if (hit) pr.splice(i, 1);
  }
  // ships vs asteroids and ships vs ships
  for (let i = 0; i < ships.length; i++) {
    const s = ships[i];
    if (!s.alive || s.docked || s.landed) continue;
    for (const a of w.asteroids) {
      if (!a.alive) continue;
      const dx = s.pos.x - a.pos.x, dy = s.pos.y - a.pos.y;
      const rr = s.radius * 0.8 + a.radius * 0.85;
      const d2 = dx * dx + dy * dy;
      if (d2 < rr * rr) {
        const d = Math.sqrt(d2) || 0.001;
        const nx = dx / d, ny = dy / d;
        const rvx = s.vel.x - a.vel.x, rvy = s.vel.y - a.vel.y;
        const vn = rvx * nx + rvy * ny;
        const pen = rr - d;
        const ma = a.radius * a.radius * 2, ms = s.radius * s.radius * s.massMul;
        const tot = ma + ms;
        s.pos.x += nx * pen * (ma / tot); s.pos.y += ny * pen * (ma / tot);
        a.pos.x -= nx * pen * (ms / tot); a.pos.y -= ny * pen * (ms / tot);
        if (vn < 0) {
          const j = -(1.3) * vn / (1 / ma + 1 / ms);
          s.vel.x += nx * j / ms; s.vel.y += ny * j / ms;
          a.vel.x -= nx * j / ma; a.vel.y -= ny * j / ma;
          const impact = -vn;
          if (impact > 3) {
            damageShip(w, s, Math.pow(impact - 3, 1.4) * 1.2 * (0.6 + a.size * 0.25), 'none', 'collision');
            sfx(w, 'impact', s.pos, Math.min(1, impact / 15), impact);
            if (s === w.player) w.screenShake = Math.min(1, w.screenShake + impact / 30);
            a.hp -= impact * 1.5 * ms;
            if (a.hp <= 0) breakAsteroid(w, a, 'none');
          }
        }
      }
    }
    for (let j = i + 1; j < ships.length; j++) {
      const o = ships[j];
      if (!o.alive || o.docked || o.landed) continue;
      const dx = s.pos.x - o.pos.x, dy = s.pos.y - o.pos.y;
      const rr = (s.radius + o.radius) * 0.85;
      const d2 = dx * dx + dy * dy;
      if (d2 < rr * rr) {
        const d = Math.sqrt(d2) || 0.001;
        const nx = dx / d, ny = dy / d;
        const rvx = s.vel.x - o.vel.x, rvy = s.vel.y - o.vel.y;
        const vn = rvx * nx + rvy * ny;
        const pen = rr - d;
        const ms = s.radius * s.radius * s.massMul, mo = o.radius * o.radius * o.massMul;
        const tot = ms + mo;
        s.pos.x += nx * pen * (mo / tot); s.pos.y += ny * pen * (mo / tot);
        o.pos.x -= nx * pen * (ms / tot); o.pos.y -= ny * pen * (ms / tot);
        if (vn < 0) {
          const jimp = -(1.2) * vn / (1 / ms + 1 / mo);
          s.vel.x += nx * jimp / ms; s.vel.y += ny * jimp / ms;
          o.vel.x -= nx * jimp / mo; o.vel.y -= ny * jimp / mo;
          const impact = -vn;
          if (impact > 4) {
            const dmg = Math.pow(impact - 4, 1.3) * 1.5;
            damageShip(w, s, dmg * (mo / tot) * 2, o.faction, 'collision');
            damageShip(w, o, dmg * (ms / tot) * 2, s.faction, 'collision');
            sfx(w, 'impact', s.pos, Math.min(1, impact / 15), impact);
          }
        }
      }
    }
  }
  // pickups vs player (and reavers handled in AI)
  const pl = w.player;
  if (pl.alive && !pl.docked) {
    for (const p of w.pickups) {
      if (!p.alive || p.carriedBy) continue;
      const dx = p.pos.x - pl.pos.x, dy = p.pos.y - pl.pos.y;
      const d = Math.hypot(dx, dy);
      const reach = pl.tractor ? 14 : 0;
      if (d < pl.radius + p.radius + 0.5) {
        collectPickup(w, pl, p);
      } else if (reach > 0 && d < reach && p.kind !== 'wreck') {
        // tractor beam: pull gently toward the player
        const k = 18 * dt;
        p.vel.x = damp(p.vel.x, pl.vel.x - dx / d * 10, 4, dt);
        p.vel.y = damp(p.vel.y, pl.vel.y - dy / d * 10, 4, dt);
        void k;
      }
    }
  }
  void dt;
}

function collectPickup(w: World, pl: Ship, p: Pickup): void {
  if (p.kind === 'pod') {
    const rel = Math.hypot(p.vel.x - pl.vel.x, p.vel.y - pl.vel.y);
    if (rel > 9) {
      // too fast: the pod is destroyed
      p.alive = false;
      w.lost++;
      w.explosions.push({ pos: { x: p.pos.x, y: p.pos.y }, time: w.time, size: 0.8, color: [1, 0.5, 0.3] });
      comm(w, 'CONTROL', 'POD DESTROYED ON CONTACT. SLOW DOWN FOR PICKUPS.', [1, 0.4, 0.3], 2, p.pos);
      sfx(w, 'impact', p.pos, 0.7, 9);
      return;
    }
    if (pl.towing) return; // one at a time
    p.carriedBy = pl;
    pl.towing = p;
    sfx(w, 'pickup', p.pos, 0.8, 1);
    comm(w, 'KESTREL', 'POD SECURED. RETURN IT TO ITS COLONY OR ANY PAD.', [0.6, 1, 0.7], 1);
    return;
  }
  if (p.kind === 'wreck') return;
  if (p.kind === 'ore' || p.kind === 'salvage') {
    const load = pl.cargo.ore + pl.cargo.salvage;
    if (load >= pl.cargo.capacity) { return; }
    if (p.kind === 'ore') pl.cargo.ore += 1; else pl.cargo.salvage += 1;
    p.alive = false;
    w.score += p.value;
    sfx(w, 'pickup', p.pos, 0.7, 0);
    return;
  }
  if (p.kind === 'fuel') {
    pl.fuel = Math.min(pl.fuelMax, pl.fuel + p.value);
    p.alive = false;
    sfx(w, 'pickup', p.pos, 0.7, 2);
    comm(w, 'KESTREL', 'FUEL CELL RECOVERED.', [0.6, 1, 0.7], 0);
    return;
  }
  if (p.kind === 'module') {
    p.alive = false;
    w.score += 500;
    w.audioEvents.push({ kind: 'module', pos: p.pos, volume: 1, param: 0 });
    w.discovered.add(p.moduleId);
    comm(w, 'KESTREL', `RECOVERED: ${p.name}. INSTALLED.`, [1, 0.9, 0.5], 2);
    applyModule(w, pl, p.moduleId);
    return;
  }
}

/** Unique modules found in the world (not purchasable). */
export function applyModule(w: World, s: Ship, id: string): void {
  if (!s.modules.includes(id)) s.modules.push(id);
  switch (id) {
    case 'gravlens': s.stats.gravMul *= 0.7; break;
    case 'ancientcore': s.stats.boostThrust *= 1.4; s.stats.boostBurn *= 0.6; break;
    case 'phase': s.shield = 60; s.hullMax += 40; s.hull += 40; break;
    case 'coldfusion': s.stats.fuelBurn *= 0.5; break;
    case 'gyros': s.stats.turnRate *= 1.4; break;
    case 'seekers': s.secondary = { ...makeWeaponFor('seeker'), ammo: 12 }; break;
  }
  void w;
}

import { makeWeapon as makeWeaponFor } from './world';

export function breakAsteroid(w: World, a: Asteroid, by: import('./world').Faction): void {
  if (!a.alive) return;
  a.alive = false;
  w.explosions.push({ pos: { x: a.pos.x, y: a.pos.y }, time: w.time, size: 0.5 + a.size * 0.5, color: a.rich ? [1, 0.9, 0.4] : [0.8, 0.75, 0.7] });
  sfx(w, 'rockbreak', a.pos, 0.6 + a.size * 0.15, a.size);
  if (by === 'player') w.score += 5 * a.size;
  if (a.size > 1) {
    const n = a.size === 3 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * TAU + w.rng.next();
      const sp = 3 + w.rng.next() * 4;
      const f = createAsteroid(w, a.pos.x + Math.cos(ang) * a.radius * 0.5, a.pos.y + Math.sin(ang) * a.radius * 0.5, a.vel.x + Math.cos(ang) * sp, a.vel.y + Math.sin(ang) * sp, a.size - 1, a.field);
      f.rich = a.rich;
    }
  }
  const oreN = a.rich ? 2 + a.size : (a.size === 1 ? 1 : 0);
  for (let i = 0; i < oreN; i++) {
    const ang = w.rng.next() * TAU;
    spawnPickup(w, 'ore', a.pos.x, a.pos.y, a.vel.x + Math.cos(ang) * 2, a.vel.y + Math.sin(ang) * 2, a.rich ? 25 : 10);
  }
}

export function createAsteroid(w: World, x: number, y: number, vx: number, vy: number, size: number, field: number): Asteroid {
  const r = size === 3 ? 3.2 + w.rng.next() * 1.6 : size === 2 ? 1.8 + w.rng.next() * 0.7 : 0.9 + w.rng.next() * 0.4;
  const ax = w.rng.gauss(), ay = w.rng.gauss(), az = w.rng.gauss();
  const l = Math.hypot(ax, ay, az) || 1;
  const a: Asteroid = {
    id: w.nextId++, pos: { x, y }, vel: { x: vx, y: vy }, radius: r, hp: size === 3 ? 60 : size === 2 ? 30 : 12,
    variant: w.rng.int(1000), spinAxis: [ax / l, ay / l, az / l], spinRate: (w.rng.next() - 0.5) * 1.5, spinAngle: w.rng.next() * TAU,
    size, ore: size, rich: false, field, alive: true, rogue: false,
  };
  w.asteroids.push(a);
  return a;
}

function segCircle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, r: number): boolean {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = 0;
  if (l2 > 1e-9) t = clamp(((cx - ax) * dx + (cy - ay) * dy) / l2, 0, 1);
  const px = ax + dx * t - cx, py = ay + dy * t - cy;
  return px * px + py * py < r * r;
}

export function fireWeapon(w: World, s: Ship, weapon: import('./world').Weapon, target: Ship | null = null): boolean {
  if (s.fireCooldown > 0) return false;
  if (s.overheated) return false;
  if (weapon.ammo === 0) return false;
  s.fireCooldown = weapon.cooldown;
  if (weapon.ammo > 0) weapon.ammo--;
  if (s === w.player) {
    s.heat += weapon.heat;
    if (s.heat >= 1) { s.overheated = true; s.heat = 1; sfx(w, 'overheat', s.pos, 0.8); }
  }
  const color = projectileColor(weapon.kind, s.faction);
  for (let i = 0; i < weapon.count; i++) {
    const spread = weapon.count > 1 ? (i / (weapon.count - 1) - 0.5) * weapon.spread * 2 : (w.rng.next() - 0.5) * weapon.spread * 2;
    const ang = s.angle + spread;
    const muzzle = s.radius + 0.4;
    const p: Projectile = {
      id: w.nextId++,
      pos: { x: s.pos.x + Math.cos(ang) * muzzle, y: s.pos.y + Math.sin(ang) * muzzle },
      vel: { x: s.vel.x + Math.cos(ang) * weapon.speed, y: s.vel.y + Math.sin(ang) * weapon.speed },
      life: weapon.life, faction: s.faction, damage: weapon.damage, kind: weapon.kind, radius: weapon.radius,
      gravMul: weapon.gravMul, owner: s.id, seekTarget: weapon.kind === 'seeker' ? target : null, color,
      prevPos: { x: 0, y: 0 },
    };
    p.prevPos.x = p.pos.x; p.prevPos.y = p.pos.y;
    w.projectiles.push(p);
  }
  // recoil for heavy weapons
  if (weapon.kind === 'mass') { s.vel.x -= Math.cos(s.angle) * 1.5 / s.massMul; s.vel.y -= Math.sin(s.angle) * 1.5 / s.massMul; }
  sfx(w, 'fire_' + weapon.kind, s.pos, s === w.player ? 0.8 : 0.45);
  return true;
}

export function projectileColor(kind: import('./world').WeaponKind, faction: import('./world').Faction): number[] {
  if (faction === 'enemy') return kind === 'mass' ? [1, 0.45, 0.15] : [1, 0.3, 0.25];
  switch (kind) {
    case 'pulse': return [0.55, 1, 0.85];
    case 'scatter': return [1, 0.95, 0.5];
    case 'rail': return [0.7, 0.85, 1];
    case 'mass': return [1, 0.7, 0.3];
    case 'seeker': return [1, 0.6, 0.9];
    case 'lance': return [1, 0.5, 0.3];
  }
}

export { v2len };
