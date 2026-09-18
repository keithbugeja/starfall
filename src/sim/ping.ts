// Ping: an active sensor pulse. It returns geometry and material differences for the player to
// interpret: terrain edges flash as the ring sweeps them, walls of hidden hollows flash, dense
// objects blink, hollow bodies answer with an echo ring, and some things react in their own way.
// It labels nothing.
import type { World } from './world';

export interface Ping {
  x: number;
  y: number;
  t0: number;
  r: number;
  speed: number;
  maxR: number;
  echo: boolean;        // an echo returned by a hollow body
  hit: Set<number>;     // ids already registered
  bodiesHit: Set<number>;
}

export const PING_COOLDOWN = 1.6;
export const PING_SPEED = 150;
export const PING_RANGE = 460;

export function emitPing(w: World, x: number, y: number, echo = false, maxR = PING_RANGE): void {
  w.pings.push({ x, y, t0: w.time, r: 0, speed: echo ? 90 : PING_SPEED, maxR, echo, hit: new Set(), bodiesHit: new Set() });
  if (!echo) { w.audioEvents.push({ kind: 'ping', pos: null, volume: 0.7, param: 0 }); }
  else w.audioEvents.push({ kind: 'echo', pos: { x, y }, volume: 0.9, param: 1 });
}

export function updatePings(w: World, dt: number): void {
  const t = w.time;
  for (let i = w.pings.length - 1; i >= 0; i--) {
    const p = w.pings[i];
    p.r += p.speed * dt;
    if (p.r > p.maxR) { w.pings.splice(i, 1); continue; }
    if (p.echo) continue;
    const r2 = p.r * p.r;
    // pickups: dense objects blink as the ring passes
    for (const k of w.pickups) {
      if (!k.alive || p.hit.has(k.id)) continue;
      const dx = k.pos.x - p.x, dy = k.pos.y - p.y;
      if (dx * dx + dy * dy <= r2) {
        p.hit.add(k.id);
        k.flashUntil = t + (k.kind === 'prop' || k.kind === 'log' || k.kind === 'module' ? 3.0 : 1.4);
        w.audioEvents.push({ kind: 'return', pos: k.pos, volume: 0.35, param: k.kind === 'prop' ? 2 : 0 });
      }
    }
    for (const a of w.asteroids) {
      if (!a.alive || p.hit.has(a.id)) continue;
      const dx = a.pos.x - p.x, dy = a.pos.y - p.y;
      if (dx * dx + dy * dy <= r2) { p.hit.add(a.id); a.flashUntil = t + 1.0; }
    }
    for (const s of w.ships) {
      if (!s.alive || s.docked || p.hit.has(s.id)) continue;
      const dx = s.pos.x - p.x, dy = s.pos.y - p.y;
      if (dx * dx + dy * dy <= r2) {
        p.hit.add(s.id);
        s.flashUntil = t + 1.4;
        // being pinged is being noticed
        if (s.faction === 'enemy' && s.ai) s.ai.memory = t;
      }
    }
    for (const b of w.bodies) {
      if (p.bodiesHit.has(b.id)) continue;
      const dx = b.pos.x - p.x, dy = b.pos.y - p.y;
      const d = Math.hypot(dx, dy);
      // fissures flash when the ring reaches their mouths (roughly the body rim)
      for (const f of b.fissures) {
        if (f.flashUntil > t) continue;
        if (d - b.maxRadius <= p.r && d + b.maxRadius >= p.r - 40) f.flashUntil = t + 2.6;
      }
      if (d <= p.r) {
        p.bodiesHit.add(b.id);
        w.pingEvents.push({ body: b, time: t, x: p.x, y: p.y });
        if (b.hollow) {
          // a hollow thing rings back
          w.pings.push({ x: b.pos.x, y: b.pos.y, t0: t + 0.35, r: -0.35 * 90, speed: 90, maxR: Math.max(120, b.maxRadius * 6), echo: true, hit: new Set(), bodiesHit: new Set() });
          w.audioEvents.push({ kind: 'echo', pos: b.pos, volume: 0.9, param: 1 });
        }
      }
    }
    for (const st of w.stations) {
      if (!st.alive || p.hit.has(st.id)) continue;
      const dx = st.pos.x - p.x, dy = st.pos.y - p.y;
      if (dx * dx + dy * dy <= r2) { p.hit.add(st.id); st.flashUntil = t + 1.2; }
    }
  }
}
