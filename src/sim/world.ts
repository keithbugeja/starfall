// World state: everything the simulation owns. Rendering reads it; it never writes it.
import { Rng, type V2 } from '../engine/math';
import type { Body, Pad } from './bodies';

export const SIM_DT = 1 / 120;

export type Faction = 'player' | 'civ' | 'enemy' | 'none';
export type ShipKind = 'kestrel' | 'wasp' | 'lancer' | 'reaver' | 'freighter' | 'dreadnought' | 'shuttle' | 'sentinel';
export type WeaponKind = 'pulse' | 'scatter' | 'rail' | 'mass' | 'seeker' | 'lance';

export interface ShipStats {
  thrust: number;      // main engine acceleration (u/s^2)
  retro: number;       // reverse thrust acceleration
  strafe: number;      // lateral thrust acceleration
  turnRate: number;    // rad/s
  maxSpeed: number;    // soft cap
  boostThrust: number; // acceleration while boosting
  boostMax: number;    // soft cap while boosting
  fuelBurn: number;    // fuel per second at full thrust
  boostBurn: number;
  gravMul: number;     // gravity dampers < 1
  heatResist: number;  // 1 = normal star heat
  landTol: number;     // landing tolerance multiplier
}

export interface Weapon {
  kind: WeaponKind;
  cooldown: number;     // seconds between shots
  speed: number;        // muzzle velocity
  life: number;         // seconds
  damage: number;
  spread: number;       // radians
  count: number;        // projectiles per shot
  gravMul: number;      // how much gravity bends it
  radius: number;       // hit radius
  heat: number;         // heat per shot (for heat gauge)
  ammo: number;         // -1 = unlimited
}

export interface LandedState {
  body: Body;
  pad: Pad | null;
  offset: V2;   // position relative to body centre
  angle: number;
}

export interface AiState {
  mode: string;
  target: Ship | null;
  targetPos: V2 | null;
  timer: number;
  fireTimer: number;
  strafeDir: number;
  carrying: Pickup | null;
  home: Pad | Station | null;
  homeBody: Body | null;
  wantFire: boolean;
  wantSecondary: boolean;
  patrolAngle: number;
  route: (Station | Pad)[];
  routeIndex: number;
  convoyLeader: Ship | null;
  formationOffset: V2;
  fear: number;
  memory: number;
  groupId: number;
  wave: number;
}

export interface Ship {
  id: number;
  kind: ShipKind;
  name: string;
  faction: Faction;
  pos: V2;
  vel: V2;
  angle: number;
  angVel: number;
  radius: number;
  massMul: number;      // >1 = heavier (slower accel/turn)
  hull: number;
  hullMax: number;
  fuel: number;
  fuelMax: number;
  stats: ShipStats;
  weapon: Weapon;
  secondary: Weapon | null;
  thrusting: number;    // 0..1 visual
  retroing: number;
  strafing: number;
  boosting: boolean;
  landed: LandedState | null;
  docked: Station | null;
  fireCooldown: number;
  heat: number;         // weapon heat 0..1
  overheated: boolean;
  alive: boolean;
  ai: AiState | null;
  bounty: number;
  cargo: Cargo;
  lastHitBy: Faction;
  lastDamageTime: number;
  spawnTime: number;
  towing: Pickup | null;
  invuln: number;
  targetId: number;     // player's selected target
  tractor: boolean;
  shield: number;
  contactDamageTimer: number;
  crashSpeed: number;
  hasRetro: boolean;
  hasStrafe: boolean;
  escortOf: Ship | null;
  scriptedEvent: number;
  lastDamageSource: string;
  upgrades: string[];
  ownedWeapons: WeaponKind[];
  modules: string[];
}

export interface Cargo {
  ore: number;
  salvage: number;
  pods: number;
  capacity: number;
}

export interface Projectile {
  id: number;
  pos: V2;
  vel: V2;
  life: number;
  faction: Faction;
  damage: number;
  kind: WeaponKind;
  radius: number;
  gravMul: number;
  owner: number;
  seekTarget: Ship | null;
  color: number[];
  prevPos: V2;
}

export interface Asteroid {
  id: number;
  pos: V2;
  vel: V2;
  radius: number;
  hp: number;
  variant: number;
  spinAxis: number[];
  spinRate: number;
  spinAngle: number;
  size: number;      // 3 big, 2 medium, 1 small
  ore: number;       // ore dropped on destruction
  rich: boolean;     // high-value ore
  field: number;     // belt id or -1
  alive: boolean;
  rogue: boolean;    // event: on collision course
}

export type PickupKind = 'ore' | 'salvage' | 'pod' | 'fuel' | 'module' | 'wreck';

export interface Pickup {
  id: number;
  kind: PickupKind;
  pos: V2;
  vel: V2;
  radius: number;
  life: number;
  value: number;
  alive: boolean;
  carriedBy: Ship | null;
  fragile: boolean;
  home: Pad | null;   // pods: where they came from
  moduleId: string;   // unique module for 'module'
  name: string;
  spin: number;
}

export interface Station {
  id: number;
  name: string;
  pos: V2;
  vel: V2;
  angle: number;        // rotation of the station
  spin: number;         // rad/s
  radius: number;       // hull radius (collision)
  bayDepth: number;     // how far the bay goes in
  bayHalfWidth: number;
  orbit: { parent: Body; radius: number; angularSpeed: number; phase: number } | null;
  kind: 'harbour' | 'refinery' | 'research' | 'outpost';
  alive: boolean;
  health: number;
  healthMax: number;
  fuelPrice: number;
  orePrice: number;
  salvagePrice: number;
  upgrades: string[];   // available upgrade ids
  siege: number;        // > 0 while under attack
  defenceTimer: number;
  discovered: boolean;
  meshIndex: number;
  lastDockTime: number;
  stock: number;
}

export interface CommMessage {
  time: number;
  from: string;
  text: string;
  color: number[];
  priority: number;
  pos: V2 | null;
}

export interface Explosion {
  pos: V2;
  time: number;
  size: number;
  color: number[];
}

export interface Beam {
  ax: number; ay: number; bx: number; by: number; color: number[]; life: number; maxLife: number; width: number;
}

export interface World {
  seed: number;
  seedName: string;
  rng: Rng;
  time: number;
  tick: number;
  bodies: Body[];
  star: Body;
  ships: Ship[];
  projectiles: Projectile[];
  asteroids: Asteroid[];
  pickups: Pickup[];
  stations: Station[];
  pads: Pad[];
  player: Ship;
  comms: CommMessage[];
  explosions: Explosion[]; // consumed by the renderer each frame
  beams: Beam[];
  systemRadius: number;
  nextId: number;
  events: GameEvent[];
  threat: number;        // enemy pressure 0..
  score: number;
  credits: number;
  lives: number;
  kills: number;
  rescued: number;
  lost: number;          // pods lost
  enemyCore: Pad | null;
  coreDestroyed: boolean;
  gameOver: boolean;
  flare: { active: boolean; timer: number; nextIn: number; warned: boolean; intensity: number };
  stats: { launches: number; landings: number; docks: number; crashes: number; distance: number; oreSold: number; salvageSold: number; deaths: number; basesDestroyed: number; eventsResolved: number; eventsFailed: number };
  bounties: number;
  hazardWarnings: Set<string>;
  colonyRep: number;
  respawnStation: Station | null;
  respawnPad: Pad | null;
  discovered: Set<string>;
  audioEvents: AudioEvent[];
  screenShake: number;
  waveTimer: number;
  lastPlayerHit: number;
}

export type EventKind = 'raid' | 'convoy' | 'siege' | 'stranded' | 'construction' | 'rogue' | 'salvage' | 'flare' | 'ambush' | 'hunt';

export interface GameEvent {
  id: number;
  kind: EventKind;
  pos: V2;
  target: Pad | Station | Ship | Asteroid | null;
  ships: Ship[];
  timer: number;      // time remaining before consequence
  duration: number;
  phase: number;
  resolved: boolean;
  failed: boolean;
  announced: boolean;
  label: string;
  reward: number;
  data: Record<string, unknown>;
  startTime: number;
}

export interface AudioEvent {
  kind: string;
  pos: V2 | null;
  volume: number;
  param: number;
}

export function createStats(partial: Partial<ShipStats> = {}): ShipStats {
  return {
    thrust: 14,
    retro: 0,
    strafe: 0,
    turnRate: 3.4,
    maxSpeed: 60,
    boostThrust: 34,
    boostMax: 135,
    fuelBurn: 1.0,
    boostBurn: 3.2,
    gravMul: 1,
    heatResist: 1,
    landTol: 1,
    ...partial,
  };
}

export function makeWeapon(kind: WeaponKind): Weapon {
  switch (kind) {
    case 'pulse': return { kind, cooldown: 0.16, speed: 95, life: 1.5, damage: 10, spread: 0.012, count: 1, gravMul: 1, radius: 0.6, heat: 0.05, ammo: -1 };
    case 'scatter': return { kind, cooldown: 0.42, speed: 75, life: 0.7, damage: 7, spread: 0.22, count: 5, gravMul: 1, radius: 0.6, heat: 0.14, ammo: -1 };
    case 'rail': return { kind, cooldown: 0.7, speed: 260, life: 1.6, damage: 34, spread: 0.0, count: 1, gravMul: 0.15, radius: 0.5, heat: 0.3, ammo: -1 };
    case 'mass': return { kind, cooldown: 0.55, speed: 40, life: 5.0, damage: 45, spread: 0.0, count: 1, gravMul: 1.6, radius: 1.2, heat: 0.2, ammo: -1 };
    case 'seeker': return { kind, cooldown: 1.2, speed: 45, life: 6.0, damage: 40, spread: 0.0, count: 1, gravMul: 0.8, radius: 1.0, heat: 0.0, ammo: 6 };
    case 'lance': return { kind, cooldown: 0.9, speed: 70, life: 2.2, damage: 22, spread: 0.02, count: 1, gravMul: 1, radius: 1.0, heat: 0, ammo: -1 };
  }
}

export function createShip(w: World, kind: ShipKind, faction: Faction, x: number, y: number, angle: number): Ship {
  const base = shipBase(kind);
  const ship: Ship = {
    id: w.nextId++,
    kind,
    name: base.name,
    faction,
    pos: { x, y },
    vel: { x: 0, y: 0 },
    angle,
    angVel: 0,
    radius: base.radius,
    massMul: 1,
    hull: base.hull,
    hullMax: base.hull,
    fuel: base.fuel,
    fuelMax: base.fuel,
    stats: base.stats,
    weapon: makeWeapon(base.weapon),
    secondary: null,
    thrusting: 0,
    retroing: 0,
    strafing: 0,
    boosting: false,
    landed: null,
    docked: null,
    fireCooldown: 0,
    heat: 0,
    overheated: false,
    alive: true,
    ai: null,
    bounty: base.bounty,
    cargo: { ore: 0, salvage: 0, pods: 0, capacity: 8 },
    lastHitBy: 'none',
    lastDamageTime: -1e9,
    spawnTime: w.time,
    towing: null,
    invuln: 0,
    targetId: -1,
    tractor: false,
    shield: 0,
    contactDamageTimer: 0,
    crashSpeed: 0,
    hasRetro: base.stats.retro > 0,
    hasStrafe: base.stats.strafe > 0,
    escortOf: null,
    scriptedEvent: -1,
    lastDamageSource: '',
    upgrades: [],
    ownedWeapons: [base.weapon],
    modules: [],
  };
  w.ships.push(ship);
  return ship;
}

export function shipBase(kind: ShipKind): { name: string; radius: number; hull: number; fuel: number; stats: ShipStats; weapon: WeaponKind; bounty: number } {
  switch (kind) {
    case 'kestrel': return { name: 'KESTREL', radius: 1.0, hull: 100, fuel: 100, stats: createStats(), weapon: 'pulse', bounty: 0 };
    case 'wasp': return { name: 'WASP', radius: 0.8, hull: 22, fuel: 1e9, stats: createStats({ thrust: 22, turnRate: 5.5, maxSpeed: 58, retro: 6, strafe: 10 }), weapon: 'lance', bounty: 120 };
    case 'lancer': return { name: 'LANCER', radius: 1.2, hull: 60, fuel: 1e9, stats: createStats({ thrust: 16, turnRate: 3.0, maxSpeed: 52, retro: 8, strafe: 0 }), weapon: 'lance', bounty: 300 };
    case 'reaver': return { name: 'REAVER', radius: 1.4, hull: 80, fuel: 1e9, stats: createStats({ thrust: 11, turnRate: 2.2, maxSpeed: 34, retro: 6, strafe: 6 }), weapon: 'lance', bounty: 400 };
    case 'freighter': return { name: 'FREIGHTER', radius: 2.2, hull: 120, fuel: 1e9, stats: createStats({ thrust: 6, turnRate: 1.2, maxSpeed: 30, retro: 3, strafe: 2 }), weapon: 'pulse', bounty: 0 };
    case 'dreadnought': return { name: 'DREADNOUGHT', radius: 4.5, hull: 900, fuel: 1e9, stats: createStats({ thrust: 4, turnRate: 0.5, maxSpeed: 20, retro: 2, strafe: 2 }), weapon: 'mass', bounty: 3000 };
    case 'shuttle': return { name: 'SHUTTLE', radius: 0.9, hull: 30, fuel: 1e9, stats: createStats({ thrust: 10, turnRate: 2.5, maxSpeed: 40, retro: 4, strafe: 3 }), weapon: 'pulse', bounty: 0 };
    case 'sentinel': return { name: 'SENTINEL', radius: 1.6, hull: 140, fuel: 1e9, stats: createStats({ thrust: 0, turnRate: 1.6, maxSpeed: 0 }), weapon: 'lance', bounty: 250 };
  }
}

export function createEmptyWorld(seed: number, seedName: string): World {
  const rng = new Rng(seed);
  const w: World = {
    seed, seedName, rng, time: 0, tick: 0,
    bodies: [], star: null as unknown as Body, ships: [], projectiles: [], asteroids: [], pickups: [], stations: [], pads: [],
    player: null as unknown as Ship,
    comms: [], explosions: [], beams: [],
    systemRadius: 4200, nextId: 1, events: [], threat: 0, score: 0, credits: 0, lives: 3, kills: 0, rescued: 0, lost: 0,
    enemyCore: null, coreDestroyed: false, gameOver: false,
    flare: { active: false, timer: 0, nextIn: 400, warned: false, intensity: 0 },
    stats: { launches: 0, landings: 0, docks: 0, crashes: 0, distance: 0, oreSold: 0, salvageSold: 0, deaths: 0, basesDestroyed: 0, eventsResolved: 0, eventsFailed: 0 },
    bounties: 0,
    hazardWarnings: new Set(),
    colonyRep: 0,
    respawnStation: null,
    respawnPad: null,
    discovered: new Set(),
    audioEvents: [],
    screenShake: 0,
    waveTimer: 0,
    lastPlayerHit: -1e9,
  };
  return w;
}

export function comm(w: World, from: string, text: string, color: number[] = [0.6, 0.9, 1.0], priority = 0, pos: V2 | null = null): void {
  w.comms.push({ time: w.time, from, text, color, priority, pos });
  if (w.comms.length > 60) w.comms.shift();
  w.audioEvents.push({ kind: priority >= 2 ? 'alert' : 'comm', pos: null, volume: 0.5, param: priority });
}

export function sfx(w: World, kind: string, pos: V2 | null = null, volume = 1, param = 0): void {
  w.audioEvents.push({ kind, pos, volume, param });
}
