// Screens: title, docked station services, system map, help, death and game over. Vector text only.
import { drawText, textWidth } from '../engine/font';
import { clamp, TAU, type V2 } from '../engine/math';
import type { Pad } from '../sim/bodies';
import { applyUpgrades, installWeapon, UPGRADES, upgradeById } from '../sim/upgrades';
import { makeWeapon, sfx, type Station, type WeaponKind } from '../sim/world';
import type { Game } from './game';
import { C, eventColor, navPos, type NavTarget } from './hud';
import { padColor } from './game';

const CONTROLS: [string, string][] = [
  ['A / D  or  LEFT / RIGHT', 'ROTATE'],
  ['W / UP', 'MAIN THRUST'],
  ['SHIFT + THRUST', 'BOOST (BURNS FUEL, NO WEAPONS)'],
  ['S / DOWN', 'RETRO THRUST (UPGRADE)'],
  ['Q / E', 'LATERAL JETS (UPGRADE)'],
  ['SPACE / CTRL / LEFT MOUSE', 'FIRE'],
  ['X', 'SEEKER MISSILE (UPGRADE)'],
  ['T', 'CABLE: LATCH THE NEAREST THING, OR LET GO'],
  ['R', 'PING: A SENSOR PULSE. WATCH WHAT COMES BACK'],
  ['F (HOLD)', 'TRANSFER FUEL INTO WHAT YOU ARE LANDED ON OR TOUCHING'],
  ['MOUSE MOVE', 'STEER TOWARD CURSOR'],
  ['RIGHT MOUSE', 'BOOST'],
  ['M', 'SYSTEM MAP / SET COURSE'],
  ['TAB', 'CYCLE COURSE: EVENTS, STATIONS'],
  ['J', 'JOURNAL: WHAT YOU HAVE SEEN, IN YOUR OWN WORDS'],
  ['H', 'THIS SCREEN'],
  ['0', 'MUTE'],
  ['ESC', 'PAUSE / BACK'],
];

const TIPS: string[] = [
  'THE DOTTED LINE IS WHERE YOU WILL GO IF YOU DO NOTHING. TRUST IT.',
  'THE VIOLET ARROW IS GRAVITY. FACE AGAINST IT TO HOVER, ALONG IT TO DIVE.',
  'LAND: NOSE AWAY FROM THE GROUND, DOWN UNDER 4.5, DRIFT UNDER 2.6, TILT UNDER 27 DEGREES.',
  'DOCK: ENTER THE ROTATING RING THROUGH THE GAP, TOUCH THE HUB UNDER 7.',
  'SHOTS INHERIT YOUR VELOCITY AND BEND IN GRAVITY. THE SMALL CIRCLE IS WHERE TO AIM.',
  'A REAVER CARRYING A POD DROPS IT WHEN KILLED. CATCH THE POD SLOWLY, OR LET IT FALL HOME.',
  'A GAS GIANT SKIM REFUELS YOU. GO DEEP AND IT CRUSHES YOU.',
  'YOU CANNOT SAVE EVERYONE. CHOOSE.',
  'THE STARFALL CORE SITS ON THE ENEMY WORLD (RED ON THE MAP) UNDER SENTINEL GUNS. KILL IT TO SECURE THE SYSTEM.',
  'THE CABLE TAKES UP SLACK GENTLY AND PARTS IF YOU YANK IT. A HEAVY LOAD SWINGS. LET THE SWING WORK FOR YOU.',
];

export function drawTitle(g: Game): void {
  const H = g.hudLines;
  const W = g.camera.viewportW, Hh = g.camera.viewportH;
  const s = g.dpr;
  const t = performance.now() / 1000;
  const w = g.world;
  const flick = 0.92 + 0.08 * Math.sin(t * 30) * Math.sin(t * 7.3);
  const size = Math.min(96 * s, W / 9);
  drawText(H, 'STARFALL', W / 2, Hh * 0.2, size, 1.0, 0.85, 0.45, flick, 'center', 3.2);
  drawText(H, 'STARFALL', W / 2, Hh * 0.2, size, 0.5, 0.9, 1.0, 0.25, 'center', 6);
  drawText(H, `PATROL OF THE ${w.star.name} SYSTEM`, W / 2, Hh * 0.2 + size + 14 * s, 13 * s, C.cyan[0], C.cyan[1], C.cyan[2], 0.85, 'center');
  const bodies = w.bodies.filter(b => b.kind === 'planet' || b.kind === 'gas');
  const moons = w.bodies.filter(b => b.kind === 'moon');
  drawText(H, `${bodies.length} WORLDS  ·  ${moons.length} MOONS  ·  ${w.stations.length} STATIONS  ·  ${w.pads.filter(p => p.kind === 'colony').length} COLONIES  ·  ${w.pads.filter(p => p.kind === 'enemybase' || p.kind === 'core').length} ENEMY SITES`, W / 2, Hh * 0.2 + size + 32 * s, 10 * s, C.dim[0], C.dim[1], C.dim[2], 0.85, 'center');

  const blink = 0.5 + 0.5 * Math.sin(t * 4);
  drawText(H, 'PRESS ENTER TO LAUNCH', W / 2, Hh * 0.52, 18 * s, 1, 1, 1, 0.5 + blink * 0.5, 'center');
  drawText(H, `SEED  ${g.seedText}_`, W / 2, Hh * 0.52 + 30 * s, 11 * s, C.amber[0], C.amber[1], C.amber[2], 0.85, 'center');
  drawText(H, 'TYPE TO CHANGE THE SEED  ·  H FOR CONTROLS', W / 2, Hh * 0.52 + 46 * s, 9 * s, C.dim[0], C.dim[1], C.dim[2], 0.85, 'center');
  if (g.highScore > 0) drawText(H, `HIGH SCORE ${String(g.highScore).padStart(7, '0')}`, W / 2, Hh * 0.52 + 66 * s, 11 * s, C.green[0], C.green[1], C.green[2], 0.8, 'center');

  // compact controls at the bottom
  const rows = ['ROTATE A/D  ·  THRUST W  ·  BOOST SHIFT  ·  FIRE SPACE  ·  MAP M  ·  MOUSE STEERS', 'FLY WELL. GRAVITY IS NOT YOUR ENEMY. IT IS THE GAME.'];
  drawText(H, rows[0], W / 2, Hh - 64 * s, 10 * s, C.cyan[0], C.cyan[1], C.cyan[2], 0.7, 'center');
  drawText(H, rows[1], W / 2, Hh - 46 * s, 10 * s, C.amber[0], C.amber[1], C.amber[2], 0.6, 'center');
  drawText(H, 'AN ARCADE MACHINE FROM A 1982 THAT NEVER HAPPENED', W / 2, Hh - 24 * s, 8 * s, C.dim[0], C.dim[1], C.dim[2], 0.6, 'center');

  // input: hotkeys first, then seed entry (H is reserved for the manual)
  const inp = g.input;
  if (inp.wasPressed('KeyH') || inp.wasPressed('F1')) { g.helpReturn = 'title'; g.mode = 'help'; return; }
  if (inp.wasPressed('Enter') || inp.wasPressed('NumpadEnter') || inp.wasPressed('GP9') || inp.wasPressed('GP0')) { g.beginPatrol(); return; }
  for (const ch of inp.typed) {
    if (/^[a-gi-zA-GI-Z0-9 \-]$/.test(ch) && g.seedText.length < 16) { g.seedText += ch.toUpperCase(); g.seedDirty = true; }
  }
  if (inp.wasPressed('Backspace')) { g.seedText = g.seedText.slice(0, -1); g.seedDirty = true; }
}

export function drawHelp(g: Game): void {
  const H = g.hudLines;
  const W = g.camera.viewportW, Hh = g.camera.viewportH;
  const s = g.dpr;
  dim(g, 0.75);
  drawText(H, 'FLIGHT MANUAL', W / 2, 40 * s, 22 * s, C.amber[0], C.amber[1], C.amber[2], 0.95, 'center');
  let y = 90 * s;
  const x0 = W / 2 - 300 * s, x1 = W / 2 + 10 * s;
  for (const [k, v] of CONTROLS) {
    drawText(H, k, x0, y, 11 * s, C.cyan[0], C.cyan[1], C.cyan[2], 0.9);
    drawText(H, v, x1, y, 11 * s, C.white[0], C.white[1], C.white[2], 0.85);
    y += 18 * s;
  }
  y += 10 * s;
  drawText(H, 'THE LOOP: LAUNCH  ·  ANSWER CALLS OR HUNT  ·  LAND OR DOCK  ·  REFUEL, REPAIR, TRADE, UPGRADE  ·  LAUNCH', W / 2, y, 10 * s, C.green[0], C.green[1], C.green[2], 0.85, 'center');
  y += 24 * s;
  for (const tip of TIPS) { drawText(H, tip, W / 2, y, 9 * s, C.dim[0], C.dim[1], C.dim[2], 0.9, 'center'); y += 15 * s; }
  drawText(H, 'ESC OR H TO RETURN', W / 2, Hh - 40 * s, 11 * s, 1, 1, 1, 0.5 + 0.5 * Math.sin(performance.now() / 250), 'center');
  const inp = g.input;
  if (inp.wasPressed('Escape') || inp.wasPressed('KeyH') || inp.wasPressed('F1') || inp.wasPressed('Enter') || inp.wasPressed('GP1') || inp.wasPressed('GP9')) g.mode = g.helpReturn;
}

/** Darken the world behind an overlay by drawing nothing: the post fade handles it. */
function dim(g: Game, amount: number): void { g.overlayDim = amount; }

interface MenuRow { label: string; right: string; action: (() => void) | null; desc?: string; cost?: string; enabled: boolean; col?: number[]; }

export function drawDocked(g: Game): void {
  const H = g.hudLines;
  const W = g.camera.viewportW, Hh = g.camera.viewportH;
  const s = g.dpr;
  const w = g.world;
  const p = w.player;
  const st = p.docked;
  if (!st) { g.mode = 'flight'; return; }
  dim(g, 0.6);
  const inp = g.input;
  const rows: MenuRow[] = [];
  const fuelNeed = p.fuelMax - p.fuel;
  const fuelCost = Math.ceil(fuelNeed * st.fuelPrice);
  const repairNeed = p.hullMax - p.hull;
  const repairCost = Math.ceil(repairNeed * 3);
  rows.push({ label: 'REFUEL', right: fuelNeed < 0.5 ? 'FULL' : `${fuelCost} CR`, enabled: fuelNeed >= 0.5 && w.credits >= Math.min(fuelCost, 1), action: () => {
    const afford = Math.min(fuelNeed, w.credits / st.fuelPrice);
    if (afford <= 0) { sfx(w, 'deny'); return; }
    w.credits -= Math.ceil(afford * st.fuelPrice); p.fuel += afford; sfx(w, 'buy');
  } });
  rows.push({ label: 'REPAIR HULL', right: repairNeed < 0.5 ? 'INTACT' : `${repairCost} CR`, enabled: repairNeed >= 0.5 && w.credits > 0, action: () => {
    const afford = Math.min(repairNeed, w.credits / 3);
    if (afford <= 0) { sfx(w, 'deny'); return; }
    w.credits -= Math.ceil(afford * 3); p.hull += afford; sfx(w, 'buy');
  } });
  if (p.secondary) {
    const need = 6 - p.secondary.ammo;
    rows.push({ label: 'REARM SEEKERS', right: need <= 0 ? 'FULL' : `${need * 40} CR`, enabled: need > 0 && w.credits >= 40, action: () => {
      const n = Math.min(need, Math.floor(w.credits / 40)); if (n <= 0) { sfx(w, 'deny'); return; } w.credits -= n * 40; p.secondary!.ammo += n; sfx(w, 'buy');
    } });
  }
  rows.push({ label: `SELL ORE (${p.cargo.ore})`, right: `${st.orePrice} CR EACH`, enabled: p.cargo.ore > 0, action: () => { w.credits += p.cargo.ore * st.orePrice; w.score += p.cargo.ore * 20; w.stats.oreSold += p.cargo.ore; p.cargo.ore = 0; sfx(w, 'buy'); } });
  rows.push({ label: `SELL SALVAGE (${p.cargo.salvage})`, right: `${st.salvagePrice} CR EACH`, enabled: p.cargo.salvage > 0, action: () => { w.credits += p.cargo.salvage * st.salvagePrice; w.score += p.cargo.salvage * 30; w.stats.salvageSold += p.cargo.salvage; p.cargo.salvage = 0; sfx(w, 'buy'); } });
  if (p.ownedWeapons.length > 1) {
    for (const wk of p.ownedWeapons) {
      const active = p.weapon.kind === wk;
      rows.push({ label: `EQUIP ${wk.toUpperCase()}`, right: active ? 'ACTIVE' : '', enabled: !active, action: () => { p.weapon = makeWeapon(wk as WeaponKind); sfx(w, 'ui'); } });
    }
  }
  const serviceCount = rows.length;
  for (const id of st.upgrades) {
    const u = upgradeById(id);
    if (!u) continue;
    const owned = p.upgrades.includes(id) || (u.weapon ? p.ownedWeapons.includes(u.weapon) : false) || (id === 'seeker' && !!p.secondary);
    rows.push({ label: u.name, right: owned ? 'OWNED' : `${u.price} CR`, enabled: !owned && w.credits >= u.price, desc: u.desc, cost: u.cost, col: owned ? C.dim : undefined, action: owned ? null : () => {
      if (w.credits < u.price) { sfx(w, 'deny'); return; }
      w.credits -= u.price;
      if (u.weapon) installWeapon(p, u.weapon);
      else if (id === 'seeker') p.secondary = { ...makeWeapon('seeker'), ammo: 6 };
      else { p.upgrades.push(id); applyUpgrades(p); }
      sfx(w, 'buy');
    } });
  }
  rows.push({ label: 'LAUNCH', right: 'ENTER / L', enabled: true, action: () => g.launch() });

  // navigation
  if (inp.wasPressed('ArrowUp') || inp.wasPressed('KeyW') || inp.wasPressed('GP12')) { g.menuIndex = (g.menuIndex - 1 + rows.length) % rows.length; sfx(w, 'uimove'); }
  if (inp.wasPressed('ArrowDown') || inp.wasPressed('KeyS') || inp.wasPressed('GP13')) { g.menuIndex = (g.menuIndex + 1) % rows.length; sfx(w, 'uimove'); }
  g.menuIndex = clamp(g.menuIndex, 0, rows.length - 1);
  // layout
  const leftX = 60 * s, rightX = W / 2 + 30 * s;
  const rowH = 20 * s;
  const top = 124 * s;
  drawText(H, st.name, leftX, 36 * s, 22 * s, C.cyan[0], C.cyan[1], C.cyan[2], 0.95);
  drawText(H, `${st.kind.toUpperCase()}  ·  DOCKED  ·  TIME PASSES OUTSIDE`, leftX, 64 * s, 10 * s, C.dim[0], C.dim[1], C.dim[2], 0.9);
  drawText(H, `CREDITS ${w.credits}   HULL ${p.hull.toFixed(0)}/${p.hullMax}   FUEL ${p.fuel.toFixed(0)}/${p.fuelMax}   CARGO ${p.cargo.ore + p.cargo.salvage}/${p.cargo.capacity}   MASS ${(p.massMul * 100).toFixed(0)}%`, leftX, 82 * s, 10 * s, C.amber[0], C.amber[1], C.amber[2], 0.9);
  drawText(H, 'SERVICES', leftX, top - 22 * s, 11 * s, C.white[0], C.white[1], C.white[2], 0.8);
  drawText(H, 'OUTFITTING', rightX, top - 22 * s, 11 * s, C.white[0], C.white[1], C.white[2], 0.8);
  const mx = inp.mouseX * s, my = inp.mouseY * s;
  let hovered = -1;
  rows.forEach((r, i) => {
    const isUpgrade = i >= serviceCount && i < rows.length - 1;
    const x = isUpgrade ? rightX : leftX;
    const idx = isUpgrade ? i - serviceCount : (i === rows.length - 1 ? serviceCount + 1 : i);
    const y = top + idx * rowH;
    const colW = W / 2 - 90 * s;
    if (mx >= x - 8 * s && mx <= x + colW && my >= y - 4 * s && my <= y + rowH - 4 * s) hovered = i;
    const sel = i === g.menuIndex;
    const col = r.col ?? (r.enabled ? (sel ? C.white : C.cyan) : C.dim);
    if (sel) H.line2(x - 12 * s, y + 6 * s, x - 5 * s, y + 6 * s, C.amber[0], C.amber[1], C.amber[2], 0.9, 2);
    drawText(H, r.label, x, y, 11 * s, col[0], col[1], col[2], sel ? 1 : 0.85);
    if (r.right) drawText(H, r.right, x + colW, y, 11 * s, col[0], col[1], col[2], sel ? 1 : 0.7, 'right');
  });
  if (hovered >= 0 && (inp.mouseDX !== 0 || inp.mouseDY !== 0)) g.menuIndex = hovered;
  // description of the selected upgrade
  const sel = rows[g.menuIndex];
  const descY = top + (st.upgrades.length + 1) * rowH + 10 * s;
  if (sel?.desc) {
    drawText(H, sel.desc, rightX, descY, 10 * s, C.green[0], C.green[1], C.green[2], 0.9);
    drawText(H, 'COST: ' + (sel.cost ?? ''), rightX, descY + 16 * s, 10 * s, C.amber[0], C.amber[1], C.amber[2], 0.85);
  }
  // ship summary
  const shipY = descY + 44 * s;
  drawText(H, `FITTED: ${p.upgrades.length ? p.upgrades.map(u => upgradeById(u)?.name ?? u).join(', ') : 'STOCK KESTREL'}`, rightX, shipY, 9 * s, C.dim[0], C.dim[1], C.dim[2], 0.85);
  if (p.modules.length) drawText(H, `MODULES: ${p.modules.map(m => m.toUpperCase()).join(', ')}`, rightX, shipY + 14 * s, 9 * s, C.yellow[0], C.yellow[1], C.yellow[2], 0.85);
  // active situations reminder
  const active = w.events.filter(e => !e.resolved && !e.failed);
  let ey = top + (serviceCount + 3) * rowH;
  if (active.length) { drawText(H, 'SITUATIONS OUTSIDE', leftX, ey, 10 * s, C.red[0], C.red[1], C.red[2], 0.8); ey += 16 * s; }
  for (const e of active.slice(0, 5)) { const col = eventColor(e.kind); drawText(H, `${e.label}  ${Math.max(0, Math.ceil(e.timer))}S`, leftX, ey, 9 * s, col[0], col[1], col[2], 0.85); ey += 14 * s; }
  drawText(H, 'UP/DOWN SELECT  ·  ENTER BUY  ·  L LAUNCH  ·  M MAP  ·  H MANUAL', W / 2, Hh - 30 * s, 9 * s, C.dim[0], C.dim[1], C.dim[2], 0.8, 'center');
  // activation
  const clicked = (inp.mousePressed & 1) !== 0 && hovered >= 0;
  if (clicked) g.menuIndex = hovered;
  if (inp.wasPressed('Enter') || inp.wasPressed('NumpadEnter') || inp.wasPressed('Space') || inp.wasPressed('GP0') || clicked) {
    const r = rows[g.menuIndex];
    if (r.action && r.enabled) r.action(); else sfx(w, 'deny');
  }
  if (inp.wasPressed('KeyL') || inp.wasPressed('GP1')) g.launch();
  if (inp.wasPressed('KeyM') || inp.wasPressed('GP8')) { g.mapReturn = 'docked'; g.mode = 'map'; inp.consume('KeyM'); inp.consume('GP8'); }
  if (inp.wasPressed('KeyH') || inp.wasPressed('F1')) { g.helpReturn = 'docked'; g.mode = 'help'; inp.consume('KeyH'); inp.consume('F1'); }
  void UPGRADES; void textWidth;
}

export function drawMap(g: Game): void {
  const H = g.hudLines;
  const W = g.camera.viewportW, Hh = g.camera.viewportH;
  const s = g.dpr;
  const w = g.world;
  const p = w.player;
  const inp = g.input;
  dim(g, 0.85);
  let maxR = 300;
  for (const b of w.bodies) if (b.orbit) { const r = (b.orbit.parent.orbit ? b.orbit.parent.orbit.radius : 0) + b.orbit.radius + b.radius; if (r > maxR) maxR = r; }
  const scale = Math.min(W, Hh) * 0.46 / maxR * g.mapZoom;
  const cx = W / 2 - g.mapPan.x * scale, cy = Hh / 2 + g.mapPan.y * scale;
  const toS = (x: number, y: number): [number, number] => [cx + x * scale, cy - y * scale];
  // star and orbits
  const [sx, sy] = toS(w.star.pos.x, w.star.pos.y);
  H.circle2(sx, sy, Math.max(4 * s, w.star.radius * scale), 24, C.amber[0], C.amber[1], C.amber[2], 0.9, 1.5);
  drawText(H, w.star.name, sx, sy + Math.max(4 * s, w.star.radius * scale) + 6 * s, 9 * s, C.amber[0], C.amber[1], C.amber[2], 0.8, 'center');
  interface Sel { name: string; x: number; y: number; nav: NavTarget; col: number[]; }
  const sels: Sel[] = [];
  // belts and clusters as faint dust
  for (const a of w.asteroids) {
    if (!a.alive || a.size < 2) continue;
    const [x, y] = toS(a.pos.x, a.pos.y);
    H.line2(x, y, x + 0.6 * s, y, a.rich ? C.amber[0] : C.dim[0], a.rich ? C.amber[1] : C.dim[1], a.rich ? C.amber[2] : C.dim[2], 0.35, 1.2 * s);
  }
  for (const b of w.bodies) {
    if (b.orbit) {
      const [ox, oy] = toS(b.orbit.parent.pos.x, b.orbit.parent.pos.y);
      H.circle2(ox, oy, b.orbit.radius * scale, b.kind === 'moon' ? 24 : 72, C.dim[0], C.dim[1], C.dim[2], b.kind === 'moon' ? 0.18 : 0.25, 1);
    }
    if (b.kind === 'star') continue;
    const [bx, by] = toS(b.pos.x, b.pos.y);
    const r = Math.max(3 * s, b.radius * scale);
    const enemyWorld = b.pads.some(pd => (pd.kind === 'core' || pd.kind === 'enemybase') && pd.alive);
    const col = b.name === 'THE FAULT' ? C.violet : enemyWorld ? C.red : b.palette.high;
    H.circle2(bx, by, r, 20, col[0], col[1], col[2], 0.9, 1.3);
    const named = !b.secret || w.discovered.has(b.name);
    if (named && (b.kind !== 'moon' || g.mapZoom > 1.8)) drawText(H, b.name, bx, by + r + 5 * s, (b.kind === 'moon' ? 7 : 9) * s, col[0], col[1], col[2], 0.85, 'center');
    if (named) sels.push({ name: b.name, x: bx, y: by, nav: { name: b.name, body: b }, col });
    // pads as ticks around the body
    for (const pd of b.pads) {
      if (pd.interior && !w.discovered.has(pd.name)) continue;
      const pc = padColor(pd.kind, pd.alive);
      const pa = pd.angle + (b.rotates ? b.spinAngle : 0);
      const ax = bx + Math.cos(pa) * (r + 3 * s), ay = by - Math.sin(pa) * (r + 3 * s);
      H.line2(ax, ay, ax + Math.cos(pa) * 4 * s, ay - Math.sin(pa) * 4 * s, pc[0], pc[1], pc[2], 0.9, 2);
      if (g.mapZoom > 2.2 && (!b.secret || w.discovered.has(b.name))) { drawText(H, pd.kind === 'colony' ? `${pd.name} (${pd.population})` : pd.name, ax + Math.cos(pa) * 12 * s, ay - Math.sin(pa) * 12 * s - 4 * s, 7 * s, pc[0], pc[1], pc[2], 0.85, 'center'); sels.push({ name: pd.name, x: ax, y: ay, nav: { name: pd.name, pad: pd }, col: pc }); }
    }
  }
  for (const st of w.stations) {
    const [x, y] = toS(st.pos.x, st.pos.y);
    const col = st.alive ? C.cyan : C.dim;
    H.rect2(x - 4 * s, y - 4 * s, 8 * s, 8 * s, col[0], col[1], col[2], 0.95, 1.4);
    drawText(H, st.name, x + 8 * s, y - 3 * s, 7 * s, col[0], col[1], col[2], 0.85, 'left');
    if (st.alive) sels.push({ name: st.name, x, y, nav: { name: st.name, station: st }, col });
  }
  // events
  const active = w.events.filter(e => !e.resolved && !e.failed);
  for (const e of active) {
    const [x, y] = toS(e.pos.x, e.pos.y);
    const col = eventColor(e.kind);
    const a = 0.6 + 0.4 * Math.sin(performance.now() / 120 + e.id);
    const sz = 7 * s;
    H.line2(x, y - sz, x + sz, y, col[0], col[1], col[2], a, 1.5);
    H.line2(x + sz, y, x, y + sz, col[0], col[1], col[2], a, 1.5);
    H.line2(x, y + sz, x - sz, y, col[0], col[1], col[2], a, 1.5);
    H.line2(x - sz, y, x, y - sz, col[0], col[1], col[2], a, 1.5);
    drawText(H, e.label, x, y - sz - 12 * s, 8 * s, col[0], col[1], col[2], 0.9, 'center');
    sels.push({ name: e.label, x, y, nav: { name: e.label.split(':')[0].slice(0, 20), event: e }, col });
  }
  // ships in sensor range
  const range = p.upgrades.includes('sensors') ? 1100 : 550;
  for (const sh of w.ships) {
    if (!sh.alive || sh === p || sh.docked) continue;
    if (Math.hypot(sh.pos.x - p.pos.x, sh.pos.y - p.pos.y) > range) continue;
    const [x, y] = toS(sh.pos.x, sh.pos.y);
    const col = sh.faction === 'enemy' ? C.red : C.green;
    H.line2(x - 1.5 * s, y, x + 1.5 * s, y, col[0], col[1], col[2], 0.9, 3 * s);
  }
  // player
  {
    const [x, y] = toS(p.pos.x, p.pos.y);
    const a = p.angle, r = 7 * s;
    const pts = [x + Math.cos(a) * r, y - Math.sin(a) * r, x + Math.cos(a + 2.5) * r, y - Math.sin(a + 2.5) * r, x + Math.cos(a - 2.5) * r, y - Math.sin(a - 2.5) * r];
    H.polyline2(pts, 1, 1, 1, 1, 1.5, true);
    H.circle2(x, y, range * scale, 48, C.cyan[0], C.cyan[1], C.cyan[2], 0.12, 1);
    // predicted drift for 30 s (cheap: straight line with current velocity)
    H.line2(x, y, x + p.vel.x * 30 * scale, y - p.vel.y * 30 * scale, C.cyan[0], C.cyan[1], C.cyan[2], 0.25, 1);
  }
  // cursor selection
  const mx = inp.mouseX * s, my = inp.mouseY * s;
  let best: Sel | null = null, bd = 28 * s;
  for (const se of sels) { const d = Math.hypot(se.x - mx, se.y - my); if (d < bd) { bd = d; best = se; } }
  if (best) {
    H.circle2(best.x, best.y, 12 * s, 16, 1, 1, 1, 0.8, 1.2);
    const np = navPos(best.nav);
    const d = Math.hypot(np.x - p.pos.x, np.y - p.pos.y);
    drawText(H, `${best.name}  ${d.toFixed(0)}U  ·  CLICK TO SET COURSE`, mx + 14 * s, my - 6 * s, 9 * s, 1, 1, 1, 0.9);
    if ((inp.mousePressed & 1) !== 0 || inp.wasPressed('Enter')) { g.navTarget = best.nav; sfx(w, 'ui'); g.mode = g.mapReturn; }
  }
  if (g.navTarget) {
    const np = navPos(g.navTarget);
    const [x, y] = toS(np.x, np.y);
    H.line2(x - 8 * s, y - 8 * s, x + 8 * s, y + 8 * s, 1, 1, 1, 0.9, 1.3);
    H.line2(x - 8 * s, y + 8 * s, x + 8 * s, y - 8 * s, 1, 1, 1, 0.9, 1.3);
    const [px, py] = toS(p.pos.x, p.pos.y);
    H.line2(px, py, x, y, 1, 1, 1, 0.25, 1);
  }
  // header and legend
  drawText(H, `${w.star.name} SYSTEM  ·  T+${Math.floor(w.time / 60)}:${String(Math.floor(w.time % 60)).padStart(2, '0')}  ·  THREAT ${w.threat.toFixed(1)}`, 24 * s, 20 * s, 12 * s, C.cyan[0], C.cyan[1], C.cyan[2], 0.9);
  const legend = ['CYAN TICK: COLONY', 'AMBER: MINE', 'GREEN: DERELICT', 'RED: ENEMY SITE', 'DIAMOND: SITUATION', 'SQUARE: STATION'];
  legend.forEach((l, i) => drawText(H, l, 24 * s, 44 * s + i * 13 * s, 8 * s, C.dim[0], C.dim[1], C.dim[2], 0.85));
  let ey = 44 * s;
  const rx = W - 24 * s;
  drawText(H, 'SITUATIONS', rx, 20 * s, 12 * s, C.red[0], C.red[1], C.red[2], 0.9, 'right');
  active.forEach((e, i) => {
    const col = eventColor(e.kind);
    const d = Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y);
    drawText(H, `${i + 1}. ${e.label}  ${d.toFixed(0)}U  ${Math.max(0, Math.ceil(e.timer))}S`, rx, ey, 9 * s, col[0], col[1], col[2], 0.9, 'right');
    if (inp.wasPressed('Digit' + (i + 1))) { g.navTarget = { name: e.label.split(':')[0].slice(0, 20), event: e }; sfx(w, 'ui'); g.mode = g.mapReturn; }
    ey += 14 * s;
  });
  if (!active.length) drawText(H, 'QUIET. FOR NOW.', rx, ey, 9 * s, C.dim[0], C.dim[1], C.dim[2], 0.8, 'right');
  const colonies = w.pads.filter(pd => pd.kind === 'colony');
  drawText(H, `COLONIES ${colonies.filter(pd => pd.alive).length}/${colonies.length}  ·  PODS LOST ${w.lost}  ·  RESCUED ${w.rescued}  ·  BASES DESTROYED ${w.stats.basesDestroyed}`, rx, Hh - 46 * s, 9 * s, C.dim[0], C.dim[1], C.dim[2], 0.85, 'right');
  drawText(H, 'MOUSE: PICK  ·  WHEEL: ZOOM  ·  ARROWS: PAN  ·  1-5: COURSE TO SITUATION  ·  C: CLEAR COURSE  ·  M / ESC: CLOSE', W / 2, Hh - 24 * s, 9 * s, C.dim[0], C.dim[1], C.dim[2], 0.85, 'center');
  // controls
  if (inp.wheel !== 0) g.mapZoom = clamp(g.mapZoom * (inp.wheel > 0 ? 0.8 : 1.25), 0.6, 6);
  const pan = 40 / scale;
  if (inp.down('ArrowLeft') || inp.down('KeyA')) g.mapPan.x -= pan * 0.1;
  if (inp.down('ArrowRight') || inp.down('KeyD')) g.mapPan.x += pan * 0.1;
  if (inp.down('ArrowUp') || inp.down('KeyW')) g.mapPan.y += pan * 0.1;
  if (inp.down('ArrowDown') || inp.down('KeyS')) g.mapPan.y -= pan * 0.1;
  if (inp.wasPressed('KeyC')) { g.navTarget = null; sfx(w, 'ui'); }
  if (inp.wasPressed('KeyM') || inp.wasPressed('Escape') || inp.wasPressed('GP8') || inp.wasPressed('GP1')) g.mode = g.mapReturn;
  void TAU;
}

export function drawDeath(g: Game): void {
  const H = g.hudLines;
  const W = g.camera.viewportW, Hh = g.camera.viewportH;
  const s = g.dpr;
  const w = g.world;
  const p = w.player;
  const cause = causeText(p.lastDamageSource, p.lastHitBy);
  drawText(H, 'KESTREL LOST', W / 2, Hh * 0.38, 30 * s, C.red[0], C.red[1], C.red[2], 0.95, 'center', 2.5);
  drawText(H, cause, W / 2, Hh * 0.38 + 40 * s, 12 * s, C.amber[0], C.amber[1], C.amber[2], 0.9, 'center');
  if (w.lives > 0) {
    drawText(H, `${w.lives} HULL${w.lives === 1 ? '' : 'S'} REMAINING  ·  RETURNING TO ${w.respawnStation?.name ?? 'BASE'} IN ${Math.ceil(g.respawnTimer)}`, W / 2, Hh * 0.38 + 62 * s, 11 * s, C.cyan[0], C.cyan[1], C.cyan[2], 0.9, 'center');
    drawText(H, 'CARGO AND TOWED POD ARE LOST. UPGRADES AND CREDITS REMAIN.', W / 2, Hh * 0.38 + 80 * s, 9 * s, C.dim[0], C.dim[1], C.dim[2], 0.9, 'center');
  }
}

export function causeText(source: string, by: string): string {
  switch (source) {
    case 'impact': return 'HULL BREACH ON IMPACT WITH TERRAIN';
    case 'collision': return by === 'enemy' ? 'RAMMED BY A HOSTILE' : 'COLLISION';
    case 'weapon': return by === 'enemy' ? 'DESTROYED BY ENEMY FIRE' : 'DESTROYED BY WEAPON FIRE';
    case 'heat': return 'COOKED BY STELLAR HEAT';
    case 'star': return 'FELL INTO THE STAR';
    case 'flare': return 'IRRADIATED BY A SOLAR FLARE';
    case 'atmosphere': return 'CRUSHED IN A GAS GIANT';
    case 'explosion': return 'CAUGHT IN AN EXPLOSION';
  }
  return 'LOST WITH ALL HANDS';
}

export function drawGameOver(g: Game): void {
  const H = g.hudLines;
  const W = g.camera.viewportW, Hh = g.camera.viewportH;
  const s = g.dpr;
  const w = g.world;
  dim(g, 0.7);
  const won = w.coreDestroyed && w.lives > 0;
  const title = won ? 'SYSTEM SECURED' : 'PATROL ENDED';
  const col = won ? C.green : C.red;
  drawText(H, title, W / 2, Hh * 0.16, 34 * s, col[0], col[1], col[2], 0.95, 'center', 2.5);
  const mins = Math.floor(w.time / 60), secs = Math.floor(w.time % 60);
  const lines = [
    `FINAL SCORE ${String(Math.floor(w.score)).padStart(7, '0')}${w.score >= g.highScore && w.score > 0 ? '  ·  NEW HIGH SCORE' : ''}`,
    `TIME ON PATROL ${mins}:${String(secs).padStart(2, '0')}   DISTANCE ${(w.stats.distance / 1000).toFixed(1)}K`,
    `KILLS ${w.kills}   BASES DESTROYED ${w.stats.basesDestroyed}   PODS RESCUED ${w.rescued}   PODS LOST ${w.lost}`,
    `LANDINGS ${w.stats.landings}   DOCKINGS ${w.stats.docks}   CRASHES ${w.stats.crashes}   HULLS LOST ${w.stats.deaths}`,
    `SITUATIONS RESOLVED ${w.stats.eventsResolved}   FAILED ${w.stats.eventsFailed}   ORE SOLD ${w.stats.oreSold}   SALVAGE SOLD ${w.stats.salvageSold}`,
    `COLONIES STANDING ${w.pads.filter(p => p.kind === 'colony' && p.alive).length}/${w.pads.filter(p => p.kind === 'colony').length}`,
  ];
  lines.forEach((l, i) => drawText(H, l, W / 2, Hh * 0.16 + 60 * s + i * 22 * s, 11 * s, i === 0 ? C.amber[0] : C.white[0], i === 0 ? C.amber[1] : C.white[1], i === 0 ? C.amber[2] : C.white[2], 0.9, 'center'));
  if (!won) drawText(H, causeText(w.player.lastDamageSource, w.player.lastHitBy), W / 2, Hh * 0.16 + 60 * s + lines.length * 22 * s + 6 * s, 10 * s, C.dim[0], C.dim[1], C.dim[2], 0.9, 'center');
  const blink = 0.5 + 0.5 * Math.sin(performance.now() / 250);
  drawText(H, won ? 'C: KEEP FLYING   ·   ENTER: ANOTHER PATROL (SAME SYSTEM)   ·   N: NEW SYSTEM' : 'ENTER: ANOTHER PATROL (SAME SYSTEM)   ·   N: NEW SYSTEM', W / 2, Hh * 0.78, 12 * s, 1, 1, 1, 0.5 + 0.5 * blink, 'center');
  if (won) drawText(H, 'THE FALLEN STAR IS DARK. WHAT IS LEFT OF THE TIDE WILL WITHER WITHOUT IT.', W / 2, Hh * 0.7, 10 * s, C.green[0], C.green[1], C.green[2], 0.85, 'center');
  const inp = g.input;
  if (inp.wasPressed('Enter') || inp.wasPressed('NumpadEnter') || inp.wasPressed('GP0') || inp.wasPressed('GP9')) { g.restart(false); }
  if (inp.wasPressed('KeyN')) { g.restart(true); }
  if (won && inp.wasPressed('KeyC')) { g.continuePatrol(); }
}

export function drawPause(g: Game): void {
  const H = g.hudLines;
  const W = g.camera.viewportW, Hh = g.camera.viewportH;
  const s = g.dpr;
  dim(g, 0.5);
  drawText(H, 'PAUSED', W / 2, Hh * 0.42, 26 * s, C.amber[0], C.amber[1], C.amber[2], 0.95, 'center');
  drawText(H, 'ESC: RESUME   ·   H: MANUAL   ·   M: MAP   ·   J: JOURNAL   ·   X: ABANDON PATROL', W / 2, Hh * 0.42 + 40 * s, 11 * s, C.white[0], C.white[1], C.white[2], 0.8, 'center');
  const inp = g.input;
  if (inp.wasPressed('Escape') || inp.wasPressed('KeyP') || inp.wasPressed('GP9')) g.mode = 'flight';
  if (inp.wasPressed('KeyH')) { g.helpReturn = 'pause'; g.mode = 'help'; inp.consume('KeyH'); }
  if (inp.wasPressed('KeyM')) { g.mapReturn = 'pause'; g.mode = 'map'; inp.consume('KeyM'); }
  if (inp.wasPressed('KeyJ')) { g.journalReturn = 'pause'; g.mode = 'journal'; g.world.journalNew = 0; inp.consume('KeyJ'); }
  if (inp.wasPressed('KeyX')) { g.world.gameOver = true; g.mode = 'gameover'; }
}

/** The journal: observations in the pilot's words, newest first. It concludes nothing. */
export function drawJournal(g: Game): void {
  const H = g.hudLines;
  const W = g.camera.viewportW, Hh = g.camera.viewportH;
  const s = g.dpr;
  const w = g.world;
  dim(g, 0.75);
  drawText(H, 'JOURNAL', W / 2, 40 * s, 22 * s, C.amber[0], C.amber[1], C.amber[2], 0.95, 'center');
  const entries = w.journal.slice().reverse();
  let y = 90 * s;
  if (!entries.length) drawText(H, 'NOTHING WORTH WRITING DOWN YET.', W / 2, y, 11 * s, C.dim[0], C.dim[1], C.dim[2], 0.85, 'center');
  const x0 = Math.max(24 * s, W / 2 - 420 * s), x1 = x0 + 70 * s;
  const maxW = W - x1 - 24 * s;
  for (const e of entries) {
    if (y > Hh - 70 * s) { drawText(H, '...', x1, y, 10 * s, C.dim[0], C.dim[1], C.dim[2], 0.7); break; }
    const mins = Math.floor(e.time / 60), secs = Math.floor(e.time % 60);
    drawText(H, `${mins}:${String(secs).padStart(2, '0')}`, x0, y, 9 * s, C.cyan[0], C.cyan[1], C.cyan[2], 0.7);
    // wrap long lines by words
    const words = e.text.split(' ');
    let line = '';
    const lines: string[] = [];
    for (const wd of words) {
      const test = line ? line + ' ' + wd : wd;
      if (textWidth(test, 10 * s) > maxW && line) { lines.push(line); line = wd; } else line = test;
    }
    if (line) lines.push(line);
    for (const l of lines) { drawText(H, l, x1, y, 10 * s, C.white[0], C.white[1], C.white[2], 0.9); y += 14 * s; }
    y += 8 * s;
  }
  drawText(H, 'ESC OR J TO RETURN', W / 2, Hh - 40 * s, 11 * s, 1, 1, 1, 0.5 + 0.5 * Math.sin(performance.now() / 250), 'center');
  const inp = g.input;
  if (inp.wasPressed('Escape') || inp.wasPressed('KeyJ') || inp.wasPressed('Enter') || inp.wasPressed('GP1') || inp.wasPressed('GP9')) { g.mode = g.journalReturn; inp.consume('KeyJ'); inp.consume('Escape'); }
}

export function padLabel(p: Pad): string { return p.name; }
export function stationLabel(s: Station): string { return s.name; }
export type { V2 };
