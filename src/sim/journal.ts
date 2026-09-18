// The journal records what the pilot saw, in the pilot's words. Never a conclusion, never an
// objective. Some of it matters. Some of it is the weather.
import { angleDiff } from '../engine/math';
import { padWorldPos, type Pad } from './bodies';
import { sunlight, signature, losClear } from './sense';
import { poweredAt } from './power';
import { sfx, type World } from './world';

export interface JournalEntry { time: number; key: string; text: string; }

/** Add an observation once. Returns true if it was new. */
export function note(w: World, key: string, text: string): boolean {
  if (w.journalSeen.has(key)) return false;
  w.journalSeen.add(key);
  w.journal.push({ time: w.time, key, text });
  w.journalNew++;
  w.journalNoteAt = w.time;
  sfx(w, 'note', null, 0.5);
  return true;
}

interface JournalState {
  acc: number;
  lastLog: number;         // index into w.log already examined
  darkApproach: number;    // seconds drifting unseen past live guns
  landedSun: number;       // sunlight at the pad we sit on (-1 = not landed)
  faultPingAt: number;
  flareWarnSeen: boolean;
  spinSign: Map<number, number>;
}

const J = new WeakMap<World, JournalState>();

function state(w: World): JournalState {
  let j = J.get(w);
  if (!j) { j = { acc: 0, lastLog: 0, darkApproach: 0, landedSun: -1, faultPingAt: -1e9, flareWarnSeen: false, spinSign: new Map() }; J.set(w, j); }
  return j;
}

function dist(ax: number, ay: number, bx: number, by: number): number { return Math.hypot(ax - bx, ay - by); }

/** Observers run at 10 Hz. Everything here needs the pilot to have been there to see it. */
export function updateJournal(w: World, dt: number): void {
  const j = state(w);
  j.acc += dt;
  if (j.acc < 0.1) return;
  const step = j.acc;
  j.acc = 0;
  const p = w.player;
  if (!p.alive) return;

  // ---- read the sim log for things that happened within sight
  for (; j.lastLog < w.log.length; j.lastLog++) {
    const e = w.log[j.lastLog];
    const near = dist(e.x, e.y, p.pos.x, p.pos.y);
    switch (e.kind) {
      case 'overheat': {
        if (near > 220) break;
        const base = e.text;
        if (w.flare.active) note(w, 'guns-flare-' + base, `THE GUNS AT ${base} WENT QUIET IN THE FLARE. THE FINS COULD NOT KEEP UP.`);
        else if ((e.param ?? 1) > 0.3) note(w, 'guns-day-' + base, `${base}'S GUNS JAMMED AFTER A LONG BURST. IT WAS DAYLIGHT THERE.`);
        else note(w, 'guns-jam-' + base, `${base}'S GUNS JAMMED AFTER A LONG BURST.`);
        break;
      }
      case 'night-burst': if (near < 220) note(w, 'guns-night-' + e.text, `${e.text} KEPT FIRING ON THE NIGHT SIDE. TWENTY SHOTS AND NO PAUSE.`); break;
      case 'power-lost': {
        if (near > 320) break;
        const carrying = p.tether && p.tether.kind === 'pickup' && p.tether.pickup && p.tether.pickup.role === 'core';
        if (carrying) note(w, 'dark-cable-' + e.text, `${e.text.replace(' DARK', '')} WENT DARK THE MOMENT THE REGULATOR CAME OUT ON MY CABLE.`);
        else note(w, 'dark-' + e.text, `${e.text.replace(' DARK', '')} WENT DARK.`);
        break;
      }
      case 'core-foreign': if (near < 320) note(w, 'foreign-' + e.text, `${e.text}. THE SOCKET DID NOT CARE WHOSE IT WAS.`); break;
      case 'held-fire-core': if (near < 220) note(w, 'pass-' + e.text, `THE GUNS AT ${e.text} TRACKED ME BUT DID NOT FIRE. THE REGULATOR WAS ON MY CABLE.`); break;
      case 'contact-lost': if (near < 450) note(w, 'lost-' + e.text, `A ${e.text.split('|')[0]} LOST ME BEHIND ${e.text.split('|')[1]}. IT WENT LOOKING WHERE I HAD BEEN.`); break;
      case 'structure-destroyed': {
        if (near > 320) break;
        if (e.text.startsWith('PLANT') && e.text.includes('ROCK')) note(w, 'crushed-' + e.text, `SOMETHING HEAVY CRACKED THE HOUSING AT ${e.text.split(' AT ')[1].split(' DESTROYED')[0]}. THE LIGHTS WENT OUT WITH IT.`);
        else if (e.text.startsWith('RADIATOR')) note(w, 'fins-' + e.text, `THE FINS AT ${e.text.split(' AT ')[1].split(' DESTROYED')[0]} CAME APART. THIN METAL.`);
        else if (e.text.startsWith('MAST')) note(w, 'mast-' + e.text, `THE MAST AT ${e.text.split(' AT ')[1].split(' DESTROYED')[0]} IS DOWN. THE GUNS THERE SEEM SHORTER-SIGHTED NOW.`);
        break;
      }
      case 'civ-shot': if (near < 500) note(w, 'civ-' + e.text, `A ${e.text.split('|')[0]} WENT DOWN UNDER ${e.text.split('|')[1]}'S GUNS.`); break;
      case 'rock-rest': if (near < 200 && (e.param ?? 0) > 0) note(w, 'rock-rest', `THE ROCK I LET GO OF STAYED WHERE IT FELL ON ${e.text}.`); break;
      case 'ring-stopped': note(w, 'ring-' + e.text, `I STOPPED ${e.text}'S RING WITH THE CABLE. THE TRAFFIC KEPT WAITING FOR A GAP THAT NEVER CAME ROUND.`); break;
      case 'no-launch': if (near < 700) note(w, 'nolaunch-' + e.text, `NOTHING LAUNCHED FROM ${e.text} WHILE IT WAS DARK.`); break;
      default: break;
    }
  }

  // ---- drifting past live guns with the engines off
  {
    let watched = false;
    for (const s of w.ships) {
      if (!s.alive || s.kind !== 'sentinel' || !s.landed) continue;
      const d = dist(s.pos.x, s.pos.y, p.pos.x, p.pos.y);
      if (d > 110) continue;
      if (!poweredAt(w, s.landed.body, s.pos.x, s.pos.y)) continue;
      if (!losClear(w, s.pos.x, s.pos.y, p.pos.x, p.pos.y)) continue;
      watched = true;
      if (p.thrusting === 0 && !p.boosting && signature(w, p) < 0.3 && s.ai && s.ai.target !== p) j.darkApproach += step;
      else j.darkApproach = 0;
      if (j.darkApproach > 4) note(w, 'dark-approach', `I DRIFTED PAST ${(s.ai?.home as Pad | null)?.name ?? 'THE GUNS'} WITH THE ENGINES OFF. NOTHING WOKE.`);
    }
    if (!watched) j.darkApproach = 0;
  }

  // ---- night falling on a pad we are sitting on
  if (p.landed && p.landed.pad) {
    const pad = p.landed.pad;
    const pp = padWorldPos(pad, 0);
    const n = { x: (pp.x - pad.body.pos.x), y: (pp.y - pad.body.pos.y) };
    const l = Math.hypot(n.x, n.y) || 1;
    const sun = sunlight(w, pp.x, pp.y, { x: n.x / l, y: n.y / l });
    if (j.landedSun >= 0) {
      if (j.landedSun > 0.05 && sun <= 0.02) note(w, 'night-' + pad.name, `NIGHT CAME OVER ${pad.name} WHILE I SAT ON THE PAD. THE WORLD TURNS.`);
      if (j.landedSun <= 0.02 && sun > 0.05) note(w, 'dawn-' + pad.name, `DAWN AT ${pad.name}. THE STAR CAME UP OVER THE RIM.`);
    }
    j.landedSun = sun;
  } else j.landedSun = -1;

  // ---- flares: the corona and a coincidence
  if (w.flare.warned && !j.flareWarnSeen) {
    j.flareWarnSeen = true;
    if (!p.docked) note(w, 'corona', `THE CORONA'S RAYS LENGTHENED. THEN THE FLARE WARNING CAME.`);
    if (w.time - j.faultPingAt < 60) note(w, 'flare-fault', `A FLARE WARNING CAME WITHIN A MINUTE OF MY SCAN OF THE FAULT.`);
  }
  if (!w.flare.warned && !w.flare.active) j.flareWarnSeen = false;
  if (w.slices.faultLastPing > j.faultPingAt) j.faultPingAt = w.slices.faultLastPing;

  // ---- station rings: reversed by a cable, or simply turning against each other
  for (const st of w.stations) {
    if (!st.alive) continue;
    const prev = j.spinSign.get(st.id) ?? Math.sign(st.spinNominal);
    const sign = Math.abs(st.spin) < 0.02 ? 0 : Math.sign(st.spin);
    if (sign !== prev && p.tether && p.tether.kind === 'station' && p.tether.station === st) {
      w.log.push({ time: w.time, kind: 'ring-stopped', text: st.name, x: st.pos.x, y: st.pos.y, param: 0 });
    }
    j.spinSign.set(st.id, sign);
  }
  {
    const docked = w.stations.filter(s => s.alive && s.lastDockTime > -1e8);
    for (let a = 0; a < docked.length; a++) for (let b = a + 1; b < docked.length; b++) {
      if (Math.sign(docked[a].spinNominal) !== Math.sign(docked[b].spinNominal)) note(w, 'rings-' + docked[a].id + '-' + docked[b].id, `${docked[a].name}'S RING TURNS AGAINST ${docked[b].name}'S. NOBODY SEEMS TO MIND.`);
    }
  }
  void angleDiff;
}
