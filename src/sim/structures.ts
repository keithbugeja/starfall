// Structures: machinery fixed to a body's surface. A plant houses a power socket, a radiator sheds the
// heat of the guns it serves, a mast is a base's long-range sensor. They have integrity and armour:
// small arms bounce off a plant's housing but a falling rock does not. Destroyed structures lose their
// function for good and leave debris where they stood.
import { TAU, type V2 } from '../engine/math';
import { surfaceVelocity, terrainNormalAt, terrainRadiusAt, type Body, type Pad } from './bodies';
import { breakSocket } from './power';
import { damageShip, spawnPickup } from './physics';
import { bodyToWorld, rotateVec } from './walls';
import { comm, sfx, type World } from './world';

export type StructureKind = 'plant' | 'radiator' | 'mast';

export interface Structure {
  id: number;
  kind: StructureKind;
  name: string;
  body: Body;
  local: V2;           // position in the body's local frame
  normalLocal: V2;     // outward surface normal in the local frame
  radius: number;
  integrity: number;
  integrityMax: number;
  armour: number;      // damage below this per hit is shrugged off
  alive: boolean;
  pad: Pad | null;     // the installation it serves
  hot: number;         // radiators: 0..1 visible heat
  hitFlash: number;
}

const SPEC: Record<StructureKind, { radius: number; integrity: number; armour: number }> = {
  plant: { radius: 1.6, integrity: 160, armour: 40 },
  radiator: { radius: 1.8, integrity: 30, armour: 0 },
  mast: { radius: 0.9, integrity: 60, armour: 5 },
};

/** Place a structure on the surface at a local angle. */
export function addStructure(w: World, body: Body, kind: StructureKind, localAngle: number, pad: Pad | null, name: string): Structure {
  const spec = SPEC[kind];
  const worldAng = localAngle + (body.rotates ? body.spinAngle : 0);
  const r = terrainRadiusAt(body, worldAng) + spec.radius * 0.6;
  const nW = terrainNormalAt(body, worldAng);
  const nL = body.rotates ? rotateVec(nW, -body.spinAngle) : nW;
  const s: Structure = {
    id: w.nextId++, kind, name, body, local: { x: Math.cos(localAngle) * r, y: Math.sin(localAngle) * r }, normalLocal: nL,
    radius: spec.radius, integrity: spec.integrity, integrityMax: spec.integrity, armour: spec.armour, alive: true, pad, hot: 0, hitFlash: -1e9,
  };
  w.structures.push(s);
  return s;
}

export function structurePos(s: Structure): V2 { return bodyToWorld(s.body, s.local); }
export function structureNormal(s: Structure): V2 { return s.body.rotates ? rotateVec(s.normalLocal, s.body.spinAngle) : s.normalLocal; }

/** Apply a hit. Armour is a per-hit threshold, so many small hits do nothing and one big one does. */
export function damageStructure(w: World, s: Structure, hit: number, source: string): void {
  if (!s.alive) return;
  const dmg = Math.max(0, hit - s.armour);
  s.hitFlash = w.time;
  if (dmg <= 0) return;
  s.integrity -= dmg;
  if (s.integrity <= 0) destroyStructure(w, s, source);
}

export function destroyStructure(w: World, s: Structure, source: string): void {
  if (!s.alive) return;
  s.alive = false;
  s.integrity = 0;
  const p = structurePos(s);
  const n = structureNormal(s);
  w.explosions.push({ pos: { x: p.x, y: p.y }, time: w.time, size: s.kind === 'plant' ? 2.2 : 1.2, color: s.kind === 'radiator' ? [1, 0.6, 0.3] : [1, 0.45, 0.6] });
  sfx(w, 'bigboom', p, 0.8, 3);
  // debris stays where it falls
  const sv = surfaceVelocity(s.body, p.x, p.y);
  const n0 = s.kind === 'plant' ? 3 : 2;
  for (let i = 0; i < n0; i++) {
    const a = Math.atan2(n.y, n.x) + (w.rng.next() - 0.5) * 1.6;
    const d = spawnPickup(w, 'wreck', p.x + n.x * 0.5, p.y + n.y * 0.5, sv.x + Math.cos(a) * (2 + w.rng.next() * 3), sv.y + Math.sin(a) * (2 + w.rng.next() * 3), 0, null, 'DEBRIS');
    d.radius = 1.0; d.mass = 1.2; d.tetherable = true;
  }
  if (s.kind === 'plant') for (const src of w.power) if (src.plant === s) breakSocket(w, src);
  const near = Math.hypot(w.player.pos.x - p.x, w.player.pos.y - p.y) < 400;
  if (near) {
    if (s.kind === 'plant') comm(w, 'SENSORS', `THE HOUSING AT ${s.pad ? s.pad.name : s.name} HAS CRACKED.`, [1, 0.6, 0.3], 2, p);
    else if (s.kind === 'radiator') comm(w, 'SENSORS', `RADIATOR FINS AT ${s.pad ? s.pad.name : s.name} ARE GONE.`, [1, 0.6, 0.3], 1, p);
    else comm(w, 'SENSORS', `THE MAST AT ${s.pad ? s.pad.name : s.name} IS DOWN.`, [1, 0.6, 0.3], 1, p);
  }
  w.log.push({ time: w.time, kind: 'structure-destroyed', text: `${s.kind.toUpperCase()} AT ${s.pad ? s.pad.name : s.name} DESTROYED BY ${source.toUpperCase()}`, x: p.x, y: p.y });
}

/** Collisions: projectiles, ships and rocks against structures. Runs after movement. */
export function stepStructures(w: World, dt: number): void {
  for (const s of w.structures) {
    if (!s.alive) continue;
    const p = structurePos(s);
    // projectiles
    const pr = w.projectiles;
    for (let i = pr.length - 1; i >= 0; i--) {
      const q = pr[i];
      if (q.faction === 'enemy') continue; // the tide does not shoot its own machinery
      if (segCircle(q.prevPos.x, q.prevPos.y, q.pos.x, q.pos.y, p.x, p.y, s.radius + q.radius)) {
        damageStructure(w, s, q.damage, 'weapon fire');
        w.explosions.push({ pos: { x: q.pos.x, y: q.pos.y }, time: w.time, size: 0.3, color: q.damage > s.armour ? [1, 0.6, 0.4] : [0.8, 0.8, 0.9] });
        sfx(w, q.damage > s.armour ? 'hit' : 'rockhit', q.pos, 0.5);
        pr.splice(i, 1);
      }
    }
    // ships bump into it; a fast ship hurts both
    for (const sh of w.ships) {
      if (!sh.alive || sh.docked || sh.landed) continue;
      const dx = sh.pos.x - p.x, dy = sh.pos.y - p.y;
      const rr = sh.radius * 0.8 + s.radius * 0.8;
      const d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2) || 0.001;
      const nx = dx / d, ny = dy / d;
      const sv = surfaceVelocity(s.body, p.x, p.y);
      const rvx = sh.vel.x - sv.x, rvy = sh.vel.y - sv.y;
      const vn = rvx * nx + rvy * ny;
      sh.pos.x += nx * (rr - d); sh.pos.y += ny * (rr - d);
      if (vn < 0) {
        sh.vel.x = sv.x + rvx - 1.3 * vn * nx; sh.vel.y = sv.y + rvy - 1.3 * vn * ny;
        const impact = -vn;
        if (impact > 3) {
          damageShip(w, sh, Math.pow(impact - 3, 1.3) * 1.5, 'none', 'collision');
          const m = sh.radius * sh.radius * sh.massMul;
          damageStructure(w, s, 0.5 * m * impact * impact, `a collision with a ${sh.name.toLowerCase()}`);
          sfx(w, 'impact', sh.pos, Math.min(1, impact / 12), impact);
        }
      }
    }
    // rocks: kinetic energy does the work
    for (const a of w.asteroids) {
      if (!a.alive) continue;
      const dx = a.pos.x - p.x, dy = a.pos.y - p.y;
      const rr = a.radius * 0.85 + s.radius * 0.8;
      const d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2) || 0.001;
      const nx = dx / d, ny = dy / d;
      const sv = surfaceVelocity(s.body, p.x, p.y);
      const rvx = a.vel.x - sv.x, rvy = a.vel.y - sv.y;
      const vn = rvx * nx + rvy * ny;
      a.pos.x += nx * (rr - d); a.pos.y += ny * (rr - d);
      if (vn < 0) {
        a.vel.x = sv.x + (rvx - vn * nx) * 0.7 - vn * 0.3 * nx; a.vel.y = sv.y + (rvy - vn * ny) * 0.7 - vn * 0.3 * ny;
        const m = a.radius * a.radius * 2;
        const e = 0.5 * m * vn * vn;
        if (e > 4) { damageStructure(w, s, e, 'a falling rock'); sfx(w, 'impact', a.pos, Math.min(1, e / 200), -vn); }
      }
    }
    // pickups (debris, cores) are pushed out gently
    for (const k of w.pickups) {
      if (!k.alive || k.carriedBy) continue;
      const dx = k.pos.x - p.x, dy = k.pos.y - p.y;
      const rr = k.radius * 0.7 + s.radius * 0.8;
      const d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2) || 0.001;
      const nx = dx / d, ny = dy / d;
      k.pos.x += nx * (rr - d); k.pos.y += ny * (rr - d);
      const sv = surfaceVelocity(s.body, p.x, p.y);
      const vn = (k.vel.x - sv.x) * nx + (k.vel.y - sv.y) * ny;
      if (vn < 0) { k.vel.x -= vn * nx * 1.2; k.vel.y -= vn * ny * 1.2; }
    }
    if (s.hot > 0) s.hot = Math.max(0, s.hot - dt * 0.2);
  }
  void TAU;
}

function segCircle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, r: number): boolean {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = 0;
  if (l2 > 1e-9) t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / l2));
  const px = ax + dx * t - cx, py = ay + dy * t - cy;
  return px * px + py * py < r * r;
}
