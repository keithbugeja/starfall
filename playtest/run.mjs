// Playtest driver: loads the built game in headless Chromium, runs a named scenario, saves screenshots
// and prints state. Usage: node playtest/run.mjs <scenario> [--url http://localhost:4173]
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });
const args = process.argv.slice(2);
const scenario = args[0] ?? 'idle';
const urlIdx = args.indexOf('--url');
const url = urlIdx >= 0 ? args[urlIdx + 1] : 'http://localhost:4173/';

export async function launch() {
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__sf && window.__sf.game, null, { timeout: 20000 });
  await page.waitForTimeout(300);
  return { browser, page, errors };
}

export const api = {
  async shot(page, name, settleFrames = 45) { await api.settle(page, settleFrames); await page.screenshot({ path: path.join(outDir, name + '.png') }); },
  /** Render frames without stepping the sim (manual mode) so the camera and persistence settle. */
  async settle(page, frames) { await page.evaluate(n => new Promise(r => { let i = 0; const f = () => { if (++i >= n) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }), frames); },
  async state(page) { return page.evaluate(() => window.__sf.state()); },
  async step(page, n) { return page.evaluate(n => window.__sf.step(n), n); },
  async controls(page, c) { return page.evaluate(c => window.__sf.controls(c), c); },
  async press(page, code) { return page.evaluate(code => window.__sf.press(code), code); },
  async manual(page, on) { return page.evaluate(on => window.__sf.manual(on), on); },
  async newGame(page, seed) { return page.evaluate(seed => window.__sf.newGame(seed), seed); },
  async launch(page) { return page.evaluate(() => window.__sf.launch()); },
  async mode(page, m) { return page.evaluate(m => window.__sf.mode(m), m); },
  async nav(page, n) { return page.evaluate(n => window.__sf.nav(n), n); },
  /** Run n ticks with controls, rendering frames in between so screenshots reflect the state. */
  async run(page, c, seconds) {
    const ticks = Math.round(seconds * 120);
    await api.controls(page, c);
    const chunk = 24; // 0.2 s per chunk, render in between
    for (let t = 0; t < ticks; t += chunk) {
      await api.step(page, Math.min(chunk, ticks - t));
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r())));
    }
  },
};


/** Landing autopilot: runs inside the page. Returns a log. */
const LANDER_SRC = `
  const w = sf.game.world, p = w.player;
  const b = w.bodies.find(b => b.name === bodyName);
  const pad = b.pads.find(q => q.name === padName);
  const log = [];
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  for (let t = 0; t < ticks; t++) {
    if (!p.alive || p.landed) break;
    const rx = p.pos.x - b.pos.x, ry = p.pos.y - b.pos.y;
    const r = Math.hypot(rx, ry);
    const ux = rx / r, uy = ry / r;
    const ang = Math.atan2(ry, rx);
    const alt = r - pad.height;
    const angErr = wrap(pad.angle - ang);
    const arc = angErr * r;
    const rvx = p.vel.x - b.vel.x, rvy = p.vel.y - b.vel.y;
    const vr = rvx * ux + rvy * uy;
    const tx = -uy, ty = ux;
    const vt = rvx * tx + rvy * ty;
    const wantVt = Math.max(-14, Math.min(14, arc * 0.25));
    let wantVr;
    const cruiseAlt = 24;
    if (Math.abs(arc) > 10) wantVr = (cruiseAlt - alt) * 0.3;
    else wantVr = -Math.max(1.2, Math.min(9, alt * 0.14));
    wantVr = Math.max(-9, Math.min(8, wantVr));
    let gx = 0, gy = 0;
    for (const bb of w.bodies) {
      const dx = bb.pos.x - p.pos.x, dy = bb.pos.y - p.pos.y;
      const d = Math.hypot(dx, dy);
      if (d >= bb.soi) continue;
      let a = bb.mass / Math.max(d, bb.radius * 0.6) ** 2;
      const f = Math.max(0, Math.min(1, (bb.soi - d) / (bb.soi * 0.25)));
      a *= f * f * (3 - 2 * f);
      gx += dx / d * a; gy += dy / d * a;
    }
    const ex = (wantVr - vr), et = (wantVt - vt);
    let ax = (ux * ex + tx * et) * 1.6 - gx, ay = (uy * ex + ty * et) * 1.6 - gy;
    const am = Math.hypot(ax, ay);
    const wantHeading = am > 0.3 ? Math.atan2(ay, ax) : Math.atan2(uy, ux);
    const hErr = wrap(wantHeading - p.angle);
    const c = { turn: Math.max(-1, Math.min(1, hErr * 3.0)), thrust: 0, retro: 0, strafe: 0, fire: false, boost: false };
    if (Math.abs(hErr) < 0.35 && am > 0.3) c.thrust = Math.min(1, am / p.stats.thrust);
    if (alt < 6 && Math.abs(arc) < 4) { const up = wrap(Math.atan2(uy, ux) - p.angle); c.turn = Math.max(-1, Math.min(1, up * 3)); }
    sf.controls(c);
    sf.step(1);
    if (t % 120 === 0) log.push({ t: (t / 120).toFixed(1), alt: alt.toFixed(1), arc: arc.toFixed(1), vr: vr.toFixed(2), vt: vt.toFixed(2), hErr: hErr.toFixed(2), hull: p.hull.toFixed(0), fuel: p.fuel.toFixed(0) });
  }
  sf.controls(null);
  return { log, landed: p.landed ? { pad: p.landed.pad && p.landed.pad.name, body: p.landed.body.name } : null, hull: p.hull, alive: p.alive, crashSpeed: p.crashSpeed, fuel: p.fuel };
`;

async function autoLand(page, bodyName, padName, seconds) {
  return page.evaluate(([src, bodyName, padName, ticks]) => {
    const f = new Function('sf', 'bodyName', 'padName', 'ticks', src);
    return f(window.__sf, bodyName, padName, ticks);
  }, [LANDER_SRC, bodyName, padName, Math.round(seconds * 120)]);
}

const scenarios = {
  async smoke({ page }) {
    await api.manual(page, true);
    await api.shot(page, 'smoke_title');
    await api.launch(page);
    await api.shot(page, 'smoke_launch');
    let st = await api.state(page);
    console.log('after launch', st.mode, st.player, 'ships', st.ships.length, 'stations', st.stations.map(s => s.name));
    // fly around for 40 s with thrust bursts and turns
    const seq = [[{ thrust: 1 }, 3], [{ turn: 1 }, 0.6], [{ thrust: 1, boost: true }, 4], [{ turn: -1 }, 0.8], [{ thrust: 1 }, 3], [{}, 6], [{ fire: true }, 2], [{ turn: 1, thrust: 1 }, 4], [{}, 16]];
    let t = 0;
    for (const [c, sec] of seq) {
      await api.run(page, c, sec);
      t += sec;
      st = await api.state(page);
      console.log(`t=${t.toFixed(0)} pos=(${st.player.x.toFixed(0)},${st.player.y.toFixed(0)}) spd=${st.player.speed.toFixed(0)} hull=${st.player.hull.toFixed(0)} fuel=${st.player.fuel.toFixed(0)} alive=${st.player.alive} ships=${st.ships.length} ev=${st.events.length} ft=${st.frameTime.toFixed(1)}`);
    }
    await api.shot(page, 'smoke_flight');
    console.log('events', st.events);
    console.log('comms', st.comms);
    console.log('ships', st.ships.map(s => s.kind + ':' + s.mode).join(', '));
    // long run: 4 minutes of idling to let the director work
    for (let i = 0; i < 8; i++) {
      await api.run(page, {}, 30);
      st = await api.state(page);
      console.log(`idle t=${st.time.toFixed(0)} ships=${st.ships.length} events=${st.events.map(e => e.kind + (e.resolved ? '+' : e.failed ? '-' : '')).join(',')} threat=${st.threat.toFixed(1)} alive=${st.player.alive} lives=${st.lives} mode=${st.mode} ft=${st.frameTime.toFixed(1)}`);
    }
    console.log('comms', st.comms);
    await api.shot(page, 'smoke_end');
    await api.mode(page, 'map');
    await api.shot(page, 'smoke_map');
    await api.mode(page, 'help');
    await api.shot(page, 'smoke_help');
  },
  async land({ page }) {
    await api.manual(page, true);
    const st = await api.state(page);
    const pads = st.bodies.flatMap(b => b.pads.map(p => ({ body: b.name, pad: p.name })));
    for (const target of pads) {
      await api.newGame(page, 12345);
      await api.launch(page);
      const res = await autoLand(page, target.body, target.pad, 90);
      const st2 = await api.state(page);
      console.log(target.body, '/', target.pad, '=>', res.landed ? 'LANDED on ' + res.landed.pad : (res.alive ? 'NOT LANDED' : 'DEAD'), 'hull', res.hull.toFixed(0), 'fuel', res.fuel.toFixed(0), 'touch', res.crashSpeed.toFixed(2), 'lastDamage', st2.player.lastDamageSource);
      if (!res.landed) console.log(res.log.slice(-6));
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r())));
      await api.shot(page, 'land_' + target.pad.replace(/\s+/g, '_'));
    }
  },
  async idle({ page }) {
    await api.manual(page, true);
    await api.shot(page, 'idle_0');
    await api.run(page, { thrust: 0 }, 2);
    await api.shot(page, 'idle_2s');
    console.log(JSON.stringify(await api.state(page), null, 1).slice(0, 1500));
  },
  async fly({ page }) {
    await api.manual(page, true);
    const s0 = await api.state(page);
    console.log('start', s0.player);
    await api.run(page, { thrust: 1 }, 2);
    await api.shot(page, 'fly_thrust2s');
    const s1 = await api.state(page);
    console.log('after 2s thrust', s1.player);
    await api.run(page, { turn: 1 }, 0.5);
    await api.run(page, { thrust: 1, turn: 0 }, 2);
    await api.shot(page, 'fly_turned');
    const s2 = await api.state(page);
    console.log('after turn+thrust', s2.player);
    await api.run(page, { thrust: 1, boost: true }, 3);
    await api.shot(page, 'fly_boost');
    const s3 = await api.state(page);
    console.log('after boost', s3.player);
    await api.run(page, { fire: true }, 1);
    await api.shot(page, 'fly_fire');
    await api.run(page, {}, 3);
    await api.shot(page, 'fly_coast');
    console.log('coast', (await api.state(page)).player);
  },
  async fall({ page }) {
    // let gravity pull the ship into the planet with no input; observe crash handling
    await api.manual(page, true);
    for (let i = 0; i < 12; i++) {
      await api.run(page, {}, 2);
      const s = await api.state(page);
      console.log(`t=${s.time.toFixed(1)} pos=(${s.player.x.toFixed(0)},${s.player.y.toFixed(0)}) spd=${s.player.speed.toFixed(1)} hull=${s.player.hull.toFixed(0)} landed=${JSON.stringify(s.player.landed)} alive=${s.player.alive}`);
      if (i % 3 === 2) await api.shot(page, `fall_${i}`);
      if (!s.player.alive || s.player.landed) break;
    }
    await api.shot(page, 'fall_end');
  },
};


/** In-page docking autopilot: approach the station, wait for the gap, run in. */
const DOCK_SRC = `
  const w = sf.game.world, p = w.player;
  const st = w.stations.find(s => s.name === name);
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  const log = [];
  let phase = 'approach';
  for (let t = 0; t < ticks; t++) {
    if (!p.alive || p.docked) break;
    const dx = st.pos.x - p.pos.x, dy = st.pos.y - p.pos.y;
    const d = Math.hypot(dx, dy) || 1;
    const R = st.radius;
    let gx = 0, gy = 0;
    for (const bb of w.bodies) {
      const ex = bb.pos.x - p.pos.x, ey = bb.pos.y - p.pos.y;
      const dd = Math.hypot(ex, ey);
      if (dd >= bb.soi) continue;
      let a = bb.mass / Math.max(dd, bb.radius * 0.6) ** 2;
      const f = Math.max(0, Math.min(1, (bb.soi - dd) / (bb.soi * 0.25)));
      a *= f * f * (3 - 2 * f);
      gx += ex / dd * a; gy += ey / dd * a;
    }
    const local = wrap(Math.atan2(p.pos.y - st.pos.y, p.pos.x - st.pos.x) - st.angle);
    let wantVx, wantVy;
    if (phase === 'approach') {
      // hold point at 1.8R on our bearing
      const hx = st.pos.x - dx / d * R * 1.8, hy = st.pos.y - dy / d * R * 1.8;
      wantVx = st.vel.x + (hx - p.pos.x) * 0.5; wantVy = st.vel.y + (hy - p.pos.y) * 0.5;
      const sp = Math.hypot(wantVx, wantVy); if (sp > 30) { wantVx *= 30 / sp; wantVy *= 30 / sp; }
      const holdErr = Math.hypot(hx - p.pos.x, hy - p.pos.y);
      // the gap must be coming toward our bearing: station spins at st.spin, so lead it
      const lead = local - st.spin * 2.0;
      if (holdErr < 4 && Math.abs(lead) < st.bayHalfWidth * 0.35) phase = 'run';
    } else {
      wantVx = st.vel.x + dx / d * 6.8; wantVy = st.vel.y + dy / d * 6.8;
    }
    const ax = (wantVx - p.vel.x) * 1.6 - gx, ay = (wantVy - p.vel.y) * 1.6 - gy;
    const am = Math.hypot(ax, ay);
    const wantHeading = am > 0.3 ? Math.atan2(ay, ax) : Math.atan2(dy, dx);
    const hErr = wrap(wantHeading - p.angle);
    const c = { turn: Math.max(-1, Math.min(1, hErr * 3.0)), thrust: 0, retro: 0, strafe: 0, fire: false, boost: false };
    if (Math.abs(hErr) < 0.35 && am > 0.3) c.thrust = Math.min(1, am / p.stats.thrust);
    sf.controls(c);
    sf.step(1);
    if (t % 120 === 0) log.push({ t: (t / 120).toFixed(0), phase, d: d.toFixed(1), local: local.toFixed(2), rel: Math.hypot(p.vel.x - st.vel.x, p.vel.y - st.vel.y).toFixed(1), hull: p.hull.toFixed(0) });
  }
  sf.controls(null);
  return { log, docked: !!p.docked, hull: p.hull, alive: p.alive, time: w.time, dmg: p.lastDamageSource, dmgAt: p.lastDamageTime };
`;

async function autoDock(page, name, seconds) {
  return page.evaluate(([src, name, ticks]) => {
    const f = new Function('sf', 'name', 'ticks', src);
    return f(window.__sf, name, ticks);
  }, [DOCK_SRC, name, Math.round(seconds * 120)]);
}

/** In-page dogfight controller: face the nearest enemy's lead point and fire; thrust to keep range. */
const FIGHT_SRC = `
  const w = sf.game.world, p = w.player;
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  const log = [];
  let kills0 = w.kills;
  for (let t = 0; t < ticks; t++) {
    if (!p.alive) break;
    let best = null, bd = 1e9;
    for (const s of w.ships) { if (!s.alive || s.faction !== 'enemy' || s.kind === 'sentinel') continue; const d = Math.hypot(s.pos.x - p.pos.x, s.pos.y - p.pos.y); if (d < bd) { bd = d; best = s; } }
    const c = { turn: 0, thrust: 0, retro: 0, strafe: 0, fire: false, boost: false };
    if (best) {
      const dx = best.pos.x - p.pos.x, dy = best.pos.y - p.pos.y;
      const tt = bd / p.weapon.speed;
      const lx = dx + (best.vel.x - p.vel.x) * tt, ly = dy + (best.vel.y - p.vel.y) * tt;
      const aim = Math.atan2(ly, lx);
      const err = wrap(aim - p.angle);
      c.turn = Math.max(-1, Math.min(1, err * 4));
      c.fire = Math.abs(err) < 0.12 && bd < 120;
      const sp = Math.hypot(p.vel.x, p.vel.y);
      if (bd > 70 && Math.abs(err) < 0.3 && sp < 30) c.thrust = 1;
    }
    sf.controls(c);
    sf.step(1);
    if (t % 240 === 0) log.push({ t: (t / 120).toFixed(0), hull: p.hull.toFixed(0), enemies: w.ships.filter(s => s.alive && s.faction === 'enemy' && s.kind !== 'sentinel').length, kills: w.kills - kills0, modes: w.ships.filter(s => s.alive && s.faction === 'enemy' && s.kind !== 'sentinel').map(s => s.kind[0] + ':' + s.ai.mode).join(' ') });
  }
  sf.controls(null);
  return { log, hull: p.hull, alive: p.alive, kills: w.kills - kills0 };
`;

async function autoFight(page, seconds) {
  return page.evaluate(([src, ticks]) => {
    const f = new Function('sf', 'ticks', src);
    return f(window.__sf, ticks);
  }, [FIGHT_SRC, Math.round(seconds * 120)]);
}

const moreScenarios = {
  async gallery({ page }) {
    await api.manual(page, true);
    await api.newGame(page, 2024);
    await api.launch(page);
    let st = await api.state(page);
    const home = st.bodies.find(b => b.kind === 'planet');
    const gas = st.bodies.find(b => b.kind === 'gas');
    const hs = st.stations[0];
    // 1. harbour with the home planet in frame: hover above the harbour looking from the far side
    await page.evaluate(([x, y]) => window.__sf.teleport(x, y, 0, 0, 1.2), [hs.x + 30, hs.y - 20]);
    await api.run(page, { thrust: 1, boost: true }, 0.6);
    await api.shot(page, 'g1_harbour', 60);
    // 2. gas giant from a distance at speed (camera high)
    await page.evaluate(([x, y]) => window.__sf.teleport(x, y, 0, 100, 1.57), [gas.x + gas.r * 1.6, gas.y - gas.r * 2.2]);
    await api.run(page, { thrust: 1, boost: true }, 1.0);
    await api.shot(page, 'g2_gasgiant', 60);
    // 3. combat: spawn a pack and fight for 4 seconds
    await page.evaluate(([x, y]) => window.__sf.teleport(x, y, 0, 0, 0), [home.x + 700, home.y + 300]);
    for (let i = 0; i < 3; i++) await page.evaluate(([k, i]) => window.__sf.spawnEnemy(k, 90 + i * 15, 40 - i * 40, 'hunt'), [i === 2 ? 'lancer' : 'wasp', i]);
    await autoFight(page, 5);
    await api.shot(page, 'g3_combat', 20);
    // 4. the enemy core from above
    const core = st.pads.find(p => p.kind === 'core');
    const eb = st.bodies.find(b => b.name === core.body);
    await page.evaluate(([x, y, a]) => window.__sf.teleport(x, y, 0, 0, a), [eb.x + Math.cos(core.angle) * (core.height + 45), eb.y + Math.sin(core.angle) * (core.height + 45), core.angle]);
    await api.run(page, {}, 1.5);
    await api.shot(page, 'g4_enemycore', 60);
    // 5. the belt
    const mid = st.bodies.filter(b => b.kind === 'planet' && b.name !== 'THE FAULT')[2];
    const beltR = (mid.x ** 2 + mid.y ** 2) ** 0.5 * 1.25;
    await page.evaluate(([x, y]) => window.__sf.teleport(x, y, 0, 0, 0), [beltR, 0]);
    await api.run(page, {}, 0.5);
    await api.shot(page, 'g5_belt', 60);
    // 6. the map
    await api.mode(page, 'map');
    await api.shot(page, 'g6_map', 10);
    st = await api.state(page);
    console.log('gallery done', st.mode);
  },
  async tour({ page }) {
    // launch -> land at the nearest home colony -> refuel -> launch -> dock at the harbour
    await api.manual(page, true);
    await api.newGame(page, 2024);
    await api.launch(page);
    let st = await api.state(page);
    const home = st.bodies.find(b => b.kind === 'planet');
    const colony = home.pads.find(p => p.kind === 'colony');
    const t0 = st.time;
    const res = await autoLand(page, home.name, colony.name, 150);
    st = await api.state(page);
    console.log('LAND', res.landed ? 'OK' : (res.alive ? 'NOT LANDED' : 'DEAD'), 'hull', res.hull.toFixed(0), 'fuel', res.fuel.toFixed(0), 'took', (st.time - t0).toFixed(0), 's');
    if (!res.landed) console.log(res.log.slice(-6));
    await api.shot(page, 'tour_landed');
    await api.run(page, {}, 8);
    st = await api.state(page);
    console.log('after refuel: fuel', st.player.fuel.toFixed(0), 'hull', st.player.hull.toFixed(0), 'score', st.score);
    await api.run(page, { thrust: 1 }, 3);
    st = await api.state(page);
    console.log('relaunched: alt speed', st.player.speed.toFixed(1), 'landed', st.player.landed);
    const t1 = st.time;
    const dock = await autoDock(page, st.stations[0].name, 200);
    st = await api.state(page);
    console.log('DOCK', dock.docked ? 'OK' : (dock.alive ? 'NOT DOCKED' : 'DEAD'), 'hull', dock.hull.toFixed(0), 'took', (st.time - t1).toFixed(0), 's', 'mode', st.mode);
    if (!dock.docked) console.log(dock.log.slice(-6));
    await api.shot(page, 'tour_docked');
  },
  async upgrades({ page }) {
    await api.manual(page, true);
    await api.newGame(page, 55);
    await api.launch(page);
    await page.evaluate(() => window.__sf.buyAll());
    for (const wk of ['pulse', 'scatter', 'rail', 'mass']) {
      await page.evaluate(k => window.__sf.weapon(k), wk);
      await api.run(page, { fire: true, turn: 0.3 }, 1.5);
      await api.run(page, { thrust: 1, strafe: 1, retro: 0 }, 1);
      await api.run(page, { retro: 1 }, 1);
      const st = await api.state(page);
      console.log(wk, 'proj', st.projectiles, 'heat', st.player.heat.toFixed(2), 'fuel', st.player.fuel.toFixed(0), 'hull', st.player.hull.toFixed(0), 'alive', st.player.alive);
    }
    await api.shot(page, 'upgrades');
  },
  async audio({ page }) {
    await api.manual(page, true);
    await page.evaluate(() => window.__sf.unlockAudio());
    await api.launch(page);
    await api.run(page, { thrust: 1, fire: true }, 2);
    await page.evaluate(() => window.__sf.forceEvent('flare'));
    await api.run(page, { thrust: 1, boost: true }, 2);
    const st = await api.state(page);
    console.log('audio run ok, alive', st.player.alive);
  },
  async perf({ page }) {
    await api.manual(page, true);
    await api.launch(page);
    const ms = await page.evaluate(() => { const t = performance.now(); window.__sf.step(1200); return performance.now() - t; });
    const st = await api.state(page);
    console.log('1200 sim steps (10 s) took', ms.toFixed(0), 'ms =>', (ms / 1200).toFixed(3), 'ms/step; ships', st.ships.length, 'asteroids', st.asteroids);
    // render cost
    const rt = await page.evaluate(() => new Promise(r => { let n = 0; const t = performance.now(); const f = () => { if (++n >= 30) r((performance.now() - t) / 30); else requestAnimationFrame(f); }; requestAnimationFrame(f); }));
    console.log('avg frame (swiftshader)', rt.toFixed(1), 'ms');
  },
  async dock({ page }) {
    await api.manual(page, true);
    let ok = 0, n = 0;
    for (const seed of [12345, 777, 4242]) {
      await api.newGame(page, seed);
      await api.launch(page);
      // start 90 units from the harbour on the side away from its planet
      let st = await api.state(page);
      const hs = st.stations[0];
      const home = st.bodies.find(b => b.kind === 'planet');
      const ax = hs.x - home.x, ay = hs.y - home.y, al = Math.hypot(ax, ay);
      await page.evaluate(([x, y]) => window.__sf.teleport(x, y, 0, 0, 0), [hs.x + ax / al * 90, hs.y + ay / al * 90]);
      st = await api.state(page);
      const harbour = st.stations[0].name;
      const res = await autoDock(page, harbour, 120);
      n++; if (res.docked) ok++;
      console.log(seed, harbour, '=>', res.docked ? 'DOCKED' : (res.alive ? 'NOT DOCKED' : 'DEAD'), 'hull', res.hull.toFixed(0), 'time', res.time.toFixed(0), 'dmg', res.dmg, 'at', res.dmgAt.toFixed(1));
      if (!res.docked || res.hull < 100) console.log(res.log.slice(-10));
      await api.shot(page, 'dock_' + seed);
    }
    console.log('DOCK SUCCESS', ok, '/', n);
  },
  async combat({ page }) {
    await api.manual(page, true);
    for (const wave of [['wasp', 'wasp'], ['lancer'], ['wasp', 'wasp', 'lancer'], ['reaver']]) {
      await api.newGame(page, 999);
      await api.launch(page);
      // put the player in open space away from the harbour and the star
      const st = await api.state(page);
      const home = st.bodies.find(b => b.kind === 'planet');
      await page.evaluate(([x, y]) => window.__sf.teleport(x, y, 0, 0, 0), [home.x + 900, home.y + 200]);
      for (let i = 0; i < wave.length; i++) await page.evaluate(([k, i]) => window.__sf.spawnEnemy(k, 120 + i * 20, 60 - i * 40, 'hunt'), [wave[i], i]);
      const res = await autoFight(page, 60);
      console.log('WAVE', wave.join('+'), '=>', res.alive ? 'ALIVE' : 'DEAD', 'hull', res.hull.toFixed(0), 'kills', res.kills);
      console.log(res.log);
      await api.shot(page, 'combat_' + wave.join('_'));
    }
  },
  async raid({ page }) {
    await api.manual(page, true);
    await api.newGame(page, 31337);
    await api.launch(page);
    await page.evaluate(() => window.__sf.forceEvent('raid'));
    for (let i = 0; i < 14; i++) {
      await api.run(page, {}, 5);
      const st = await api.state(page);
      const ev = st.events[0];
      const reavers = st.ships.filter(s => s.kind === 'reaver');
      const pad = st.pads.find(p => ev.label.includes(p.name));
      const pb = pad ? st.bodies.find(b => b.name === pad.body) : null;
      const rv = reavers[0];
      const dist = rv && pb ? Math.hypot(rv.x - (pb.x + Math.cos(pad.angle) * (pad.height + 9)), rv.y - (pb.y + Math.sin(pad.angle) * (pad.height + 9))).toFixed(1) : '-';
      console.log(`t=${st.time.toFixed(0)} ${ev.label} timer=${ev.timer.toFixed(0)} res=${ev.resolved} fail=${ev.failed} reavers=${reavers.map(r => r.mode + '/' + r.wave.toFixed(1) + (r.carrying ? '/POD' : '')).join(',')} dHover~${dist} spd=${rv ? Math.hypot(rv.vx, rv.vy).toFixed(1) : '-'} pods=${st.pickups.filter(p => p.kind === 'pod').length} pop=${st.pads.filter(p => p.kind === 'colony').map(p => p.pop).join('/')}`);
      if (ev.resolved || ev.failed) break;
    }
    const st = await api.state(page);
    console.log(st.comms);
  },
  async approach({ page }) {
    // fly to the home planet's surface and take screenshots at several altitudes
    await api.manual(page, true);
    await api.newGame(page, 12345);
    await api.launch(page);
    const st = await api.state(page);
    const home = st.bodies.find(b => b.kind === 'planet');
    const pad = home.pads[0];
    const ang = pad.angle;
    const alts = [140, 60, 25, 8];
    for (const alt of alts) {
      const r = home.r + alt;
      await page.evaluate(([x, y, a]) => window.__sf.teleport(x, y, 0, 0, a), [home.x + Math.cos(ang) * r, home.y + Math.sin(ang) * r, ang]);
      await api.run(page, { thrust: 0 }, 0.5);
      await api.shot(page, 'approach_' + alt, 90);
    }
    // gas giant and the star from a distance
    const gas = st.bodies.find(b => b.kind === 'gas');
    await page.evaluate(([x, y]) => window.__sf.teleport(x, y, 0, 0, 0), [gas.x + gas.r + 60, gas.y]);
    await api.run(page, {}, 0.5);
    await api.shot(page, 'approach_gas', 90);
    await page.evaluate(([x, y]) => window.__sf.teleport(x, y, 0, 0, 0), [st.bodies[0].r + 300, 0]);
    await api.run(page, {}, 0.5);
    await api.shot(page, 'approach_star', 90);
  },
};
Object.assign(scenarios, moreScenarios);

const { browser, page, errors } = await launch();
try {
  const fn = scenarios[scenario];
  if (!fn) { console.error('unknown scenario', scenario, 'available:', Object.keys(scenarios)); process.exit(1); }
  await fn({ page });
} finally {
  if (errors.length) console.log('CONSOLE ERRORS/WARNINGS:\n' + errors.slice(0, 20).join('\n'));
  await browser.close();
}
