// Generation invariants across many seeds: nothing spawns inside anything, pads are reachable,
// stations sit clear of bodies, moons clear their parents, and the sim runs without NaNs.
import { describe, expect, it } from 'vitest';
import { generateSystem } from '../src/gen/system';
import { maxTerrainRadius, terrainRadiusAt } from '../src/sim/bodies';
import { emptyControls } from '../src/engine/input';
import { stepWorld } from '../src/sim/step';
import { SIM_DT } from '../src/sim/world';
import { hashString } from '../src/engine/math';

const SEEDS = Array.from({ length: 120 }, (_, i) => hashString('seed-' + i));

describe('system generation', () => {
  it('is deterministic for a seed', () => {
    const a = generateSystem(12345, 'a');
    const b = generateSystem(12345, 'a');
    expect(a.bodies.map(x => x.name)).toEqual(b.bodies.map(x => x.name));
    expect(a.asteroids.length).toBe(b.asteroids.length);
    expect(a.stations.map(s => s.pos.x)).toEqual(b.stations.map(s => s.pos.x));
  });

  it('produces a sane system for every seed', () => {
    for (const seed of SEEDS) {
      const w = generateSystem(seed, String(seed));
      expect(w.bodies.length).toBeGreaterThan(5);
      expect(w.stations.length).toBe(3);
      expect(w.pads.filter(p => p.kind === 'colony').length).toBeGreaterThanOrEqual(4);
      expect(w.enemyCore).not.toBeNull();
      // orbits are ordered: no two planets share an orbit band
      const planets = w.bodies.filter(b => b.kind === 'planet' || b.kind === 'gas').filter(b => b.name !== 'THE FAULT' && b.name !== 'HOLLOW');
      const radii = planets.map(b => b.orbit!.radius).sort((a, b) => a - b);
      for (let i = 1; i < radii.length; i++) expect(radii[i] - radii[i - 1]).toBeGreaterThan(200);
      // moons clear their parent and each other
      for (const b of w.bodies) {
        if (b.kind !== 'moon') continue;
        const parent = b.orbit!.parent;
        expect(b.orbit!.radius).toBeGreaterThan(maxTerrainRadius(parent) + maxTerrainRadius(b) + 20);
        for (const o of w.bodies) {
          if (o === b || o.kind !== 'moon' || o.orbit!.parent !== parent) continue;
          expect(Math.abs(o.orbit!.radius - b.orbit!.radius)).toBeGreaterThan(maxTerrainRadius(o) + maxTerrainRadius(b) + 10);
        }
      }
      // stations clear their parent body and every other body, and sit well above their parent's surface
      for (const st of w.stations) {
        for (const b of w.bodies) {
          const d = Math.hypot(st.pos.x - b.pos.x, st.pos.y - b.pos.y);
          expect(d).toBeGreaterThan(maxTerrainRadius(b) + st.radius + 5);
        }
        const parent = st.orbit!.parent;
        expect(st.orbit!.radius).toBeGreaterThan(maxTerrainRadius(parent) + 130);
      }
      // pads: flat chord, not overlapping another pad on the same body
      for (const b of w.bodies) {
        for (const p of b.pads) {
          const seg = b.segments;
          const i0 = p.segIndex, i1 = (i0 + 1) % seg;
          expect(Math.abs(b.terrain[i0] - b.terrain[i1])).toBeLessThan(1e-6);
          expect(p.height).toBeGreaterThan(b.radius * 0.85);
          for (const q of b.pads) {
            if (q === p) continue;
            expect(q.segIndex).not.toBe(p.segIndex);
          }
        }
      }
      // player starts docked at a live station
      expect(w.player.docked).not.toBeNull();
      // nothing solid at the player's start
      for (const b of w.bodies) {
        const d = Math.hypot(w.player.pos.x - b.pos.x, w.player.pos.y - b.pos.y);
        expect(d).toBeGreaterThan(maxTerrainRadius(b) + 2);
      }
      // terrain radii are finite and within bounds
      for (const b of w.bodies) for (let i = 0; i < b.segments; i++) {
        expect(Number.isFinite(b.terrain[i])).toBe(true);
        expect(b.terrain[i]).toBeGreaterThan(b.radius * 0.6);
        expect(b.terrain[i]).toBeLessThan(b.radius * 1.4);
      }
      // every enemy base carries the same kit; the Kiln has a plant with a seated core; the enemy world's bases draw from the Cut's socket
      const bases = w.pads.filter(p => p.kind === 'enemybase' || p.kind === 'core');
      for (const p of bases) {
        expect(p.mast && p.mast.alive).toBeTruthy();
        expect(p.radiator && p.radiator.alive).toBeTruthy();
        const grid = w.power.some(src => src.body === p.body && src.range === Infinity);
        if (grid) expect(p.plant).toBeNull(); else expect(p.plant && p.plant.alive).toBeTruthy();
      }
      const kiln = w.pads.find(p => p.name === 'THE KILN');
      expect(kiln).toBeTruthy();
      expect(kiln!.guns).toBe(2);
      for (const src of w.power) expect(src.powered && src.core && src.core.alive).toBeTruthy();
      // structures stand on the surface, outside every pad's flat chord
      for (const st of w.structures) {
        const b = st.body;
        const r = Math.hypot(st.local.x, st.local.y);
        const ang = Math.atan2(st.local.y, st.local.x);
        expect(Math.abs(r - terrainRadiusAt(b, ang))).toBeLessThan(st.radius + 0.5);
        for (const pd of b.pads) expect(Math.abs(Math.atan2(Math.sin(ang - pd.angle), Math.cos(ang - pd.angle))) * b.radius).toBeGreaterThan(pd.halfWidth + 1);
      }
      // worlds turn
      for (const b of w.bodies) if (b.kind === 'planet' && b.name !== 'THE FAULT' && b.name !== 'HOLLOW') { expect(b.rotates).toBe(true); expect(Math.abs(b.spin)).toBeGreaterThan(0.004); }
      // asteroids start outside bodies
      for (const a of w.asteroids) {
        for (const b of w.bodies) {
          const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
          expect(d).toBeGreaterThan(b.kind === 'star' ? b.radius : terrainRadiusAt(b, Math.atan2(a.pos.y - b.pos.y, a.pos.x - b.pos.x)));
        }
      }
    }
  }, 120000);
});

describe('simulation stability', () => {
  it('runs several minutes for a few seeds without NaNs or blow-ups', () => {
    for (const seed of SEEDS.slice(0, 3)) {
      const w = generateSystem(seed, String(seed));
      const p = w.player;
      p.docked = null;
      const c = emptyControls();
      const steps = 120 * 150; // two and a half minutes
      w.slices.pilgrimSpawnAt = 5;
      for (let i = 0; i < steps; i++) {
        stepWorld(w, c, SIM_DT, { flight: true, fireSecondary: false, director: true, nearestEnemy: null });
        w.explosions.length = 0;
        w.audioEvents.length = 0;
        if (i % 600 === 0) {
          for (const s of w.ships) {
            expect(Number.isFinite(s.pos.x + s.pos.y + s.vel.x + s.vel.y + s.angle)).toBe(true);
            expect(Math.hypot(s.vel.x, s.vel.y)).toBeLessThan(400);
          }
          for (const a of w.asteroids) expect(Number.isFinite(a.pos.x + a.vel.x)).toBe(true);
          expect(w.ships.length).toBeLessThan(80);
          expect(w.projectiles.length).toBeLessThan(600);
          expect(w.log.length).toBeLessThanOrEqual(600);
          for (const k of w.pickups) expect(Number.isFinite(k.pos.x + k.vel.x)).toBe(true);
        }
      }
      // the director produced life
      expect(w.events.length).toBeGreaterThan(0);
      expect(w.comms.length).toBeGreaterThan(1);
    }
  }, 180000);
});
