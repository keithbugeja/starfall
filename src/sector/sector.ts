// The sector: the layer above a World. A World is one star system, live; the sector holds what a
// system is (a recipe), what the player did there (a ledger), the sector clock, and the player's own
// state, which outlives any World. Only one World exists at a time: entering a system builds it from
// its recipe, applies its ledger, and puts the player in it; leaving writes the ledger back.
import { Rng, TAU, hashString } from '../engine/math';
import type { Body } from '../sim/bodies';
import { updateOrbits } from '../sim/bodies';
import { directorRestore, directorSnapshot, type DirectorSnapshot } from '../sim/director';
import { generateSystem } from '../gen/system';
import { generateFromRecipe } from '../gen/recipe';
import { updateStations } from '../sim/stations';
import { applyUpgrades } from '../sim/upgrades';
import { relaxMarket } from '../sim/market';
import { createShip, makeWeapon, type Cargo, type WeaponKind, type World } from '../sim/world';
import type { JournalEntry } from '../sim/journal';

export type StarClass = 'yellow' | 'red-dwarf';

/** What a system is: enough to build it, and enough to draw it on the chart. */
export interface SystemRecipe {
  id: string;
  index: number;
  name: string;
  kind: 'home' | 'generated';
  starClass: StarClass;
  trait: string;      // the sentence a pilot would say about it
  tag: string;        // two words on the chart once known
  danger: string;     // one word on the chart once known
  x: number;          // chart position, chart units
  y: number;
  seed: number;
}

/** What the player did in a system, keyed by names (ids restart per world). */
export interface Ledger {
  visited: boolean;
  leftAt: number;                 // sector time when the player last left
  destroyedPads: string[];        // enemy bases and cores the player destroyed
  lostPads: string[];             // colonies, mines and outposts that were lost
  discovered: string[];
  threat: number;
  coreDestroyed: boolean;
  director: DirectorSnapshot | null;
  stocks: Record<string, Record<string, number>>; // station name -> good -> stock
  pilgrim: 'pending' | 'flying' | 'lost' | 'saved';
  regulatorGone: boolean;
  thrusterFuel: Record<string, number>;
}

/** A price the player has seen, with when. */
export interface PriceSeen { system: string; station: string; good: string; price: number; time: number; }

/** The player's own state: the ship as a fit, the purse, the record. */
export interface PlayerState {
  hull: number;
  fuel: number;
  upgrades: string[];
  ownedWeapons: string[];
  weapon: string;
  seekerAmmo: number | null;
  modules: string[];
  cargo: Cargo;
  credits: number;
  score: number;
  lives: number;
  kills: number;
  rescued: number;
  lost: number;
  stats: World['stats'];
  bounties: number;
  colonyRep: number;
  journal: JournalEntry[];
  journalSeen: string[];
  driveTarget: string | null;
  prices: PriceSeen[];
}

export interface Sector {
  version: number;
  seed: number;
  seedName: string;
  time: number;               // sector clock: the sum of every world's time the player has lived through
  current: string;            // the system the player is in
  systems: SystemRecipe[];
  ledgers: Record<string, Ledger>;
  player: PlayerState | null; // set when the player is between worlds or the game is saved
  where: { docked: string | null } | null; // for a saved game: where in the current system
}

export const SECTOR_VERSION = 1;

/** Chart units per fuel unit of a jump, times the ship's mass multiplier. */
export const JUMP_FUEL_PER_UNIT = 5;

function emptyLedger(): Ledger {
  return { visited: false, leftAt: 0, destroyedPads: [], lostPads: [], discovered: [], threat: 0, coreDestroyed: false, director: null, stocks: {}, pilgrim: 'pending', regulatorGone: false, thrusterFuel: {} };
}

/** The sector for a run: the home system and, in this slice, one neighbour. */
export function createSector(seed: number, seedName: string): Sector {
  const rng = new Rng((seed ^ 0x5ec70) >>> 0);
  const systems: SystemRecipe[] = [];
  systems.push({ id: 'home', index: 0, name: seedName, kind: 'home', starClass: 'yellow', trait: 'the system the Starfall fell on', tag: 'FALLEN STAR', danger: 'CONTESTED', x: 0, y: 0, seed });
  // the neighbour: a red dwarf that flares, four chart units out on a random bearing
  const bearing = rng.next() * TAU;
  const dist = 4;
  systems.push({ id: 'ember', index: 1, name: '', kind: 'generated', starClass: 'red-dwarf', trait: 'the red dwarf that flares', tag: 'FLARE STAR', danger: 'QUIET', x: Math.cos(bearing) * dist, y: Math.sin(bearing) * dist, seed: hashString(`${seed}:ember`) });
  const ledgers: Record<string, Ledger> = {};
  for (const s of systems) ledgers[s.id] = emptyLedger();
  return { version: SECTOR_VERSION, seed, seedName, time: 0, current: 'home', systems, ledgers, player: null, where: null };
}

export function recipeOf(sector: Sector, id: string): SystemRecipe {
  const r = sector.systems.find(s => s.id === id);
  if (!r) throw new Error(`no system ${id}`);
  return r;
}

export function chartDistance(a: SystemRecipe, b: SystemRecipe): number { return Math.hypot(b.x - a.x, b.y - a.y); }

/** Direction on the chart from one system to another, which is also the world-frame heading a jump needs. */
export function chartBearing(a: SystemRecipe, b: SystemRecipe): number { return Math.atan2(b.y - a.y, b.x - a.x); }

/** Build a system's World from its recipe and apply its ledger. Every world starts at time 0; orbits are advanced by the sector clock. */
export function instantiate(sector: Sector, id: string): World {
  const r = recipeOf(sector, id);
  const w = r.kind === 'home' ? generateSystem(r.seed, sector.seedName) : generateFromRecipe(r);
  w.systemId = id;
  if (r.kind === 'generated' && !r.name) r.name = w.star.name;
  const ledger = sector.ledgers[id] ?? (sector.ledgers[id] = emptyLedger());
  applyLedger(w, ledger, sector);
  return w;
}

/** Advance every rail and every spin by the sector clock so a system is where time left it. */
function advanceByTime(w: World, t: number): void {
  if (t <= 0) return;
  for (const b of w.bodies) {
    if (b.free) continue;
    if (b.orbit) b.orbit.phase += b.orbit.angularSpeed * t;
    if (b.rotates && !b.faceParent) b.spinAngle += b.spin * t;
  }
  for (const st of w.stations) if (st.orbit) st.orbit.phase += st.orbit.angularSpeed * t;
  updateOrbits(w.bodies, 0, 0);
  updateStations(w, 0);
  // things that ride a body keep their place on it, so nothing more to do for landed ships or pads
}

export function applyLedger(w: World, ledger: Ledger, sector: Sector): void {
  advanceByTime(w, sector.time);
  if (!ledger.visited) return;
  for (const name of ledger.destroyedPads) {
    const p = w.pads.find(q => q.name === name);
    if (!p) continue;
    p.alive = false; p.enemyHealth = 0;
    for (const st of [p.plant, p.radiator, p.mast]) if (st) { st.alive = false; st.integrity = 0; }
    if (p.kind === 'core') { w.coreDestroyed = true; }
  }
  for (const name of ledger.lostPads) {
    const p = w.pads.find(q => q.name === name);
    if (p) { p.alive = false; p.population = 0; }
  }
  for (const n of ledger.discovered) w.discovered.add(n);
  w.threat = ledger.threat;
  w.coreDestroyed = w.coreDestroyed || ledger.coreDestroyed;
  if (ledger.director) directorRestore(w, ledger.director);
  for (const st of w.stations) {
    const stocks = ledger.stocks[st.name];
    if (!stocks || !st.market) continue;
    for (const [good, stock] of Object.entries(stocks)) if (st.market[good]) st.market[good].stock = stock;
    relaxMarket(st, sector.time - ledger.leftAt);
  }
  // the authored arc keeps its cheap booleans; anything richer is a known compromise (see EXPANSION.md)
  const S = w.slices;
  if (ledger.pilgrim === 'lost' || ledger.pilgrim === 'flying') { S.pilgrimLost = true; S.pilgrimSpawnAt = 1e9; }
  else if (ledger.pilgrim === 'saved') { S.pilgrimSaved = true; S.pilgrimSpawnAt = 1e9; }
  else S.pilgrimSpawnAt = Math.max(20, S.pilgrimSpawnAt - sector.time);
  if (ledger.regulatorGone && S.regulator) { S.regulator.alive = false; if (S.cutSource) { S.cutSource.core = null; S.cutSource.powered = false; } S.cutPowered = false; }
  for (const b of w.bodies) for (const th of b.thrusters) if (ledger.thrusterFuel[th.name] !== undefined) th.fuel = ledger.thrusterFuel[th.name];
}

/** Record what the player did in the world they are leaving. */
export function writeLedger(w: World, sector: Sector): Ledger {
  const ledger = sector.ledgers[w.systemId] ?? (sector.ledgers[w.systemId] = emptyLedger());
  ledger.visited = true;
  ledger.leftAt = sector.time;
  ledger.destroyedPads = w.pads.filter(p => (p.kind === 'enemybase' || p.kind === 'core') && !p.alive).map(p => p.name);
  ledger.lostPads = w.pads.filter(p => (p.kind === 'colony' || p.kind === 'mine' || p.kind === 'outpost' || p.kind === 'derelict') && !p.alive).map(p => p.name);
  ledger.discovered = [...w.discovered];
  ledger.threat = w.threat;
  ledger.coreDestroyed = w.coreDestroyed;
  ledger.director = directorSnapshot(w);
  ledger.stocks = {};
  for (const st of w.stations) if (st.market) { const m: Record<string, number> = {}; for (const [g, e] of Object.entries(st.market)) m[g] = e.stock; ledger.stocks[st.name] = m; }
  const S = w.slices;
  ledger.pilgrim = S.pilgrimSaved ? 'saved' : S.pilgrimLost ? 'lost' : S.pilgrim ? 'flying' : 'pending';
  ledger.regulatorGone = !!(S.regulator && (!S.regulator.alive || (S.cutSource && S.cutSource.core !== S.regulator)));
  ledger.thrusterFuel = {};
  for (const b of w.bodies) for (const th of b.thrusters) ledger.thrusterFuel[th.name] = th.fuel;
  return ledger;
}

/** The player as they leave a world. */
export function extractPlayer(w: World): PlayerState {
  const p = w.player;
  return {
    hull: p.hull, fuel: p.fuel,
    upgrades: p.upgrades.slice(), ownedWeapons: p.ownedWeapons.slice(), weapon: p.weapon.kind, seekerAmmo: p.secondary ? p.secondary.ammo : null,
    modules: p.modules.slice(), cargo: { ...p.cargo },
    credits: w.credits, score: w.score, lives: w.lives, kills: w.kills, rescued: w.rescued, lost: w.lost,
    stats: { ...w.stats }, bounties: w.bounties, colonyRep: w.colonyRep,
    journal: w.journal.slice(), journalSeen: [...w.journalSeen],
    driveTarget: p.drive.target, prices: w.pricesSeen.slice(),
  };
}

/** The player as they arrive in a world: the ship is rebuilt from the fit, the record restored. */
export function injectPlayer(w: World, ps: PlayerState, x: number, y: number, vx: number, vy: number, angle: number): void {
  const p = w.player ?? createShip(w, 'kestrel', 'player', x, y, angle);
  if (!w.ships.includes(p)) w.ships.push(p);
  w.player = p;
  p.docked = null; p.landed = null; p.towing = null; p.tether = null;
  p.pos.x = x; p.pos.y = y; p.vel.x = vx; p.vel.y = vy; p.angle = angle; p.angVel = 0;
  p.upgrades = ps.upgrades.slice(); p.ownedWeapons = ps.ownedWeapons.slice() as WeaponKind[]; p.modules = ps.modules.slice();
  applyUpgrades(p);
  p.weapon = makeWeapon(ps.weapon as WeaponKind);
  p.secondary = ps.seekerAmmo === null ? null : { ...makeWeapon('seeker'), ammo: ps.seekerAmmo };
  p.cargo = { ...ps.cargo };
  p.hull = Math.min(p.hullMax, ps.hull); p.fuel = Math.min(p.fuelMax, ps.fuel);
  p.heat = 0; p.overheated = false; p.alive = true; p.invuln = 2;
  p.drive.target = ps.driveTarget; p.drive.charge = 0; p.drive.charging = false;
  w.credits = ps.credits; w.score = ps.score; w.lives = ps.lives; w.kills = ps.kills; w.rescued = ps.rescued; w.lost = ps.lost;
  w.stats = { ...ps.stats }; w.bounties = ps.bounties; w.colonyRep = ps.colonyRep;
  w.journal = ps.journal.slice(); w.journalSeen = new Set(ps.journalSeen);
  w.pricesSeen = ps.prices.slice();
}

/** Where a ship arrives: at the edge of the system on the line from the star it came from, falling inward. */
export function arrivalPoint(w: World, from: SystemRecipe, to: SystemRecipe, speed: number): { x: number; y: number; vx: number; vy: number; angle: number } {
  const dx = from.x - to.x, dy = from.y - to.y;
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l, uy = dy / l;
  let r = w.systemRadius * 0.97;
  // never inside anything: step out until clear
  for (let t = 0; t < 20; t++) {
    const x = w.star.pos.x + ux * r, y = w.star.pos.y + uy * r;
    const clear = w.bodies.every(b => Math.hypot(x - b.pos.x, y - b.pos.y) > b.maxRadius + 40);
    if (clear) break;
    r += 60;
  }
  const x = w.star.pos.x + ux * r, y = w.star.pos.y + uy * r;
  return { x, y, vx: -ux * speed, vy: -uy * speed, angle: Math.atan2(-uy, -ux) };
}

/** Leave the current world and enter another: the whole transition in one place. */
export function jumpTo(sector: Sector, w: World, targetId: string, speed: number): World {
  const from = recipeOf(sector, w.systemId), to = recipeOf(sector, targetId);
  const ps = extractPlayer(w);
  ps.driveTarget = null;
  writeLedger(w, sector);
  sector.time += w.time;
  sector.current = targetId;
  const nw = instantiate(sector, targetId);
  const at = arrivalPoint(nw, from, to, speed);
  injectPlayer(nw, ps, at.x, at.y, at.vx, at.vy, at.angle);
  nw.pricesSeen = ps.prices.slice();
  return nw;
}

// ---------------------------------------------------------------- persistence

interface SavedSector { version: number; sector: Sector; }

/** Everything the run is, as text: the sector, its ledgers and the player. The world is rebuilt from it. */
export function serializeSector(sector: Sector, w: World | null, docked: string | null): string {
  const s: Sector = { ...sector, player: w ? extractPlayer(w) : sector.player, where: { docked } };
  if (w) { writeLedger(w, s); s.ledgers = { ...sector.ledgers }; }
  const saved: SavedSector = { version: SECTOR_VERSION, sector: s };
  return JSON.stringify(saved);
}

export function deserializeSector(text: string): Sector | null {
  try {
    const saved = JSON.parse(text) as SavedSector;
    if (!saved || saved.version !== SECTOR_VERSION || !saved.sector) return null;
    const s = saved.sector;
    if (!s.systems || !s.ledgers || !s.player) return null;
    return s;
  } catch { return null; }
}

/** Rebuild the saved run: the current system with its ledger, and the player where they were (docked at a station, or at its harbour). */
export function restoreSector(sector: Sector): World {
  const w = instantiate(sector, sector.current);
  const ps = sector.player!;
  const stName = sector.where?.docked ?? null;
  const st = (stName ? w.stations.find(s => s.name === stName) : null) ?? w.respawnStation ?? w.stations[0] ?? null;
  if (st) {
    injectPlayer(w, ps, st.pos.x, st.pos.y, st.vel.x, st.vel.y, 0);
    w.player.docked = st;
  } else {
    const r = recipeOf(sector, sector.current);
    const at = arrivalPoint(w, sector.systems.find(s => s.id !== r.id) ?? r, r, 20);
    injectPlayer(w, ps, at.x, at.y, at.vx, at.vy, at.angle);
  }
  return w;
}

export type { Body };
