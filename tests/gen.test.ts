// Generation invariants across many seeds: nothing spawns inside anything, pads are reachable,
// stations sit clear of bodies, moons clear their parents, and the sim runs without NaNs.
import { describe, expect, it } from 'vitest';
import { generateSystem } from '../src/gen/system';
import { maxTerrainRadius, terrainRadiusAt, updateOrbits } from '../src/sim/bodies';
import { collide, stepAsteroids, stepPickups, stepProjectiles, stepShip } from '../src/sim/physics';
import { updateStations } from '../src/sim/stations';
import { updateDirector } from '../src/sim/director';
import { updateAi, aiFire, pruneShips } from '../src/sim/ai';
import { emptyControls } from '../src/engine/input';
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
      const planets = w.bodies.filter(b => b.kind === 'planet' || b.kind === 'gas').filter(b => b.name !== 'THE FAULT');
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
      for (let i = 0; i < steps; i++) {
        updateOrbits(w.bodies, w.time, SIM_DT);
        updateStations(w, SIM_DT);
        updateDirector(w, SIM_DT);
        stepShip(w, p, c, SIM_DT);
        for (const s of w.ships) {
          if (s === p || !s.alive) continue;
          const ac = updateAi(w, s, SIM_DT);
          stepShip(w, s, ac, SIM_DT);
          aiFire(w, s);
        }
        stepProjectiles(w, SIM_DT);
        stepAsteroids(w, SIM_DT);
        stepPickups(w, SIM_DT);
        collide(w, SIM_DT);
        pruneShips(w);
        w.explosions.length = 0;
        w.audioEvents.length = 0;
        w.time += SIM_DT; w.tick++;
        if (i % 600 === 0) {
          for (const s of w.ships) {
            expect(Number.isFinite(s.pos.x + s.pos.y + s.vel.x + s.vel.y + s.angle)).toBe(true);
            expect(Math.hypot(s.vel.x, s.vel.y)).toBeLessThan(400);
          }
          for (const a of w.asteroids) expect(Number.isFinite(a.pos.x + a.vel.x)).toBe(true);
          expect(w.ships.length).toBeLessThan(80);
          expect(w.projectiles.length).toBeLessThan(600);
        }
      }
      // the director produced life
      expect(w.events.length).toBeGreaterThan(0);
      expect(w.comms.length).toBeGreaterThan(1);
    }
  }, 180000);
});
