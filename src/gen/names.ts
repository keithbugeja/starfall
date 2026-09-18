// Name generation for stars, worlds, stations and pads. Curated fragments, seeded assembly.
import type { Rng } from '../engine/math';

const STAR_A = ['KAEL', 'VORN', 'THESS', 'ORME', 'CASTR', 'HELL', 'ANDR', 'BELL', 'TARN', 'VESP', 'MIR', 'SOL', 'ARC', 'DUN', 'KEL', 'ZAR', 'LUM', 'PHAE', 'OST', 'RIG'];
const STAR_B = ['ARA', 'IS', 'ALY', 'US', 'ION', 'AN', 'OS', 'ETH', 'IRA', 'A', 'EN', 'OR', 'UM', 'IX', 'ON'];

const WORLD_A = ['HAL', 'KES', 'MOR', 'VAL', 'TER', 'ORO', 'NIM', 'CAL', 'SAR', 'BRE', 'DOR', 'ELM', 'FEN', 'GAL', 'HOR', 'IST', 'JAR', 'LOR', 'NAR', 'PEL', 'QUE', 'RAV', 'SEL', 'TOR', 'ULM', 'VAR', 'WEN', 'YAR', 'ZEN'];
const WORLD_B = ['DANE', 'SEL', 'ROW', 'ANTH', 'MIN', 'VAR', 'BUS', 'DRA', 'GATH', 'ISH', 'KOR', 'LUND', 'MERE', 'NOX', 'PHOS', 'RIS', 'TOK', 'VEN', 'WICK', 'ZAN'];
const WORLD_C = ['', '', '', ' II', ' PRIME', ' MINOR', ' MAJOR', ' DEEP'];

const MOON_NAMES = ['VESPER', 'CINDER', 'ASH', 'MOTE', 'PALE', 'SLATE', 'BRINE', 'LANTERN', 'SHARD', 'KNELL', 'RIME', 'DUSK', 'CAIRN', 'FLINT', 'MARROW', 'SHOAL', 'THORN', 'WISP', 'EMBER'];

const COLONY_SUFFIX = ['PORT', 'LANDING', 'STATION', 'HOLD', 'REACH', 'CAMP', 'DOWN', 'FIELD', 'HAVEN', 'CROSS'];
const COLONY_PREFIX = ['NEW', 'FORT', 'PORT', 'OLD', 'HIGH', 'LOW', 'FAR', 'EAST', 'WEST', 'NORTH'];
const MINE_NAMES = ['DEEP SHAFT', 'CUT', 'SEAM', 'BORE', 'DIGGINGS', 'QUARRY', 'DRIFT', 'CLAIM'];
const DERELICT_NAMES = ['WRECK OF THE ANVIL', 'THE SLEEPER', 'HULK OF ORION', 'THE PILGRIM', 'LOST SURVEYOR', 'THE MERIDIAN', 'SILENT COLUMN', 'THE ARGENT', 'DEAD RELAY', 'THE LODESTAR'];
const STATION_NAMES = { harbour: ['HARBOUR', 'ANCHORAGE', 'GATE', 'ROADSTEAD'], refinery: ['REFINERY', 'FORGE', 'SMELTER', 'WORKS'], research: ['OBSERVATORY', 'INSTITUTE', 'ARRAY', 'LISTENING POST'], outpost: ['OUTPOST', 'BEACON', 'RELAY'] };
const PERSON = ['KOVACS', 'ADEYEMI', 'STRAND', 'IBARRA', 'HOLM', 'NAKAMURA', 'OKORO', 'VASQUEZ', 'LINDQVIST', 'MBEKI', 'REYES', 'CHAUDHRY', 'DUNMORE', 'HALVORSEN', 'PETROVA', 'TANAKA', 'ABARA', 'FISKE'];

export interface Namer {
  star(): string;
  world(): string;
  moon(): string;
  colony(world: string): string;
  mine(): string;
  derelict(): string;
  station(kind: 'harbour' | 'refinery' | 'research' | 'outpost', world: string): string;
  person(): string;
  pilot(): string;
}

export function makeNamer(rng: Rng): Namer {
  const used = new Set<string>();
  const unique = (gen: () => string): string => {
    for (let i = 0; i < 40; i++) {
      const n = gen();
      if (!used.has(n)) { used.add(n); return n; }
    }
    const n = gen() + ' ' + (used.size + 1);
    used.add(n);
    return n;
  };
  const moons = rng.shuffle(MOON_NAMES.slice());
  const derelicts = rng.shuffle(DERELICT_NAMES.slice());
  const people = rng.shuffle(PERSON.slice());
  let moonIdx = 0, derIdx = 0, perIdx = 0, mineIdx = 1;
  return {
    star: () => unique(() => rng.pick(STAR_A) + rng.pick(STAR_B)),
    world: () => unique(() => rng.pick(WORLD_A) + rng.pick(WORLD_B) + rng.pick(WORLD_C)),
    moon: () => moons[moonIdx++ % moons.length],
    colony: (world: string) => unique(() => rng.chance(0.5) ? `${world.split(' ')[0]} ${rng.pick(COLONY_SUFFIX)}` : `${rng.pick(COLONY_PREFIX)} ${people[perIdx++ % people.length]}`),
    mine: () => `${rng.pick(MINE_NAMES)} ${mineIdx++}`,
    derelict: () => derelicts[derIdx++ % derelicts.length],
    station: (kind, world) => unique(() => `${world.split(' ')[0]} ${rng.pick(STATION_NAMES[kind])}`),
    person: () => people[perIdx++ % people.length],
    pilot: () => `${rng.pick(['CAPT.', 'LT.', 'PILOT', 'MASTER'])} ${people[perIdx++ % people.length]}`,
  };
}
