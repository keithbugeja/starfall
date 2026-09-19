// The sector: generated systems are sane, the jump carries the player and leaves a ledger, and a run survives being saved.
import { describe, expect, it } from 'vitest';
import { createSector, instantiate, jumpTo, serializeSector, deserializeSector, restoreSector } from '../src/sector/sector';
import { checkDrive, consumeJump, updateDrive, DRIVE_ARRIVAL_SPEED, DRIVE_GRAVITY_LIMIT } from '../src/sim/drive';
import { applyUpgrades } from '../src/sim/upgrades';
import { note } from '../src/sim/journal';
import { gravityAt } from '../src/sim/physics';
import { GEOGRAPHY, validatePlanet } from '../src/gen/planet';
import { maxTerrainRadius } from '../src/sim/bodies';
import { emptyControls } from '../src/engine/input';
import { stepWorld } from '../src/sim/step';
import { SIM_DT, type World } from '../src/sim/world';
import { hashString } from '../src/engine/math';
import { bidOf, buyFrom, priceOf, relaxMarket, sellTo } from '../src/sim/market';

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

/** A spot outside every well, with the nose on the bearing the drive wants. */
function parkForJump(w: World, bearing: number): void {
  const p = w.player;
  const g = { x: 0, y: 0 };
  for (let r = w.systemRadius * 0.5; r < w.systemRadius * 0.95; r += 60) {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const x = w.star.pos.x + Math.cos(a) * r, y = w.star.pos.y + Math.sin(a) * r;
      if (gravityAt(w, x, y, g) < DRIVE_GRAVITY_LIMIT * 0.5 && w.bodies.every(b => Math.hypot(x - b.pos.x, y - b.pos.y) > b.soi + 50)) {
        p.docked = null; p.landed = null; p.pos.x = x; p.pos.y = y; p.vel.x = 0; p.vel.y = 0; p.angle = bearing; return;
      }
    }
  }
  throw new Error('no clear spot');
}

describe('the jump', () => {
  it('carries the player out and back, and the ledger remembers', () => {
    const sector = createSector(hashString('jump-1'), 'JUMP');
    const w = instantiate(sector, 'home');
    const p = w.player;
    p.upgrades.push('drive'); applyUpgrades(p);
    p.fuel = p.fuelMax; w.credits = 512; p.cargo.ore = 3;
    // consequences at home: a base destroyed, a note taken, a name learned
    const base = w.pads.find(q => q.kind === 'enemybase' && !q.interior)!;
    base.alive = false; base.enemyHealth = 0;
    note(w, 'test-note', 'A NOTE TAKEN AT HOME.');
    w.discovered.add('THE SLIPWAY');
    const homePlanet = w.bodies.find(b => b.kind === 'planet')!;
    const before = { x: homePlanet.pos.x, y: homePlanet.pos.y };
    // the drive refuses in the well, then charges outside it
    p.drive.target = 'ember';
    p.docked = null;
    expect(checkDrive(w, sector, p).ok).toBe(false);
    const c = emptyControls();
    parkForJump(w, checkDrive(w, sector, p).bearing);
    let done = false;
    for (let i = 0; i < 120 * 12 && !done; i++) { stepWorld(w, c, SIM_DT, { flight: true, fireSecondary: false, director: false, nearestEnemy: null }); done = updateDrive(w, sector, p, true, SIM_DT); }
    expect(done).toBe(true);
    const chk = checkDrive(w, sector, p);
    expect(chk.ok).toBe(true);
    const fuelBefore = p.fuel;
    consumeJump(w, p, chk);
    expect(p.fuel).toBeLessThan(fuelBefore);
    const timeHome = w.time;
    const nw = jumpTo(sector, w, 'ember', DRIVE_ARRIVAL_SPEED);
    // arrived: the neighbour, at its edge, falling in, with everything that is ours
    expect(nw.systemId).toBe('ember');
    expect(sector.current).toBe('ember');
    expect(sector.time).toBeCloseTo(timeHome, 3);
    const np = nw.player;
    const dist = Math.hypot(np.pos.x - nw.star.pos.x, np.pos.y - nw.star.pos.y);
    expect(dist).toBeGreaterThan(nw.systemRadius * 0.9);
    expect(np.vel.x * (nw.star.pos.x - np.pos.x) + np.vel.y * (nw.star.pos.y - np.pos.y)).toBeGreaterThan(0);
    expect(nw.credits).toBe(512);
    expect(np.cargo.ore).toBe(3);
    expect(np.upgrades).toContain('drive');
    expect(nw.journal.some(e => e.key === 'test-note')).toBe(true);
    expect(nw.discovered.has('THE SLIPWAY')).toBe(false);
    expect(np.drive.target).toBeNull();
    expect(nw.stations.length).toBe(1);
    // live a little there, then go home
    for (let i = 0; i < 120 * 5; i++) stepWorld(nw, c, SIM_DT, { flight: true, fireSecondary: false, director: true, nearestEnemy: null });
    np.drive.target = 'home';
    parkForJump(nw, checkDrive(nw, sector, np).bearing);
    np.fuel = np.fuelMax;
    let back = false;
    for (let i = 0; i < 120 * 12 && !back; i++) back = updateDrive(nw, sector, np, true, SIM_DT);
    expect(back).toBe(true);
    consumeJump(nw, np, checkDrive(nw, sector, np));
    const hw = jumpTo(sector, nw, 'home', DRIVE_ARRIVAL_SPEED);
    expect(hw.systemId).toBe('home');
    // the ledger: the base is still dead, the note is still ours, the name is still known, time has passed
    const base2 = hw.pads.find(q => q.name === base.name)!;
    expect(base2.alive).toBe(false);
    expect(hw.journal.some(e => e.key === 'test-note')).toBe(true);
    expect(hw.discovered.has('THE SLIPWAY')).toBe(true);
    expect(sector.ledgers.home.destroyedPads).toContain(base.name);
    expect(sector.ledgers.ember.visited).toBe(true);
    const homePlanet2 = hw.bodies.find(b => b.name === homePlanet.name)!;
    expect(Math.hypot(homePlanet2.pos.x - before.x, homePlanet2.pos.y - before.y)).toBeGreaterThan(5);
    expect(hw.ships.filter(s => s.kind === 'sentinel' && s.ai && s.ai.home === base2).length).toBe(0);
    for (let i = 0; i < 120 * 5; i++) stepWorld(hw, c, SIM_DT, { flight: true, fireSecondary: false, director: true, nearestEnemy: null });
    for (const s of hw.ships) expect(Number.isFinite(s.pos.x + s.vel.x)).toBe(true);
  }, 120000);

  it('refuses to charge off bearing and drops the charge when the ship boosts', () => {
    const sector = createSector(hashString('jump-2'), 'JUMP');
    const w = instantiate(sector, 'home');
    const p = w.player;
    p.upgrades.push('drive'); applyUpgrades(p); p.fuel = p.fuelMax;
    p.drive.target = 'ember';
    parkForJump(w, checkDrive(w, sector, p).bearing + 0.5);
    expect(checkDrive(w, sector, p).reason).toBe('OFF BEARING');
    expect(updateDrive(w, sector, p, true, SIM_DT)).toBe(false);
    expect(p.drive.charging).toBe(false);
    p.angle = checkDrive(w, sector, p).bearing;
    updateDrive(w, sector, p, true, SIM_DT);
    expect(p.drive.charging).toBe(true);
    p.boosting = true;
    updateDrive(w, sector, p, true, SIM_DT);
    expect(p.drive.charging).toBe(false);
    expect(p.drive.charge).toBe(0);
  });
});

describe('persistence', () => {
  it('a saved run comes back as the same run', () => {
    const sector = createSector(hashString('save-1'), 'SAVE');
    const w = instantiate(sector, 'home');
    w.credits = 999; w.player.cargo.salvage = 2; w.player.upgrades.push('tank'); applyUpgrades(w.player);
    note(w, 'saved-note', 'SAVED.');
    const base = w.pads.find(q => q.kind === 'enemybase' && !q.interior)!; base.alive = false;
    const text = serializeSector(sector, w, w.player.docked ? w.player.docked.name : null);
    const back = deserializeSector(text);
    expect(back).not.toBeNull();
    const rw = restoreSector(back!);
    expect(rw.systemId).toBe('home');
    expect(rw.credits).toBe(999);
    expect(rw.player.cargo.salvage).toBe(2);
    expect(rw.player.upgrades).toContain('tank');
    expect(rw.player.fuelMax).toBe(170);
    expect(rw.journal.some(e => e.key === 'saved-note')).toBe(true);
    expect(rw.pads.find(q => q.name === base.name)!.alive).toBe(false);
    expect(rw.player.docked && rw.player.docked.name).toBe(w.stations[0].name);
    expect(deserializeSector('nonsense')).toBeNull();
  });
});

describe('markets', () => {
  it('prices follow stock, selling lowers them, buying raises them, and time relaxes them', () => {
    const sector = createSector(hashString('market-1'), 'MKT');
    const w = instantiate(sector, 'ember');
    const port = w.stations[0];
    expect(port.market).not.toBeNull();
    const ore = port.market!.ore, salvage = port.market!.salvage;
    const p0 = priceOf(ore);
    expect(p0).toBe(18);
    expect(priceOf(salvage)).toBe(70);
    // buying ore raises its price; selling salvage lowers what they pay
    const { bought, cost } = buyFrom(port, 'ore', 10, 10000);
    expect(bought).toBe(10);
    expect(cost).toBeGreaterThanOrEqual(10 * p0);
    expect(priceOf(ore)).toBeGreaterThan(p0);
    const bid0 = bidOf(salvage);
    const paid = sellTo(port, 'salvage', 6);
    expect(paid).toBeGreaterThan(0);
    expect(bidOf(salvage)).toBeLessThan(bid0);
    // ten minutes away and the stock is mostly back
    const s1 = ore.stock;
    relaxMarket(port, 600);
    expect(Math.abs(ore.stock - ore.baseStock)).toBeLessThan(Math.abs(s1 - ore.baseStock));
    // the home refinery pays more for ore than the port asks: the trip has a reason
    const hw = instantiate(createSector(hashString('market-1'), 'MKT'), 'home');
    const refinery = hw.stations.find(st => st.kind === 'refinery')!;
    expect(bidOf(refinery.market!.ore)).toBeGreaterThan(priceOf(ore) + 5);
  });

  it('a station stock crosses a jump in the ledger', () => {
    const sector = createSector(hashString('market-2'), 'MKT');
    const w = instantiate(sector, 'ember');
    const port = w.stations[0];
    sellTo(port, 'salvage', 5);
    const stockAfter = port.market!.salvage.stock;
    w.player.docked = null;
    const nw = jumpTo(sector, w, 'home', DRIVE_ARRIVAL_SPEED);
    const back = jumpTo(sector, nw, 'ember', DRIVE_ARRIVAL_SPEED);
    const port2 = back.stations[0];
    expect(port2.market!.salvage.stock).toBeGreaterThan(port2.market!.salvage.baseStock);
    expect(port2.market!.salvage.stock).toBeLessThanOrEqual(stockAfter);
  });
});
