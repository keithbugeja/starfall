// Flight HUD: bars, readouts, radar, off-screen markers, event tracker, target bracket, docking and
// landing guidance, comms. All vector lines and stroke text.
import { drawText, textWidth } from '../engine/font';
import { angleDiff, clamp, TAU, type V2 } from '../engine/math';
import type { Body, Pad } from '../sim/bodies';
import { dominantBody, gravityAt, LAND_ANG, LAND_VN, LAND_VT, surfaceInfo } from '../sim/physics';
import { TETHER_BREAK } from '../sim/tether';
import { hubRadius, localAngle } from '../sim/stations';
import { hasSensors } from '../sim/upgrades';
import type { GameEvent, Ship, Station, World } from '../sim/world';
import { padWorldPos, terrainNormalAt, terrainRadiusAt } from '../sim/bodies';
import { sunlight } from '../sim/sense';
import type { Game } from './game';

export interface NavTarget {
  name: string;
  body?: Body;
  station?: Station;
  event?: GameEvent;
  pad?: Pad;
}

export function navPos(n: NavTarget): V2 {
  if (n.body) return n.body.pos;
  if (n.station) return n.station.pos;
  if (n.event) return n.event.pos;
  if (n.pad) return padWorldPos(n.pad, 0);
  return { x: 0, y: 0 };
}

export const C = {
  cyan: [0.45, 0.95, 1.0],
  amber: [1.0, 0.75, 0.3],
  red: [1.0, 0.35, 0.3],
  green: [0.5, 1.0, 0.6],
  violet: [0.85, 0.45, 1.0],
  white: [0.9, 0.95, 1.0],
  dim: [0.4, 0.5, 0.6],
  yellow: [1.0, 0.95, 0.5],
};

export function eventColor(kind: string): number[] {
  switch (kind) {
    case 'raid': return C.red;
    case 'convoy': return C.amber;
    case 'siege': return C.red;
    case 'stranded': return C.yellow;
    case 'construction': return C.violet;
    case 'rogue': return C.amber;
    case 'salvage': return C.green;
    case 'flare': return [1, 0.6, 0.2];
    case 'hunt': return C.red;
  }
  return C.white;
}

export function nearestEnemy(w: World, range: number): Ship | null {
  const p = w.player;
  let best: Ship | null = null, bd = range;
  for (const s of w.ships) {
    if (!s.alive || s.faction !== 'enemy' || s.docked) continue;
    if (w.time - s.sensedAt > 0.3) continue;
    const d = Math.hypot(s.pos.x - p.pos.x, s.pos.y - p.pos.y);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

export function drawFlightHud(g: Game): void {
  const w = g.world;
  const H = g.hudLines;
  const L = g.worldLines;
  const p = w.player;
  const W = g.camera.viewportW, Hh = g.camera.viewportH;
  const s = g.dpr;
  const t = w.time;

  // ---------------- bars
  const bx = 24 * s, by = Hh - 96 * s, bw = 190 * s, bh = 9 * s;
  const bar = (label: string, y: number, frac: number, col: number[], warn: boolean) => {
    drawText(H, label, bx, y - 13 * s, 10 * s, col[0], col[1], col[2], 0.85);
    H.rect2(bx, y, bw, bh, col[0], col[1], col[2], 0.45, 1.2);
    const segs = 19;
    for (let i = 0; i < segs; i++) {
      if ((i + 0.5) / segs > frac) break;
      const x = bx + (i / segs) * bw + 1.5 * s;
      H.line2(x, y + 1.5 * s, x + bw / segs - 3 * s, y + 1.5 * s, col[0], col[1], col[2], warn ? 0.55 + 0.45 * Math.sin(t * 12) : 0.9, bh - 3 * s);
    }
  };
  bar('HULL', by, p.hull / p.hullMax, p.hull < p.hullMax * 0.3 ? C.red : C.cyan, p.hull < p.hullMax * 0.3);
  bar('FUEL', by + 32 * s, p.fuel / p.fuelMax, p.fuel < p.fuelMax * 0.2 ? C.red : C.amber, p.fuel < p.fuelMax * 0.2);
  // in shadow the bar cools blue; hot and lit it burns amber; near the top it pulses
  const shade = p.docked ? 1 : 1 - sunlight(w, p.pos.x, p.pos.y, null);
  const heatCol = p.overheated ? C.red : shade > 0.5 ? [0.45, 0.8, 1.0] : [1.0, 0.55, 0.35];
  bar('HEAT', by + 64 * s, p.heat, heatCol, p.overheated || p.heat > 0.75);
  if (p.shield > 0) drawText(H, `SHIELD ${p.shield.toFixed(0)}`, bx, by - 30 * s, 10 * s, C.violet[0], C.violet[1], C.violet[2], 0.8);

  // cargo / pod
  const load = p.cargo.ore + p.cargo.salvage;
  drawText(H, `CARGO ${load}/${p.cargo.capacity}  ORE ${p.cargo.ore}  SLV ${p.cargo.salvage}`, bx + bw + 18 * s, by + 64 * s, 10 * s, C.dim[0], C.dim[1], C.dim[2], 0.9);
  if (p.towing) drawText(H, 'TOWING POD', bx + bw + 18 * s, by + 48 * s, 10 * s, C.green[0], C.green[1], C.green[2], 0.7 + 0.3 * Math.sin(t * 4));
  if (p.secondary && p.secondary.ammo >= 0) drawText(H, `SEEKERS ${p.secondary.ammo}`, bx + bw + 18 * s, by + 32 * s, 10 * s, C.violet[0], C.violet[1], C.violet[2], 0.8);
  if (p.tether) {
    const t = p.tether;
    const mass = t.kind === 'pickup' ? t.pickup!.mass : t.kind === 'asteroid' ? t.asteroid!.radius * t.asteroid!.radius * 2 : t.kind === 'ship' ? t.ship!.radius * t.ship!.radius * t.ship!.massMul : t.kind === 'body' && t.body!.free ? t.body!.bodyMass : Infinity;
    const strain = t.tension / TETHER_BREAK;
    const tc = strain < 0.35 ? C.cyan : strain < 0.7 ? C.amber : C.red;
    const what = t.kind === 'pickup' ? t.pickup!.name || t.pickup!.kind.toUpperCase() : t.kind === 'asteroid' ? 'ROCK' : t.kind === 'ship' ? t.ship!.name : t.kind === 'station' ? t.station!.name : t.body!.name;
    drawText(H, `CABLE ${what}  MASS ${mass === Infinity ? 'FIXED' : mass.toFixed(1)}  LOAD ${t.tension.toFixed(0)}`, bx + bw + 18 * s, by + 16 * s, 10 * s, tc[0], tc[1], tc[2], 0.9);
  }
  drawText(H, p.weapon.kind.toUpperCase(), bx + bw + 18 * s, by, 10 * s, C.cyan[0], C.cyan[1], C.cyan[2], 0.6);

  // ---------------- readouts bottom-right
  const speed = Math.hypot(p.vel.x, p.vel.y);
  const rx = W - 24 * s;
  drawText(H, `SPD ${speed.toFixed(0).padStart(3, ' ')}`, rx, Hh - 106 * s, 13 * s, C.cyan[0], C.cyan[1], C.cyan[2], 0.9, 'right');
  const dom = dominantBody(w, p.pos.x, p.pos.y);
  let landingBody: Body | null = null, landingAlt = 1e9;
  if (dom.body) {
    const b = dom.body;
    const dx = p.pos.x - b.pos.x, dy = p.pos.y - b.pos.y;
    const d = Math.hypot(dx, dy);
    const alt = b.kind === 'star' ? d - b.radius : d - terrainRadiusAt(b, Math.atan2(dy, dx));
    drawText(H, `ALT ${Math.max(0, alt).toFixed(0).padStart(4, ' ')}`, rx, Hh - 86 * s, 13 * s, C.cyan[0], C.cyan[1], C.cyan[2], 0.9, 'right');
    const gc = dom.g > p.stats.thrust * 0.8 ? C.red : C.violet;
    drawText(H, `${b.name}  G ${dom.g.toFixed(1)}`, rx, Hh - 66 * s, 11 * s, gc[0], gc[1], gc[2], 0.85, 'right');
    if (b.landable && alt < 50) { landingBody = b; landingAlt = alt; }
    if (b.kind === 'star' && alt < b.heatRadius - b.radius) drawText(H, 'STELLAR HEAT', rx, Hh - 46 * s, 11 * s, C.red[0], C.red[1], C.red[2], 0.6 + 0.4 * Math.sin(t * 10), 'right');
  }
  // ---------------- landing guidance (walls inside fissures, rotating hulls included)
  const si = !p.landed && p.alive ? surfaceInfo(w, p.pos.x, p.pos.y) : null;
  if (si && si.alt < 50 && si.body.landable) {
    const n = si.normal;
    const rvx = p.vel.x - si.vsurf.x, rvy = p.vel.y - si.vsurf.y;
    const vnn = rvx * n.x + rvy * n.y;
    const vn = -vnn;
    const vt = Math.hypot(rvx - vnn * n.x, rvy - vnn * n.y);
    const err = Math.abs(angleDiff(p.angle, Math.atan2(n.y, n.x)));
    const tol = p.stats.landTol;
    const okVn = vn < LAND_VN * tol, okVt = vt < LAND_VT * tol, okA = err < LAND_ANG * tol;
    const cx = W / 2, cy = Hh - 168 * s;
    drawText(H, 'LANDING', cx, cy - 34 * s, 10 * s, C.amber[0], C.amber[1], C.amber[2], 0.8, 'center');
    const c1 = okVn ? C.green : C.red, c2 = okVt ? C.green : C.red, c3 = okA ? C.green : C.red;
    drawText(H, `DOWN ${vn.toFixed(1)}`, cx - 118 * s, cy - 16 * s, 12 * s, c1[0], c1[1], c1[2], 0.95, 'center');
    drawText(H, `DRIFT ${vt.toFixed(1)}`, cx, cy - 16 * s, 12 * s, c2[0], c2[1], c2[2], 0.95, 'center');
    drawText(H, `TILT ${(err * 57.3).toFixed(0)}°`, cx + 118 * s, cy - 16 * s, 12 * s, c3[0], c3[1], c3[2], 0.95, 'center');
    drawText(H, `LIMITS ${(LAND_VN * tol).toFixed(1)} / ${(LAND_VT * tol).toFixed(1)} / ${(LAND_ANG * tol * 57.3).toFixed(0)}°`, cx, cy + 2 * s, 8 * s, C.dim[0], C.dim[1], C.dim[2], 0.7, 'center');
    void landingAlt; void landingBody;
  }
  if (p.landed) {
    const pad = p.landed.pad;
    const name = pad ? pad.name : p.landed.body.name + ' SURFACE';
    drawText(H, `LANDED: ${name}`, W / 2, Hh - 204 * s, 13 * s, C.green[0], C.green[1], C.green[2], 0.95, 'center');
    let line2 = 'THRUST TO LAUNCH';
    if (pad && pad.alive) {
      if (pad.kind === 'colony') line2 = `REFUELLING AND REPAIRING  ·  POPULATION ${pad.population}  ·  THRUST TO LAUNCH`;
      else if (pad.kind === 'mine') line2 = `REFUELLING  ·  LOADING ORE (${pad.stock} IN STOCK)  ·  THRUST TO LAUNCH`;
      else if (pad.kind === 'derelict') line2 = pad.stock > 0 ? 'SALVAGE CREW WORKING...' : 'STRIPPED  ·  THRUST TO LAUNCH';
    }
    drawText(H, line2, W / 2, Hh - 184 * s, 9 * s, C.green[0], C.green[1], C.green[2], 0.7, 'center');
  }

  // ---------------- warnings centre-top
  let wy = 52 * s;
  const warn = (text: string, col: number[], size = 14) => { drawText(H, text, W / 2, wy, size * s, col[0], col[1], col[2], 0.6 + 0.4 * Math.sin(t * 8), 'center'); wy += (size + 6) * s; };
  if (!p.alive) warn('KESTREL DESTROYED', C.red, 26);
  if (p.fuel <= 0 && p.alive) warn('FUEL EXHAUSTED  ·  GRAVITY WINS', C.red);
  else if (p.fuel < p.fuelMax * 0.12 && p.alive) warn('LOW FUEL', C.amber, 12);
  if (p.overheated) warn('WEAPON OVERHEATED', C.red, 12);
  if (w.flare.warned) warn(`SOLAR FLARE IN ${Math.ceil(w.flare.timer)}  ·  FIND SHADOW, LAND OR DOCK`, [1, 0.7, 0.2]);
  if (w.flare.active) warn(p.landed || p.docked ? 'FLARE  ·  SHELTERED' : 'FLARE  ·  RADIATION', [1, 0.6, 0.2]);
  if (w.time - w.journalNoteAt < 6 && w.journalNew > 0) drawText(H, `J  ·  ${w.journalNew} NEW IN THE JOURNAL`, W / 2, Hh - 224 * s, 9 * s, C.dim[0], C.dim[1], C.dim[2], 0.5 + 0.3 * Math.sin(t * 6), 'center');

  // ---------------- score line top-right
  drawText(H, `SCORE ${String(Math.floor(w.score)).padStart(7, '0')}   CR ${w.credits}   HULLS x${w.lives}`, rx, 18 * s, 11 * s, C.white[0], C.white[1], C.white[2], 0.85, 'right');
  const threatTxt = w.coreDestroyed ? 'SYSTEM SECURED' : `THREAT ${'|'.repeat(Math.min(10, Math.floor(w.threat)))}${'.'.repeat(Math.max(0, 10 - Math.floor(w.threat)))}`;
  drawText(H, threatTxt, rx, 34 * s, 9 * s, C.red[0], C.red[1], C.red[2], 0.6, 'right');

  // ---------------- comms top-left
  let y = 18 * s;
  const recent = w.comms.slice(-5);
  for (const c of recent) {
    const age = t - c.time;
    const a = clamp(1.3 - age / 14, 0, 1);
    if (a <= 0) continue;
    let size = c.priority >= 3 ? 11 : 10;
    const txt = `${c.from}: ${c.text}`;
    const maxW = W - 430 * s;
    const tw = textWidth(txt, size * s);
    if (tw > maxW) size *= maxW / tw;
    drawText(H, txt, 24 * s, y, size * s, c.color[0], c.color[1], c.color[2], a * 0.9);
    y += (size + 5) * s;
  }

  // ---------------- event tracker (right side)
  const active = w.events.filter(e => !e.resolved && !e.failed);
  let ey = 60 * s;
  if (active.length) drawText(H, 'SITUATION', rx, ey, 9 * s, C.dim[0], C.dim[1], C.dim[2], 0.8, 'right');
  ey += 14 * s;
  for (const e of active.slice(0, 5)) {
    const col = eventColor(e.kind);
    const d = Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y);
    const eta = speed > 5 ? d / Math.max(speed, 1) : 0;
    const timeTxt = e.kind === 'salvage' || e.kind === 'flare' ? '' : `  ${Math.max(0, Math.ceil(e.timer))}S`;
    const nav = g.navTarget?.event === e ? '> ' : '';
    drawText(H, `${nav}${e.label}  ${d.toFixed(0)}U${timeTxt}`, rx, ey, 10 * s, col[0], col[1], col[2], 0.85, 'right');
    void eta;
    ey += 14 * s;
  }

  // ---------------- radar
  const range = hasSensors(p) ? 1100 : 550;
  const rr = 62 * s;
  const rcx = W / 2, rcy = Hh - 64 * s - rr + 40 * s;
  H.circle2(rcx, rcy, rr, 40, C.cyan[0], C.cyan[1], C.cyan[2], 0.35 + w.hudFlicker, 1.2);
  H.circle2(rcx, rcy, rr * 0.5, 30, C.cyan[0], C.cyan[1], C.cyan[2], 0.15, 1);
  H.line2(rcx - 4 * s, rcy, rcx + 4 * s, rcy, C.cyan[0], C.cyan[1], C.cyan[2], 0.6, 1);
  H.line2(rcx, rcy - 4 * s, rcx, rcy + 4 * s, C.cyan[0], C.cyan[1], C.cyan[2], 0.6, 1);
  // heading tick
  H.line2(rcx, rcy, rcx + Math.cos(p.angle) * 9 * s, rcy - Math.sin(p.angle) * 9 * s, C.white[0], C.white[1], C.white[2], 0.9, 1.5);
  const toRadar = (x: number, y: number): [number, number, boolean] => {
    const dx = x - p.pos.x, dy = y - p.pos.y;
    const d = Math.hypot(dx, dy);
    const k = rr / range;
    if (d > range) return [rcx + dx / d * rr, rcy - dy / d * rr, false];
    return [rcx + dx * k, rcy - dy * k, true];
  };
  for (const b of w.bodies) {
    const [x, y, inR0] = toRadar(b.pos.x, b.pos.y);
    const col = b.kind === 'star' ? C.amber : b.pads.some(pd => pd.kind === 'core' && pd.alive) ? C.red : b.palette.high;
    const dd = Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y);
    const inR = inR0 && dd + b.radius < range;
    if (inR) H.circle2(x, y, Math.max(2 * s, b.radius * rr / range), 16, col[0], col[1], col[2], 0.7, 1.2);
    else if (b.kind === 'star' || b.kind !== 'moon') H.line2(x, y, x + (rcx - x) * 0.06, y + (rcy - y) * 0.06, col[0], col[1], col[2], 0.5, 2);
  }
  for (const st of w.stations) {
    if (!st.alive) continue;
    const [x, y, inR] = toRadar(st.pos.x, st.pos.y);
    if (inR) H.rect2(x - 2.5 * s, y - 2.5 * s, 5 * s, 5 * s, C.cyan[0], C.cyan[1], C.cyan[2], 0.9, 1.2);
    else H.rect2(x - 2 * s, y - 2 * s, 4 * s, 4 * s, C.cyan[0], C.cyan[1], C.cyan[2], 0.4, 1);
  }
  for (const sh of w.ships) {
    if (!sh.alive || sh === p || sh.docked) continue;
    if (sh.faction === 'enemy' && w.time - sh.sensedAt > 0.3) continue; // the sensors do not have it
    const [x, y, inR] = toRadar(sh.pos.x, sh.pos.y);
    if (!inR) continue;
    const col = sh.faction === 'enemy' ? C.red : C.green;
    const blink = sh.faction === 'enemy' && sh.ai?.target === p ? 0.6 + 0.4 * Math.sin(t * 10) : 0.9;
    H.line2(x - 1.5 * s, y, x + 1.5 * s, y, col[0], col[1], col[2], blink, sh.radius > 2 ? 4 * s : 2.5 * s);
  }
  for (const a of w.asteroids) {
    if (!a.alive || a.size < 2) continue;
    const dd = Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y);
    if (dd > range * 0.6) continue;
    const [x, y] = toRadar(a.pos.x, a.pos.y);
    const col = a.rogue ? C.amber : C.dim;
    H.line2(x - 0.8 * s, y, x + 0.8 * s, y, col[0], col[1], col[2], a.rogue ? 0.9 : 0.5, (a.size === 3 ? 2.2 : 1.5) * s);
  }
  for (const pk of w.pickups) {
    if (!pk.alive) continue;
    const [x, y, inR] = toRadar(pk.pos.x, pk.pos.y);
    if (!inR) continue;
    const col = pk.kind === 'pod' ? C.green : pk.kind === 'module' ? C.yellow : C.amber;
    H.line2(x - 1 * s, y, x + 1 * s, y, col[0], col[1], col[2], 0.8, 1.5 * s);
  }
  for (const e of active) {
    const [x, y, inR] = toRadar(e.pos.x, e.pos.y);
    const col = eventColor(e.kind);
    const a = 0.5 + 0.5 * Math.sin(t * 5 + e.id);
    const sz = (inR ? 4 : 3) * s;
    H.line2(x, y - sz, x + sz, y, col[0], col[1], col[2], a, 1.3);
    H.line2(x + sz, y, x, y + sz, col[0], col[1], col[2], a, 1.3);
    H.line2(x, y + sz, x - sz, y, col[0], col[1], col[2], a, 1.3);
    H.line2(x - sz, y, x, y - sz, col[0], col[1], col[2], a, 1.3);
  }
  if (g.navTarget) {
    const np = navPos(g.navTarget);
    const [x, y] = toRadar(np.x, np.y);
    H.line2(x - 4 * s, y - 4 * s, x + 4 * s, y + 4 * s, C.white[0], C.white[1], C.white[2], 0.9, 1.2);
    H.line2(x - 4 * s, y + 4 * s, x + 4 * s, y - 4 * s, C.white[0], C.white[1], C.white[2], 0.9, 1.2);
  }
  drawText(H, `${range}`, rcx + rr + 6 * s, rcy + rr - 8 * s, 8 * s, C.dim[0], C.dim[1], C.dim[2], 0.6);

  // ---------------- off-screen markers
  const edge = (wx: number, wy: number, col: number[], label: string, big: boolean) => {
    const sp = g.camera.simToScreen(wx, wy);
    const inset = 44 * s;
    if (sp && sp[0] > inset && sp[0] < W - inset && sp[1] > inset && sp[1] < Hh - inset) {
      if (big) {
        // on-screen: small diamond under the object with the label
        const sz = 6 * s;
        H.line2(sp[0], sp[1] - sz, sp[0] + sz, sp[1], col[0], col[1], col[2], 0.8, 1.2);
        H.line2(sp[0] + sz, sp[1], sp[0], sp[1] + sz, col[0], col[1], col[2], 0.8, 1.2);
        H.line2(sp[0], sp[1] + sz, sp[0] - sz, sp[1], col[0], col[1], col[2], 0.8, 1.2);
        H.line2(sp[0] - sz, sp[1], sp[0], sp[1] - sz, col[0], col[1], col[2], 0.8, 1.2);
        drawText(H, label, sp[0], sp[1] + 10 * s, 9 * s, col[0], col[1], col[2], 0.7, 'center');
      }
      return;
    }
    // direction from screen centre (use camera-projected direction; fallback to world direction)
    const cx = W / 2, cy = Hh / 2;
    let dx: number, dy: number;
    if (sp) { dx = sp[0] - cx; dy = sp[1] - cy; } else { dx = wx - p.pos.x; dy = -(wy - p.pos.y); }
    const l = Math.hypot(dx, dy) || 1;
    dx /= l; dy /= l;
    // clamp to rectangle
    const hw = W / 2 - inset, hh = Hh / 2 - inset;
    const k = Math.min(hw / Math.abs(dx || 1e-6), hh / Math.abs(dy || 1e-6));
    const ax = cx + dx * k, ay = cy + dy * k;
    const sz = (big ? 9 : 6) * s;
    const px = -dy, py = dx;
    H.line2(ax, ay, ax - dx * sz + px * sz * 0.6, ay - dy * sz + py * sz * 0.6, col[0], col[1], col[2], 0.9, 1.6);
    H.line2(ax, ay, ax - dx * sz - px * sz * 0.6, ay - dy * sz - py * sz * 0.6, col[0], col[1], col[2], 0.9, 1.6);
    if (label) {
      const d = Math.hypot(wx - p.pos.x, wy - p.pos.y);
      const tx = clamp(ax - dx * 14 * s, 60 * s, W - 60 * s), ty = clamp(ay - dy * 14 * s - 5 * s, 40 * s, Hh - 40 * s);
      drawText(H, `${label} ${d.toFixed(0)}`, tx, ty, 9 * s, col[0], col[1], col[2], 0.75, 'center');
    }
  };
  for (const e of active) edge(e.pos.x, e.pos.y, eventColor(e.kind), e.label.split(':')[0].slice(0, 22), true);
  if (g.navTarget) { const np = navPos(g.navTarget); edge(np.x, np.y, C.white, g.navTarget.name, true); }
  for (const sh of w.ships) {
    if (!sh.alive || sh.faction !== 'enemy' || sh.docked) continue;
    const d = Math.hypot(sh.pos.x - p.pos.x, sh.pos.y - p.pos.y);
    if (d < 320) edge(sh.pos.x, sh.pos.y, C.red, '', false);
  }
  const pod = w.pickups.find(pk => pk.alive && pk.kind === 'pod' && !pk.carriedBy);
  if (pod) edge(pod.pos.x, pod.pos.y, C.green, 'POD', true);

  // ---------------- target bracket and lead pip (world space)
  const tgt = nearestEnemy(w, 300);
  if (tgt && p.alive && !p.docked) {
    const upp = g.camera.unitsPerPixel();
    const r = Math.max(tgt.radius * 1.6, upp * 12);
    const bx2 = tgt.pos.x, by2 = tgt.pos.y;
    const c = tgt.ai?.target === p ? C.red : C.amber;
    const k = r * 0.4;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      L.seg(bx2 + sx * r, 0.3, -(by2 + sy * r), bx2 + sx * (r - k), 0.3, -(by2 + sy * r), c[0], c[1], c[2], 0.8, 1.3);
      L.seg(bx2 + sx * r, 0.3, -(by2 + sy * r), bx2 + sx * r, 0.3, -(by2 + sy * (r - k)), c[0], c[1], c[2], 0.8, 1.3);
    }
    // lead pip: where a pulse shot would meet the target
    const dx = tgt.pos.x - p.pos.x, dy = tgt.pos.y - p.pos.y;
    const d = Math.hypot(dx, dy);
    const tt = d / p.weapon.speed;
    const lx = tgt.pos.x + (tgt.vel.x - p.vel.x) * tt, ly = tgt.pos.y + (tgt.vel.y - p.vel.y) * tt;
    L.circleWorld(lx, 0.3, -ly, Math.max(0.7, upp * 4), 10, c[0], c[1], c[2], 0.7, 1.2);
    const sp = g.camera.simToScreen(tgt.pos.x, tgt.pos.y);
    if (sp) drawText(H, `${tgt.name} ${d.toFixed(0)}`, sp[0], sp[1] + r / upp + 6 * s, 9 * s, c[0], c[1], c[2], 0.7, 'center');
  }

  // ---------------- docking guidance (world space)
  for (const st of w.stations) {
    if (!st.alive) continue;
    const d = Math.hypot(st.pos.x - p.pos.x, st.pos.y - p.pos.y);
    const gapA = st.angle;
    const R = st.radius, hub = hubRadius(st);
    // gap ticks always
    for (const sgn of [-1, 1]) {
      const a = gapA + sgn * st.bayHalfWidth;
      const x0 = st.pos.x + Math.cos(a) * (R - R * 0.1), y0 = st.pos.y + Math.sin(a) * (R - R * 0.1);
      const x1 = st.pos.x + Math.cos(a) * (R + R * 0.14), y1 = st.pos.y + Math.sin(a) * (R + R * 0.14);
      const blink = 0.6 + 0.4 * Math.sin(t * 6);
      L.seg(x0, 0.5, -y0, x1, 0.5, -y1, C.green[0], C.green[1], C.green[2], blink, 2);
    }
    if (d < R * 4.5 && !p.docked) {
      // approach corridor: from the hub out through the gap
      const cx = Math.cos(gapA), cy = Math.sin(gapA);
      for (let i = 0; i < 5; i++) {
        const r0 = hub + 1 + i * (R * 1.3 - hub) / 5, r1 = r0 + (R * 1.3 - hub) / 10;
        L.seg(st.pos.x + cx * r0, 0.5, -(st.pos.y + cy * r0), st.pos.x + cx * r1, 0.5, -(st.pos.y + cy * r1), C.green[0], C.green[1], C.green[2], 0.5, 1.5);
      }
      const rel = Math.hypot(p.vel.x - st.vel.x, p.vel.y - st.vel.y);
      const loc = localAngle(st, p.pos.x, p.pos.y);
      const inGap = Math.abs(loc) < st.bayHalfWidth;
      const sp = g.camera.simToScreen(st.pos.x, st.pos.y);
      if (sp) {
        const col = rel < 7 ? C.green : C.amber;
        drawText(H, `${st.name}`, sp[0], sp[1] - R / g.camera.unitsPerPixel() - 26 * s, 10 * s, C.cyan[0], C.cyan[1], C.cyan[2], 0.8, 'center');
        drawText(H, `REL ${rel.toFixed(1)}  ${inGap ? 'IN CORRIDOR' : 'GAP ' + (loc > 0 ? 'CW' : 'CCW')}  DOCK < 7`, sp[0], sp[1] - R / g.camera.unitsPerPixel() - 14 * s, 9 * s, col[0], col[1], col[2], 0.8, 'center');
      }
    }
  }

  // ---------------- tractor beam
  if (p.tractor && p.alive) {
    for (const pk of w.pickups) {
      if (!pk.alive || pk.carriedBy || pk.kind === 'wreck') continue;
      const d = Math.hypot(pk.pos.x - p.pos.x, pk.pos.y - p.pos.y);
      if (d < 14) L.seg(p.pos.x, 0.2, -p.pos.y, pk.pos.x, 0.2, -pk.pos.y, C.violet[0], C.violet[1], C.violet[2], 0.35 + 0.2 * Math.sin(t * 20), 1.2);
    }
  }
  // pod tow line
  if (p.towing) L.seg(p.pos.x, 0.2, -p.pos.y, p.towing.pos.x, 0.2, -p.towing.pos.y, C.green[0], C.green[1], C.green[2], 0.6, 1.2);

  // ---------------- gravity vector under the ship (screen space arrow is in game.ts world vectors)
  void gravityAt; void textWidth; void TAU;
}
