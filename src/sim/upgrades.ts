// Upgrades: capability changes with trade-offs. Stats are recomputed from the base every time.
import { createStats, makeWeapon, type Ship, type WeaponKind } from './world';

export interface UpgradeDef {
  id: string;
  name: string;
  price: number;
  desc: string;      // what it does
  cost: string;      // the trade-off
  weapon?: WeaponKind;
  shop: ('harbour' | 'refinery' | 'research' | 'outpost')[];
}

export const UPGRADES: UpgradeDef[] = [
  { id: 'retro', name: 'RETRO THRUSTERS', price: 550, desc: 'REVERSE THRUST (S / DOWN). BRAKE WITHOUT TURNING.', cost: 'MASS +8%: SLOWER TURN AND ACCEL', shop: ['harbour', 'refinery'] },
  { id: 'strafe', name: 'LATERAL JETS', price: 700, desc: 'SIDEWAYS THRUST (Q / E). KILLS DRIFT ON LANDING.', cost: 'MASS +8%', shop: ['harbour', 'research'] },
  { id: 'struts', name: 'LANDING STRUTS', price: 450, desc: 'LANDING TOLERANCES +40%.', cost: 'MASS +5%', shop: ['harbour', 'refinery'] },
  { id: 'tank', name: 'EXTENDED TANK', price: 500, desc: 'FUEL CAPACITY 100 TO 170.', cost: 'MASS +12%', shop: ['harbour', 'refinery'] },
  { id: 'engine', name: 'TUNED ENGINE', price: 1000, desc: 'THRUST +30%, BOOST +25%.', cost: 'FUEL BURN +35%', shop: ['refinery', 'harbour'] },
  { id: 'armour', name: 'ARMOUR PLATING', price: 900, desc: 'HULL +70.', cost: 'MASS +22%', shop: ['harbour', 'refinery'] },
  { id: 'cargo', name: 'CARGO RACK', price: 400, desc: 'CARGO 8 TO 16 UNITS.', cost: 'MASS +10%', shop: ['refinery', 'harbour'] },
  { id: 'gravdamp', name: 'GRAV DAMPERS', price: 1200, desc: 'GRAVITY ACTS ON YOU AT 65%.', cost: 'SLINGSHOTS ALSO WEAKEN. SHOTS UNAFFECTED.', shop: ['research'] },
  { id: 'sensors', name: 'LONG RANGE SENSORS', price: 600, desc: 'RADAR RANGE X2. EVENTS SHOW FURTHER OUT.', cost: 'NONE', shop: ['research', 'harbour'] },
  { id: 'tractor', name: 'TRACTOR BEAM', price: 800, desc: 'PULLS CARGO AND PODS FROM 14 UNITS.', cost: 'MASS +5%', shop: ['research', 'refinery'] },
  { id: 'heatshield', name: 'HEAT SHIELD', price: 900, desc: 'STAR HEAT DAMAGE -65%. FLARES SURVIVABLE.', cost: 'MASS +10%', shop: ['research', 'refinery'] },
  { id: 'scatter', name: 'SCATTER CANNON', price: 800, desc: 'FIVE-SHOT SPREAD. BRUTAL UP CLOSE.', cost: 'SHORT RANGE. HEATS FAST', weapon: 'scatter', shop: ['harbour', 'refinery'] },
  { id: 'rail', name: 'RAIL DRIVER', price: 1500, desc: 'HYPERVELOCITY SLUG. IGNORES GRAVITY.', cost: 'SLOW FIRE. HEATS HARD', weapon: 'rail', shop: ['research'] },
  { id: 'mass', name: 'MASS DRIVER', price: 1100, desc: 'HEAVY SHELL, 45 DAMAGE. FALLS WITH GRAVITY.', cost: 'SLOW SHELL. RECOIL', weapon: 'mass', shop: ['refinery', 'harbour'] },
  { id: 'seeker', name: 'SEEKER RACK', price: 700, desc: 'SIX HOMING MISSILES (X). REARM AT STATIONS.', cost: 'MISSILES BEND IN GRAVITY TOO', shop: ['harbour', 'research'] },
];

export function upgradeById(id: string): UpgradeDef | undefined { return UPGRADES.find(u => u.id === id); }

/** Recompute a ship's stats from base + owned upgrades. Keeps hull/fuel fractions. */
export function applyUpgrades(s: Ship): void {
  const hullFrac = s.hull / s.hullMax;
  const fuelFrac = s.fuel / s.fuelMax;
  const base = createStats();
  let mass = 1;
  let hullMax = 100, fuelMax = 100, capacity = 8;
  const st = { ...base };
  s.tractor = false;
  for (const id of s.upgrades) {
    switch (id) {
      case 'retro': st.retro = 6.5; mass += 0.08; break;
      case 'strafe': st.strafe = 7.5; mass += 0.08; break;
      case 'struts': st.landTol = 1.4; mass += 0.05; break;
      case 'tank': fuelMax = 170; mass += 0.12; break;
      case 'engine': st.thrust *= 1.3; st.boostThrust *= 1.25; st.fuelBurn *= 1.35; st.boostBurn *= 1.35; break;
      case 'armour': hullMax += 70; mass += 0.22; break;
      case 'cargo': capacity = 16; mass += 0.1; break;
      case 'gravdamp': st.gravMul = 0.65; break;
      case 'sensors': break;
      case 'tractor': s.tractor = true; mass += 0.05; break;
      case 'heatshield': st.heatResist = 2.8; mass += 0.1; break;
    }
  }
  // unique found modules
  st.gravMul *= s.stats.gravMul < 0.6 && !s.upgrades.includes('gravdamp') ? 1 : 1;
  s.stats = st;
  s.massMul = mass;
  s.hullMax = hullMax;
  s.fuelMax = fuelMax;
  s.cargo.capacity = capacity;
  s.hull = Math.min(s.hullMax, hullFrac * s.hullMax);
  s.fuel = Math.min(s.fuelMax, fuelFrac * s.fuelMax);
  s.hasRetro = st.retro > 0;
  s.hasStrafe = st.strafe > 0;
  // found modules re-applied
  for (const m of s.modules) applyFoundModule(s, m);
}

export function applyFoundModule(s: Ship, id: string): void {
  switch (id) {
    case 'gravlens': s.stats.gravMul *= 0.7; break;
    case 'ancientcore': s.stats.boostThrust *= 1.4; s.stats.boostBurn *= 0.6; break;
    case 'phase': s.hullMax += 40; break;
    case 'coldfusion': s.stats.fuelBurn *= 0.5; break;
    case 'gyros': s.stats.turnRate *= 1.4; break;
  }
}

export function hasSensors(s: Ship): boolean { return s.upgrades.includes('sensors'); }

export function installWeapon(s: Ship, kind: WeaponKind): void {
  if (!s.ownedWeapons.includes(kind)) s.ownedWeapons.push(kind);
  s.weapon = makeWeapon(kind);
}
