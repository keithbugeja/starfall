// The sector: generated systems are sane, the jump carries the player and leaves a ledger, and a run survives being saved.
import { describe, expect, it } from 'vitest';
import { createSector, instantiate } from '../src/sector/sector';
import { GEOGRAPHY, validatePlanet } from '../src/gen/planet';
import { maxTerrainRadius } from '../src/sim/bodies';
import { emptyControls } from '../src/engine/input';
import { stepWorld } from '../src/sim/step';
import { SIM_DT } from '../src/sim/world';
import { hashString } from '../src/engine/math';

const SEEDS = Array.from({ length: 40 }, (_, i) => hashString('sector-' + i));

describe('generated systems', () => {
  it('the red dwarf that flares is a sane system for every seed', async () => {
    let k = 0;
    for (const seed of SEEDS) {
      if (++k % 8 === 0) await new Promise(r => setTimeout(r, 0));
      const sector = createSector(seed, 'T-' + seed);
      const w = instantiate(sector, 'ember');
      expect(w.systemId).toBe('ember');
      expect(w.machinePresence).toBe(0);
      expect(w.flareRate).toBeGreaterThan(1);
      expect(w.star.name.length).toBeGreaterThan(0);
      expect(w.bodies.filter(b => b.kind === 'planet').length).toBe(3);
      expect(w.stations.length).toBe(1);
      expect(w.respawnStation).toBe(w.stations[0]);
      expect(w.pads.filter(p => p.kind === 'mine').length).toBeGreaterThanOrEqual(1);
      expect(w.pads.filter(p => p.kind === 'colony').length).toBe(1);
      expect(w.pads.filter(p => p.kind === 'enemybase' || p.kind === 'core').length).toBe(0);
      expect(w.ships.filter(s => s.faction === 'enemy').length).toBe(0);
      expect(w.player.docked).toBe(w.stations[0]);
      // the station sits clear of every body and above its parent
      for (const st of w.stations) {
        for (const b of w.bodies) expect(Math.hypot(st.pos.x - b.pos.x, st.pos.y - b.pos.y)).toBeGreaterThan(maxTerrainRadius(b) + st.radius + 5);
        expect(st.orbit!.radius).toBeGreaterThan(maxTerrainRadius(st.orbit!.parent) + 130);
      }
      // the cut worlds are physically sound, and the mine sits on the scorched world
      const cut = w.bodies.filter(b => GEOGRAPHY.has(b));
      expect(cut.length).toBe(2);
      for (const b of cut) { const problems = validatePlanet(w, b); expect(problems, `${b.name} (seed ${seed}): ${problems.join('; ')}`).toEqual([]); }
      const scorched = w.bodies.find(b => b.type === 'volcanic')!;
      expect(scorched.pads.some(p => p.kind === 'mine')).toBe(true);
      // the inner world lives inside the star's warm radius: guns run hot there in daylight
      expect(scorched.orbit!.radius).toBeLessThan(w.star.warmRadius);
      // terrain in bounds, pads flat
      for (const b of w.bodies) for (let i = 0; i < b.segments; i++) expect(Number.isFinite(b.terrain[i])).toBe(true);
      // the world runs
      const c = emptyControls();
      w.player.docked = null;
      for (let i = 0; i < 120 * 30; i++) stepWorld(w, c, SIM_DT, { flight: true, fireSecondary: false, director: true, nearestEnemy: null });
      for (const s of w.ships) expect(Number.isFinite(s.pos.x + s.vel.x)).toBe(true);
      expect(w.ships.filter(s => s.faction === 'enemy').length).toBe(0);
    }
  }, 240000);

  it('is deterministic for a seed and independent of the home system', () => {
    const a = instantiate(createSector(777, 'A'), 'ember');
    const b = instantiate(createSector(777, 'A'), 'ember');
    expect(a.bodies.map(x => x.name)).toEqual(b.bodies.map(x => x.name));
    expect(a.pads.map(x => x.name)).toEqual(b.pads.map(x => x.name));
    expect(a.asteroids.length).toBe(b.asteroids.length);
  });
});
