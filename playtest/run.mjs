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
    const padAng = pad.angle + (b.rotates ? b.spinAngle : 0);
    const angErr = wrap(padAng - ang);
    const arc = angErr * r;
    const om = b.free ? b.angVel : 0;
    const svx = b.vel.x - om * ry, svy = b.vel.y + om * rx;
    const rvx = p.vel.x - svx, rvy = p.vel.y - svy;
    const vr = rvx * ux + rvy * uy;
    const tx = -uy, ty = ux;
    const vt = rvx * tx + rvy * ty;
    const wantVt = Math.max(-14, Math.min(14, arc * 0.25));
    let wantVr;
    const cruiseAlt = 24;
    if (Math.abs(arc) > 10) wantVr = (cruiseAlt - alt) * 0.3;
    else wantVr = -Math.max(1.2, Math.min(9, alt * 0.14));
    wantVr = Math.max(-9, Math.min(8, wantVr));
    const zeroG = b.mass <= 0;
    if (zeroG && Math.abs(arc) < 4 && alt < 9) {
      // no gravity to fall with: coast the last stretch nose-up at the closing rate we already have
      const up = wrap(Math.atan2(uy, ux) - p.angle);
      // lateral jets hold the pad under us on a turning hull; retro keeps a closing rate
      const lateral = p.stats.strafe > 0 ? Math.max(-1, Math.min(1, -(wantVt - vt) * 0.8)) : 0;
      sf.controls({ turn: Math.max(-1, Math.min(1, up * 3)), thrust: 0, retro: (p.stats.retro > 0 && vr > -0.8) ? 0.6 : 0, strafe: lateral, fire: false, boost: false });
      sf.step(1);
      if (t % 120 === 0) log.push({ t: (t / 120).toFixed(1), alt: alt.toFixed(1), arc: arc.toFixed(1), vr: vr.toFixed(2), vt: vt.toFixed(2), hErr: up.toFixed(2), hull: p.hull.toFixed(0), fuel: p.fuel.toFixed(0) });
      continue;
    }
    if (zeroG && Math.abs(arc) < 4) wantVr = -1.6;
    const [gx, gy] = sf.gravity(p.pos.x, p.pos.y);
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
    await api.launch(page);
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
    await api.run(page, { thrust: 1 }, 1);
    console.log('thrust 1s after boost (must not brake):', (await api.state(page)).player.speed.toFixed(1));
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
    const [gx, gy] = sf.gravity(p.pos.x, p.pos.y);
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
  async events2({ page }) {
    await api.manual(page, true);
    // --- construction: a base gets built if nobody stops it
    await api.newGame(page, 77);
    await api.launch(page);
    const pads0 = (await api.state(page)).pads.length;
    await page.evaluate(() => window.__sf.forceEvent('construction'));
    for (let i = 0; i < 12; i++) {
      await api.run(page, {}, 15);
      const st = await api.state(page);
      const ev = st.events.find(e => e.kind === 'construction');
      if (ev && (ev.resolved || ev.failed)) { console.log('construction ended at', st.time.toFixed(0), ev.label, 'resolved', ev.resolved, 'failed', ev.failed); break; }
    }
    let st = await api.state(page);
    console.log('pads', pads0, '->', st.pads.length, 'new bases', st.pads.filter(p => p.kind === 'enemybase').map(p => p.name + '@' + p.body).join(', '));
    await api.shot(page, 'events2_construction', 20);
    // --- stranded: refuel by gentle contact
    await api.newGame(page, 78);
    await api.launch(page);
    await page.evaluate(() => window.__sf.forceEvent('stranded'));
    st = await api.state(page);
    const sh = st.ships.find(s => s.kind === 'shuttle');
    await page.evaluate(([x, y, vx, vy]) => window.__sf.teleport(x + 2.2, y, vx, vy, 0), [sh.x, sh.y, sh.vx, sh.vy]);
    await api.run(page, {}, 3);
    st = await api.state(page);
    const ev = st.events.find(e => e.kind === 'stranded');
    console.log('stranded:', ev && ev.resolved ? 'RESOLVED' : 'not resolved', 'player fuel', st.player.fuel.toFixed(0), 'shuttle mode', st.ships.find(s => s.kind === 'shuttle')?.mode);
    // --- seekers home in
    await api.newGame(page, 79);
    await api.launch(page);
    await page.evaluate(() => window.__sf.seekers());
    await page.evaluate(() => window.__sf.spawnEnemy('lancer', 120, 30, 'hunt'));
    await page.evaluate(() => window.__sf.fireSecondaryNow());
    await api.run(page, {}, 0.1);
    await page.evaluate(() => window.__sf.fireSecondaryNow());
    await api.run(page, {}, 0.1);
    st = await api.state(page);
    console.log('seekers fired: projectiles', st.projectiles);
    await api.run(page, {}, 4);
    st = await api.state(page);
    console.log('after 4s: enemy', st.ships.filter(s => s.faction === 'enemy' && s.kind === 'lancer').map(s => 'hull ' + s.hull.toFixed(0)).join(','), 'kills', st.kills);
    // --- flare: damage in sunlight, none when landed
    await api.newGame(page, 80);
    await api.launch(page);
    await page.evaluate(() => window.__sf.forceEvent('flare'));
    await api.run(page, {}, 30);
    st = await api.state(page);
    const h0 = st.player.hull;
    await api.run(page, {}, 6);
    st = await api.state(page);
    console.log('flare exposed: hull', h0.toFixed(0), '->', st.player.hull.toFixed(0), 'active', st.events.find(e => e.kind === 'flare')?.label);
    await api.shot(page, 'events2_flare', 10);
  },
  async keys({ page }) {
    // the real input path: keyboard and mouse events through the browser
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    let st = await api.state(page);
    console.log('after Enter:', st.mode);
    await page.keyboard.press('KeyL');
    await page.waitForTimeout(400);
    st = await api.state(page);
    console.log('after L:', st.mode, 'speed', st.player.speed.toFixed(1));
    const s0 = st.player.speed;
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1500);
    await page.keyboard.up('KeyW');
    st = await api.state(page);
    console.log('after W 1.5s: speed', st.player.speed.toFixed(1), '(was', s0.toFixed(1) + ')', 'fuel', st.player.fuel.toFixed(1));
    await page.keyboard.down('KeyA');
    await page.waitForTimeout(500);
    await page.keyboard.up('KeyA');
    const a1 = (await api.state(page)).player.angle;
    console.log('after A 0.5s: angle changed', Math.abs(a1 - st.player.angle).toFixed(2));
    await page.mouse.move(900, 200);
    await page.mouse.down();
    await page.waitForTimeout(400);
    await page.mouse.up();
    st = await api.state(page);
    console.log('after mouse click: projectiles', st.projectiles, 'heat', st.player.heat.toFixed(2));
    await page.keyboard.press('KeyM');
    await page.waitForTimeout(200);
    console.log('after M:', (await api.state(page)).mode);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    console.log('after Esc:', (await api.state(page)).mode);
    await page.keyboard.press('KeyH');
    await page.waitForTimeout(200);
    console.log('after H:', (await api.state(page)).mode);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    console.log('after Esc (pause):', (await api.state(page)).mode);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    console.log('after Esc (resume):', (await api.state(page)).mode);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);
    console.log('after Tab: nav', (await api.state(page)).nav);
    await api.shot(page, 'keys_flight', 5);
  },
  async launches({ page }) {
    await api.manual(page, true);
    let deaths = 0, n = 0;
    for (let i = 0; i < 20; i++) {
      await api.newGame(page, 1000 + i * 37);
      await api.launch(page);
      await api.run(page, {}, 10);
      const st = await api.state(page);
      n++;
      if (!st.player.alive || st.player.hull < 100) { deaths++; console.log('seed', 1000 + i * 37, 'hull', st.player.hull.toFixed(0), st.player.lastDamageSource); }
    }
    console.log('LAUNCH HARM', deaths, '/', n);
  },
  async assault({ page }) {
    await api.manual(page, true);
    for (const fit of ['stock', 'armoured']) {
      await api.newGame(page, 4321);
      await api.launch(page);
      if (fit === 'armoured') { await page.evaluate(() => window.__sf.buyAll()); await page.evaluate(() => window.__sf.weapon('mass')); }
      const st = await api.state(page);
      const base = st.pads.find(p => p.kind === 'enemybase');
      const b = st.bodies.find(x => x.name === base.body);
      await page.evaluate(([x, y, a]) => window.__sf.teleport(x, y, 0, 0, a + Math.PI), [b.x + Math.cos(base.angle) * (base.height + 55), b.y + Math.sin(base.angle) * (base.height + 55), base.angle]);
      const res = await page.evaluate(([ticks]) => {
        const sf = window.__sf, w = sf.game.world, p = w.player;
        const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
        const pad = w.pads.find(q => q.kind === 'enemybase');
        const b = pad.body;
        const hp0 = pad.enemyHealth;
        for (let t = 0; t < ticks; t++) {
          if (!p.alive || !pad.alive) break;
          // hover at altitude ~40 over the base, nose toward it, and shoot at sentinels or the pad
          const rx = p.pos.x - b.pos.x, ry = p.pos.y - b.pos.y, r = Math.hypot(rx, ry);
          const ux = rx / r, uy = ry / r;
          let gx = 0, gy = 0;
          for (const bb of w.bodies) { const ex = bb.pos.x - p.pos.x, ey = bb.pos.y - p.pos.y; const dd = Math.hypot(ex, ey); if (dd >= bb.soi) continue; let a = bb.mass / Math.max(dd, bb.radius * 0.6) ** 2; const f = Math.max(0, Math.min(1, (bb.soi - dd) / (bb.soi * 0.25))); a *= f * f * (3 - 2 * f); gx += ex / dd * a; gy += ey / dd * a; }
          const wantAlt = pad.height + 40;
          const wantVr = (wantAlt - r) * 0.3;
          const vr = (p.vel.x - b.vel.x) * ux + (p.vel.y - b.vel.y) * uy;
          const ax = (ux * (wantVr - vr)) * 1.5 - gx, ay = (uy * (wantVr - vr)) * 1.5 - gy;
          const am = Math.hypot(ax, ay);
          // target: nearest live sentinel, else the pad centre
          let tx = b.pos.x + Math.cos(pad.angle) * pad.height, ty = b.pos.y + Math.sin(pad.angle) * pad.height;
          const sent = w.ships.filter(s => s.alive && s.kind === 'sentinel');
          if (sent.length) { tx = sent[0].pos.x; ty = sent[0].pos.y; }
          const aim = Math.atan2(ty - p.pos.y, tx - p.pos.x);
          // thrust briefly when we need to hold altitude, otherwise aim and fire
          const needThrust = am > 4;
          const heading = needThrust ? Math.atan2(ay, ax) : aim;
          const err = wrap(heading - p.angle);
          const c = { turn: Math.max(-1, Math.min(1, err * 4)), thrust: needThrust && Math.abs(err) < 0.4 ? Math.min(1, am / p.stats.thrust) : 0, retro: 0, strafe: 0, fire: !needThrust && Math.abs(err) < 0.15, boost: false };
          sf.controls(c);
          sf.step(1);
        }
        sf.controls(null);
        return { alive: p.alive, hull: p.hull, baseAlive: pad.alive, baseHp: pad.enemyHealth, hp0, sentinels: w.ships.filter(s => s.alive && s.kind === 'sentinel').length, time: w.time };
      }, [120 * 90]);
      console.log(fit, '=>', res.alive ? 'ALIVE' : 'DEAD', 'hull', res.hull.toFixed(0), 'base', res.baseAlive ? 'STANDS ' + res.baseHp.toFixed(0) + '/' + res.hp0 : 'DESTROYED', 'sentinels left', res.sentinels, 'time', res.time.toFixed(0));
      await api.shot(page, 'assault_' + fit, 20);
    }
  },
  async endings({ page }) {
    await api.manual(page, true);
    await api.newGame(page, 8);
    await api.launch(page);
    await page.evaluate(() => window.__sf.setLives(1));
    await page.evaluate(() => window.__sf.kill());
    await api.run(page, {}, 5);
    await api.shot(page, 'end_gameover', 30);
    let st = await api.state(page);
    console.log('after death mode', st.mode, 'lives', st.lives);
    await api.newGame(page, 8);
    await api.launch(page);
    await page.evaluate(() => window.__sf.winNow());
    await api.run(page, {}, 11);
    st = await api.state(page);
    console.log('after win mode', st.mode, 'score', st.score);
    await api.shot(page, 'end_victory', 30);
  },
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


/** In-page waypoint follower for tight spaces: gravity-compensated velocity control at low speed. */
const FOLLOW_SRC = `
  const w = sf.game.world, p = w.player;
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  const body = bodyName ? w.bodies.find(b => b.name === bodyName) : null;
  const toWorld = (l) => { if (!body) return l; const c = Math.cos(body.rotates ? body.spinAngle : 0), s = Math.sin(body.rotates ? body.spinAngle : 0); return { x: body.pos.x + l.x * c - l.y * s, y: body.pos.y + l.x * s + l.y * c }; };
  const log = [];
  let idx = 0, t = 0, stuck = 0;
  const grav = () => sf.gravity(p.pos.x, p.pos.y);
  while (idx < pts.length && t < ticks && p.alive) {
    const wp = toWorld(pts[idx]);
    const refVel = body ? { x: body.vel.x, y: body.vel.y } : refVel0;
    const dx = wp.x - p.pos.x, dy = wp.y - p.pos.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    if (d < tol) { idx++; stuck = 0; continue; }
    const [gx, gy] = grav();
    const sp = Math.min(maxSpeed, Math.max(1.2, d * 0.5));
    // reference frame: the body the waypoints belong to (its velocity)
    const wantVx = refVel.x + dx / d * sp, wantVy = refVel.y + dy / d * sp;
    const ax = (wantVx - p.vel.x) * gain - gx, ay = (wantVy - p.vel.y) * gain - gy;
    const am = Math.hypot(ax, ay);
    const c = { turn: 0, thrust: 0, retro: 0, strafe: 0, fire: false, boost: false };
    if (am > 0.3) {
      const heading = Math.atan2(ay, ax);
      const err = wrap(heading - p.angle);
      c.turn = Math.max(-1, Math.min(1, err * 4));
      // lateral jets and retro if fitted let us keep the nose up
      const fx = Math.cos(p.angle), fy = Math.sin(p.angle);
      const fwd = ax * fx + ay * fy, lat = ax * fy - ay * fx;
      if (p.stats.strafe > 0) c.strafe = Math.max(-1, Math.min(1, lat / p.stats.strafe));
      if (p.stats.retro > 0 && fwd < 0) c.retro = Math.min(1, -fwd / p.stats.retro);
      // a load on the cable needs proportionally more thrust
      const loadK = p.tether && p.tether.tension > 0 ? 1 + (p.tether.pickup ? p.tether.pickup.mass : p.tether.asteroid ? p.tether.asteroid.radius * p.tether.asteroid.radius * 2 : 0) / (p.massMul * p.radius * p.radius) : 1;
      if (Math.abs(err) < 0.45 && fwd > 0) c.thrust = Math.min(1, fwd * loadK / p.stats.thrust);
    }
    sf.controls(c);
    sf.step(1);
    t++;
    if (t % 120 === 0) log.push({ t: (t / 120).toFixed(0), wp: idx, d: d.toFixed(1), hull: p.hull.toFixed(0), fuel: p.fuel.toFixed(0), spd: Math.hypot(p.vel.x - refVel.x, p.vel.y - refVel.y).toFixed(1), tension: p.tether ? p.tether.tension.toFixed(0) : '-' });
    if (++stuck > 120 * 25) { log.push({ stuck: idx }); break; }
  }
  sf.controls(null);
  return { log, reached: idx, of: pts.length, alive: p.alive, hull: p.hull, fuel: p.fuel, ticks: t, tethered: !!p.tether, peak: p.tether ? p.tether.peak : null };
`;

async function follow(page, pts, opts = {}) {
  const { seconds = 120, tol = 2.2, maxSpeed = 4.5, gain = 2.2, refVel = { x: 0, y: 0 }, body = null } = opts;
  return page.evaluate(([src, pts, ticks, tol, maxSpeed, gain, refVel0, bodyName]) => {
    const f = new Function('sf', 'pts', 'ticks', 'tol', 'maxSpeed', 'gain', 'refVel0', 'bodyName', src);
    return f(window.__sf, pts, ticks, tol, maxSpeed, gain, refVel0, bodyName);
  }, [FOLLOW_SRC, pts, Math.round(seconds * 120), tol, maxSpeed, gain, refVel, body]);
}

/** Hold a heading and thrust for a while (for pull tests). */
async function pull(page, heading, seconds, thrust = 1) {
  return page.evaluate(([heading, ticks, thrust]) => {
    const sf = window.__sf, w = sf.game.world, p = w.player;
    const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
    let peak = 0, snapped = false;
    for (let t = 0; t < ticks; t++) {
      const err = wrap(heading - p.angle);
      sf.controls({ turn: Math.max(-1, Math.min(1, err * 4)), thrust: Math.abs(err) < 0.3 ? thrust : 0, retro: 0, strafe: 0, fire: false, boost: false });
      sf.step(1);
      if (p.tether) peak = Math.max(peak, p.tether.tension); else if (peak > 0) snapped = true;
    }
    sf.controls(null);
    return { peak, snapped, tethered: !!p.tether };
  }, [heading, Math.round(seconds * 120), thrust]);
}

async function untether(page) { return page.evaluate(() => { const sf = window.__sf, p = sf.game.world.player; if (p.tether) sf.tether(); }); }
async function probe(page, ticks) { return page.evaluate(([ticks]) => { const sf = window.__sf, p = sf.game.world.player; const out = []; for (let i = 0; i < ticks; i++) { sf.step(1); out.push(p.tether ? p.tether.tension.toFixed(0) : 'x'); } return out.join(' '); }, [ticks]); }

const sliceScenarios = {
  async tetherphys({ page }) {
    await api.manual(page, true);
    await api.newGame(page, 2024);
    await api.launch(page);
    let st = await api.state(page);
    const home = st.bodies.find(b => b.kind === 'planet');
    // ---- 1. tow a crate, then release it
    await page.evaluate(([x, y]) => window.__sf.teleport(x, y, 0, 0, 0), [home.x + 650, home.y]);
    await untether(page);
    await page.evaluate(() => window.__sf.spawnCrate(-7, 0, 'wreck'));
    const ok = await page.evaluate(() => window.__sf.tether());
    let sl = await page.evaluate(() => window.__sf.slice());
    console.log('1. latch crate:', ok, sl.tether);
    await page.evaluate(() => window.__sf.controls({ thrust: 1 }));
    console.log('   tension per tick:', await probe(page, 40));
    await page.evaluate(() => window.__sf.controls(null));
    let r = await pull(page, 0, 3);
    sl = await page.evaluate(() => window.__sf.slice());
    console.log('   tether object peak', sl.tether && sl.tether.peak);
    st = await api.state(page);
    let crate = st.pickups.find(k => k.kind === 'wreck' && !k.name);
    console.log('   after 3 s thrust: ship spd', st.player.speed.toFixed(1), 'crate spd', Math.hypot(crate.vx, crate.vy).toFixed(1), 'peak', r.peak.toFixed(0), 'snapped', r.snapped);
    await page.evaluate(() => window.__sf.tether());
    await api.run(page, {}, 2);
    st = await api.state(page);
    crate = st.pickups.find(k => k.kind === 'wreck' && !k.name);
    console.log('   released: crate keeps spd', Math.hypot(crate.vx, crate.vy).toFixed(1), 'tethered', crate.tethered);
    await api.shot(page, 'tether_crate', 10);
    // ---- 2. yank: boost away from a slack crate
    await page.evaluate(([x, y]) => window.__sf.teleport(x, y, 0, 0, 0), [home.x + 650, home.y + 60]);
    await untether(page);
    await page.evaluate(() => window.__sf.spawnCrate(5, 0, 'wreck'));
    await page.evaluate(() => window.__sf.tether());
    r = await page.evaluate(() => { const sf = window.__sf, p = sf.game.world.player; sf.setVel(-16, 0); let peak = 0; for (let t = 0; t < 240; t++) { sf.step(1); if (p.tether) peak = Math.max(peak, p.tether.tension); } return { peak, tethered: !!p.tether }; });
    console.log('2. yank at 16 u/s: peak', r.peak.toFixed(0), 'still tethered', r.tethered);
    await page.evaluate(([x, y]) => window.__sf.teleport(x, y, 0, 0, 0), [home.x + 650, home.y + 120]);
    await untether(page);
    await page.evaluate(() => window.__sf.spawnCrate(5, 0, 'wreck'));
    await page.evaluate(() => window.__sf.tether());
    r = await page.evaluate(() => { const sf = window.__sf, p = sf.game.world.player; sf.setVel(-6, 0); let peak = 0; for (let t = 0; t < 240; t++) { sf.step(1); if (p.tether) peak = Math.max(peak, p.tether.tension); } return { peak, tethered: !!p.tether }; });
    console.log('   yank at 6 u/s: peak', r.peak.toFixed(0), 'still tethered', r.tethered);
    // ---- 3. pendulum in gravity: hover above the colony with a crate hanging
    const pad = home.pads.find(q => q.kind === 'colony');
    const hx = home.x + Math.cos(pad.angle) * (home.r + 30), hy = home.y + Math.sin(pad.angle) * (home.r + 30);
    await page.evaluate(([x, y, a]) => window.__sf.teleport(x, y, 0, 0, a), [hx, hy, pad.angle]);
    await untether(page);
    await page.evaluate(([dx, dy]) => window.__sf.spawnCrate(dx, dy, 'wreck'), [-Math.cos(pad.angle) * 5 + Math.sin(pad.angle) * 4, -Math.sin(pad.angle) * 5 - Math.cos(pad.angle) * 4]);
    console.log('3. latch', await page.evaluate(() => window.__sf.tether()));
    const swing = await page.evaluate(([ux, uy]) => {
      const sf = window.__sf, w = sf.game.world, p = w.player;
      const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
      const angles = [];
      for (let t = 0; t < 120 * 12; t++) {
        // hover: cancel gravity and hold velocity zero relative to the planet
        const b = w.bodies.find(x => x.kind === 'planet');
        const [gx, gy] = sf.gravity(p.pos.x, p.pos.y);
        const ax = (b.vel.x - p.vel.x) * 2 - gx, ay = (b.vel.y - p.vel.y) * 2 - gy;
        const heading = Math.atan2(ay, ax), err = wrap(heading - p.angle);
        sf.controls({ turn: Math.max(-1, Math.min(1, err * 4)), thrust: Math.abs(err) < 0.4 ? Math.min(1, Math.hypot(ax, ay) / p.stats.thrust) : 0, retro: 0, strafe: 0, fire: false, boost: false });
        sf.step(1);
        if (t % 30 === 0 && p.tether && p.tether.pickup) { const k = p.tether.pickup; const dx = k.pos.x - p.pos.x, dy = k.pos.y - p.pos.y; angles.push(((Math.atan2(dy, dx) - Math.atan2(-uy, -ux)) * 57.3).toFixed(0)); }
      }
      sf.controls(null);
      return { angles, tension: p.tether ? p.tether.tension.toFixed(1) : null, alive: p.alive };
    }, [Math.cos(pad.angle), Math.sin(pad.angle)]);
    console.log('3. pendulum angles from straight-down (deg, every 0.25 s):', swing.angles.join(' '), '| tension', swing.tension);
    await api.shot(page, 'tether_pendulum', 10);
    // ---- 4. tow a rock
    await page.evaluate(([x, y]) => window.__sf.teleport(x, y, 0, 0, 0), [home.x + 650, home.y + 180]);
    await untether(page);
    await page.evaluate(() => window.__sf.spawnRock(-8, 0, 2));
    const okR = await page.evaluate(() => window.__sf.tether());
    sl = await page.evaluate(() => window.__sf.slice());
    console.log('   rock latch', okR, JSON.stringify(sl.tether));
    r = await pull(page, 0, 6);
    st = await api.state(page);
    console.log('4. rock tow:', sl.tether && sl.tether.kind, 'ship spd after 6 s', st.player.speed.toFixed(1), 'peak', r.peak.toFixed(0), 'snapped', r.snapped);
    // ---- 5. slow a station's spin by pulling on the ring
    const hs = st.stations[0];
    await page.evaluate(([x, y, vx, vy, a]) => window.__sf.teleport(x, y, vx, vy, a), [hs.x + (hs.r + 2.4), hs.y, hs.vx, hs.vy, 0]);
    const spin0 = hs.spin;
    await untether(page);
    const okS = await page.evaluate(() => window.__sf.tether());
    sl = await page.evaluate(() => window.__sf.slice());
    // pull against the spin: for positive spin the ring point moves +y at our position (x = +R), so pull toward -y
    const tor = await page.evaluate(([dir, ticks]) => {
      const sf = window.__sf, w = sf.game.world, p = w.player, st = w.stations[0];
      const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
      let peak = 0; const log = [];
      for (let t = 0; t < ticks; t++) {
        // heading: tangential, against the ring's motion at our current position
        const rx = p.pos.x - st.pos.x, ry = p.pos.y - st.pos.y;
        const heading = Math.atan2(-rx * dir, ry * dir);
        const err = wrap(heading - p.angle);
        sf.controls({ turn: Math.max(-1, Math.min(1, err * 4)), thrust: Math.abs(err) < 0.3 ? 1 : 0, retro: 0, strafe: 0, fire: false, boost: false });
        sf.step(1);
        if (p.tether) peak = Math.max(peak, p.tether.tension);
        if (t % 360 === 0) log.push({ t: t / 120, spin: st.spin.toFixed(4), tension: p.tether ? p.tether.tension.toFixed(1) : '-', stretch: p.tether ? p.tether.stretch.toFixed(2) : '-', spd: Math.hypot(p.vel.x - st.vel.x, p.vel.y - st.vel.y).toFixed(1) });
      }
      sf.controls(null);
      return { spin: st.spin, peak, tethered: !!p.tether, hull: p.hull, log };
    }, [Math.sign(spin0), 120 * 25]);
    console.log('5. station spin:', spin0.toFixed(3), '->', tor.spin.toFixed(3), 'latched', okS, sl.tether && sl.tether.kind, 'peak', tor.peak.toFixed(0), 'tethered', tor.tethered, 'hull', tor.hull.toFixed(0));
    console.log('   ', tor.log.map(l => `${l.t}s spin=${l.spin} T=${l.tension} ext=${l.stretch} v=${l.spd}`).join(' | '));
    await api.shot(page, 'tether_station', 10);
  },

  async cut({ page }) {
    await api.manual(page, true);
    for (const fit of ['stock', 'jets']) {
      await api.newGame(page, 2024);
      await api.launch(page);
      if (fit === 'jets') await page.evaluate(() => window.__sf.buyAll());
      let sl = await page.evaluate(() => window.__sf.slice());
      const cut = sl.cut;
      const path = cut.path;
      const mouth = path[0];
      const ox = mouth.x - cut.bodyPos.x, oy = mouth.y - cut.bodyPos.y, ol = Math.hypot(ox, oy);
      const ux = ox / ol, uy = oy / ol;
      const bodyVel = await page.evaluate(() => { const b = window.__sf.game.world.slices.cutBody; return { x: b.vel.x, y: b.vel.y }; });
      await page.evaluate(([x, y, vx, vy, a]) => window.__sf.teleport(x, y, vx, vy, a), [mouth.x + ux * 40, mouth.y + uy * 40, bodyVel.x, bodyVel.y, Math.atan2(uy, ux)]);
      await api.shot(page, 'cut_' + fit + '_above', 60);
      await page.evaluate(() => window.__sf.ping());
      await api.run(page, {}, 1.2);
      await api.shot(page, 'cut_' + fit + '_ping', 5);
      const t0 = (await api.state(page)).time;
      const down = await follow(page, cut.pathLocal, { seconds: 150, tol: 2.0, maxSpeed: fit === 'jets' ? 6 : 4.5, gain: 2.4, body: cut.body });
      let st = await api.state(page);
      console.log(fit, 'DESCENT: reached', down.reached, '/', down.of, 'alive', down.alive, 'hull', down.hull.toFixed(0), 'fuel', down.fuel.toFixed(0), 'time', (st.time - t0).toFixed(0), 's');
      if (down.reached < down.of) console.log(down.log.slice(-4));
      await api.shot(page, 'cut_' + fit + '_chamber', 30);
      if (!down.alive) continue;
      // latch the regulator
      const latched = await page.evaluate(() => window.__sf.tether());
      sl = await page.evaluate(() => window.__sf.slice());
      console.log('   latch:', latched, sl.tether && sl.tether.kind, sl.cut.regulator && sl.cut.regulator.tethered);
      const t1 = st.time;
      const m0 = cut.pathLocal[0], ml = Math.hypot(m0.x, m0.y);
      const up = await follow(page, cut.pathLocal.slice().reverse().concat([{ x: m0.x + m0.x / ml * 30, y: m0.y + m0.y / ml * 30 }]), { seconds: 200, tol: 2.4, maxSpeed: fit === 'jets' ? 5 : 3.8, gain: 2.0, body: cut.body });
      st = await api.state(page);
      sl = await page.evaluate(() => window.__sf.slice());
      console.log('   CLIMB: reached', up.reached, '/', up.of, 'alive', up.alive, 'hull', up.hull.toFixed(0), 'fuel', up.fuel.toFixed(0), 'time', (st.time - t1).toFixed(0), 's', 'still tethered', up.tethered, 'peak tension', up.peak, 'powered', sl.cut.powered, 'reg socket dist', sl.cut.regulator.socketDist.toFixed(1));
      console.log(up.log.slice(-8).map(l => `${l.t}s wp${l.wp} d${l.d} hull${l.hull} spd${l.spd} T${l.tension}`).join(' | '));
      await api.shot(page, 'cut_' + fit + '_out', 30);
    }
    // alternative: shoot the regulator out of its socket from inside the chamber
    await api.newGame(page, 2024);
    await api.launch(page);
    let sl = await page.evaluate(() => window.__sf.slice());
    const path = sl.cut.path;
    const bodyVel = await page.evaluate(() => { const b = window.__sf.game.world.slices.cutBody; return { x: b.vel.x, y: b.vel.y }; });
    const ch = path[path.length - 3];
    await page.evaluate(([x, y, vx, vy]) => window.__sf.teleport(x, y, vx, vy, 0), [ch.x, ch.y, bodyVel.x, bodyVel.y]);
    const shoot = await page.evaluate(([ticks]) => {
      const sf = window.__sf, w = sf.game.world, p = w.player, S = w.slices;
      const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
      const log = [];
      for (let t = 0; t < ticks; t++) {
        const r = S.regulator;
        const aim = Math.atan2(r.pos.y - p.pos.y, r.pos.x - p.pos.x);
        const err = wrap(aim - p.angle);
        const [gx, gy] = sf.gravity(p.pos.x, p.pos.y);
        // alternate: hover bursts (nose against gravity) and aiming
        const hoverHeading = Math.atan2(-gy, -gx);
        const hover = (t % 60) < 25;
        const want = hover ? hoverHeading : aim;
        const e2 = wrap(want - p.angle);
        sf.controls({ turn: Math.max(-1, Math.min(1, e2 * 4)), thrust: hover && Math.abs(e2) < 0.4 ? 1 : 0, retro: 0, strafe: 0, fire: !hover && Math.abs(err) < 0.1, boost: false });
        sf.step(1);
        if (t % 120 === 0) { const sp = window.__sf.slice(); log.push({ t: t / 120, socket: sp.cut.regulator.socketDist.toFixed(1), powered: sp.cut.powered, hull: p.hull.toFixed(0) }); }
      }
      sf.controls(null);
      return log;
    }, [120 * 20]);
    console.log('SHOOT ALTERNATIVE:', shoot.map(l => `${l.t}s d=${l.socket} pow=${l.powered ? 1 : 0}`).join(' | '));
  },

  async pilgrim({ page }) {
    await api.manual(page, true);
    await api.newGame(page, 2024);
    await api.launch(page);
    await page.evaluate(() => window.__sf.spawnPilgrim());
    await api.step(page, 2);
    let sl = await page.evaluate(() => window.__sf.slice());
    const P = sl.pilgrim;
    console.log('spawned: star dist', P.starDist.toFixed(0), 'speed', Math.hypot(P.vx, P.vy).toFixed(1), 'peri', sl.pilgrimPeri.toFixed(0), 'thrusters', P.thrusters.map(t => t.name).join(', '));
    await page.evaluate(([x, y, vx, vy]) => window.__sf.teleport(x + 90, y + 40, vx, vy, Math.PI), [P.x, P.y, P.vx, P.vy]);
    await api.shot(page, 'pilgrim_approach', 60);
    // land on the stern port tank
    let res = await autoLand(page, 'PILGRIM', 'STERN PORT TANK', 120);
    let st = await api.state(page);
    console.log('LAND stern port:', res.landed ? 'OK' : (res.alive ? 'NOT LANDED' : 'DEAD'), 'hull', res.hull.toFixed(0), 'touch', res.crashSpeed.toFixed(2), 'time', st.time.toFixed(0));
    if (!res.landed) console.log(res.log.slice(-5));
    await api.shot(page, 'pilgrim_landed', 40);
    // transfer 40 fuel
    await page.evaluate(() => window.__sf.transfer(true));
    await api.run(page, {}, 8);
    await page.evaluate(() => window.__sf.transfer(false));
    sl = await page.evaluate(() => window.__sf.slice());
    console.log('after transfer: tanks', sl.pilgrim.thrusters.map(t => t.name.split(' ')[0] + ':' + t.fuel.toFixed(0)).join(' '), 'player fuel', (await api.state(page)).player.fuel.toFixed(0), 'angVel', sl.pilgrim.angVel.toFixed(4));
    for (let i = 0; i < 5; i++) {
      await api.run(page, {}, 10);
      sl = await page.evaluate(() => window.__sf.slice());
      console.log(`  +${(i + 1) * 10}s angVel ${sl.pilgrim.angVel.toFixed(4)} spd ${Math.hypot(sl.pilgrim.vx, sl.pilgrim.vy).toFixed(2)} peri ${sl.pilgrimPeri.toFixed(0)} tank ${sl.pilgrim.thrusters[1].fuel.toFixed(0)} landed ${(await api.state(page)).player.landed ? 'y' : 'n'}`);
    }
    await api.shot(page, 'pilgrim_burn', 30);
    // counter the spin with the bow port tank, then push with the stern main
    await api.run(page, { thrust: 1 }, 1.2);
    await page.evaluate(() => window.__sf.refuel());
    await page.evaluate(() => window.__sf.buyAll());
    console.log('(fitting lateral jets and retro for the spinning-hull landings)');
    res = await autoLand(page, 'PILGRIM', 'BOW PORT TANK', 120);
    console.log('LAND bow port:', res.landed ? 'OK' : (res.alive ? 'NOT LANDED' : 'DEAD'), 'hull', res.hull.toFixed(0));
    if (!res.landed) console.log(res.log.slice(-6).map(l => `${l.t}s alt${l.alt} arc${l.arc} vr${l.vr} vt${l.vt}`).join(' | '));
    if (res.landed) { await page.evaluate(() => window.__sf.transfer(true)); await api.run(page, {}, 8); await page.evaluate(() => window.__sf.transfer(false)); }
    for (let i = 0; i < 4; i++) { await api.run(page, {}, 10); sl = await page.evaluate(() => window.__sf.slice()); console.log(`  +${(i + 1) * 10}s angVel ${sl.pilgrim.angVel.toFixed(4)} peri ${sl.pilgrimPeri.toFixed(0)}`); }
    await api.run(page, { thrust: 1 }, 1.2);
    await page.evaluate(() => window.__sf.refuel());
    res = await autoLand(page, 'PILGRIM', 'STERN MAIN TANK', 120);
    console.log('LAND stern main:', res.landed ? 'OK' : (res.alive ? 'NOT LANDED' : 'DEAD'), 'hull', res.hull.toFixed(0), 'player fuel', res.fuel.toFixed(0));
    if (!res.landed) console.log(res.log.slice(-6).map(l => `${l.t}s alt${l.alt} arc${l.arc} vr${l.vr} vt${l.vt}`).join(' | '));
    if (res.landed) { await page.evaluate(() => window.__sf.transfer(true)); await api.run(page, {}, 8); await page.evaluate(() => window.__sf.transfer(false)); }
    for (let i = 0; i < 6; i++) { await api.run(page, {}, 10); sl = await page.evaluate(() => window.__sf.slice()); console.log(`  +${(i + 1) * 10}s angVel ${sl.pilgrim.angVel.toFixed(4)} peri ${sl.pilgrimPeri.toFixed(0)} saved ${sl.pilgrim.saved}`); }
    st = await api.state(page);
    console.log('comms:', st.comms.slice(-4));
    await api.shot(page, 'pilgrim_end', 30);
    // ---- tow alternative
    await api.newGame(page, 2024);
    await api.launch(page);
    await page.evaluate(() => window.__sf.spawnPilgrim());
    await api.step(page, 2);
    sl = await page.evaluate(() => window.__sf.slice());
    const Q = sl.pilgrim;
    const sx = Q.x, sy = Q.y;
    const away = Math.atan2(Q.vy, Q.vx); // prograde: push along the hull's motion to raise its periapsis
    // stand just off the bow tank and latch onto the hull there
    const bp = Q.thrusters[0].pad;
    const bx = bp.x - sx, by = bp.y - sy, bl = Math.hypot(bx, by);
    await page.evaluate(([x, y, vx, vy, a]) => window.__sf.teleport(x, y, vx, vy, a), [bp.x + bx / bl * 4, bp.y + by / bl * 4, Q.vx, Q.vy, away]);
    await untether(page);
    const latched = await page.evaluate(() => window.__sf.tether());
    sl = await page.evaluate(() => window.__sf.slice());
    console.log('TOW: latched', latched, sl.tether && sl.tether.kind, 'peri0', sl.pilgrimPeri.toFixed(0));
    const peri0 = sl.pilgrimPeri;
    console.log('  tow probe (T per 0.5 s):', await page.evaluate(([h]) => { const sf = window.__sf, w = sf.game.world, p = w.player; const wrap = a => Math.atan2(Math.sin(a), Math.cos(a)); const out = []; for (let t = 0; t < 120 * 12; t++) { const err = wrap(h - p.angle); sf.controls({ turn: Math.max(-1, Math.min(1, err * 4)), thrust: Math.abs(err) < 0.3 ? 1 : 0 }); sf.step(1); if (t % 60 === 0) out.push(p.tether ? `T${p.tether.tension.toFixed(0)}/e${p.tether.stretch.toFixed(2)}/L${p.tether.length.toFixed(1)}` : 'x'); } sf.controls(null); return out.join(' '); }, [away]));
    for (let i = 0; i < 6; i++) {
      const r = await pull(page, away, 15, 1);
      sl = await page.evaluate(() => window.__sf.slice());
      console.log(`  tow ${(i + 1) * 15}s: peri ${sl.pilgrimPeri.toFixed(0)} (+${(sl.pilgrimPeri - peri0).toFixed(0)}) tension peak ${r.peak.toFixed(0)} snapped ${r.snapped} hull spd ${Math.hypot(sl.pilgrim.vx, sl.pilgrim.vy).toFixed(2)} fuel ${(await api.state(page)).player.fuel.toFixed(0)}`);
      if (r.snapped) break;
    }
    await api.shot(page, 'pilgrim_tow', 20);
  },

  async signal({ page }) {
    await api.manual(page, true);
    await api.newGame(page, 2024);
    await api.launch(page);
    let sl = await page.evaluate(() => window.__sf.slice());
    const R = sl.signal.rock;
    const box = sl.signal.box;
    for (const d of [1500, 700, 250]) {
      await page.evaluate(([x, y, vx, vy]) => window.__sf.teleport(x, y, vx, vy, 0), [box.x + d, box.y, R.vx, R.vy]);
      await page.evaluate(() => window.__sf.audio());
      await api.run(page, {}, 10);
      const log = await page.evaluate(() => window.__sf.audio());
      console.log(`beacon at ${d}u: ${log.filter(k => k === 'blip').length} blips in 10 s`);
    }
    // ping from 200 units: expect an echo ring from the hollow rock
    sl = await page.evaluate(() => window.__sf.slice());
    const R2 = sl.signal.rock;
    await page.evaluate(([x, y, vx, vy]) => window.__sf.teleport(x, y, vx, vy, 0), [R2.x + 200, R2.y, R2.vx, R2.vy]);
    await page.evaluate(() => window.__sf.ping());
    await api.run(page, {}, 0.5);
    const p1 = (await page.evaluate(() => window.__sf.slice())).pings;
    await api.run(page, {}, 1.4);
    const p2 = (await page.evaluate(() => window.__sf.slice())).pings;
    const log = await page.evaluate(() => window.__sf.audio());
    console.log('ping near the rock: rings', p1, '->', p2, 'audio', log.filter(k => k === 'echo' || k === 'ping').join(','));
    await api.shot(page, 'signal_ping', 3);
    // into the cave
    sl = await page.evaluate(() => window.__sf.slice());
    const path = sl.signal.rock.path;
    const mouth = path[0];
    const rx = mouth.x - sl.signal.rock.x, ry = mouth.y - sl.signal.rock.y, rl = Math.hypot(rx, ry);
    await page.evaluate(([x, y, vx, vy, a]) => window.__sf.teleport(x, y, vx, vy, a), [mouth.x + rx / rl * 25, mouth.y + ry / rl * 25, sl.signal.rock.vx, sl.signal.rock.vy, Math.atan2(ry, rx)]);
    await api.shot(page, 'signal_mouth', 40);
    const inn = await follow(page, sl.signal.rock.pathLocal, { seconds: 120, tol: 2.0, maxSpeed: 4, gain: 2.4, body: 'HOLLOW' });
    let st = await api.state(page);
    sl = await page.evaluate(() => window.__sf.slice());
    console.log('CAVE: reached', inn.reached, '/', inn.of, 'alive', inn.alive, 'hull', inn.hull.toFixed(0), 'box alive', sl.signal.box.alive, 'log line', sl.signal.logLine);
    await api.shot(page, 'signal_cave', 30);
    await api.run(page, {}, 16);
    st = await api.state(page);
    sl = await page.evaluate(() => window.__sf.slice());
    console.log('log played', sl.signal.logPlayed, st.comms.filter(c => c.startsWith('KESTREL SEVEN')));
    // fragile walls: fire inside
    const a0 = st.asteroids;
    await api.run(page, { fire: true, turn: 0.2 }, 2);
    st = await api.state(page);
    console.log('shots inside the cave: asteroids', a0, '->', st.asteroids, 'hull', st.player.hull.toFixed(0));
    await api.shot(page, 'signal_rubble', 20);
  },

  async fault({ page }) {
    await api.manual(page, true);
    for (const mode of ['still', 'call']) {
      await api.newGame(page, 2024);
      await api.launch(page);
      const st0 = await api.state(page);
      const F = st0.bodies.find(b => b.name === 'THE FAULT');
      // sit in a circular orbit 130 out, with the Fault's own velocity added
      const fv = await page.evaluate(() => { const f = window.__sf.game.world.slices.fault; return { x: f.vel.x, y: f.vel.y, m: f.mass }; });
      const rr = 130, v = Math.sqrt(fv.m / rr);
      await page.evaluate(([x, y, vx, vy]) => window.__sf.teleport(x, y, vx, vy, 0), [F.x + rr, F.y, fv.x, fv.y + v]);
      const enemies0 = st0.ships.filter(s => s.faction === 'enemy' && s.kind !== 'sentinel').length;
      const targetPhase = mode === 'still' ? (3 - rr / 150) / 3 : (1.5 - rr / 150) / 3;
      const res = await page.evaluate(([targetPhase]) => {
        const sf = window.__sf, w = sf.game.world;
        const out = [];
        for (let n = 0; n < 3; n++) {
          // wait for the phase window
          let guard = 0;
          while (Math.abs(((w.time % 3) / 3) - targetPhase) > 0.012 && guard++ < 800) sf.step(1);
          sf.ping();
          const t = w.time;
          for (let i = 0; i < 360; i++) sf.step(1);
          const s = sf.slice();
          out.push({ pingedAt: (t % 3 / 3).toFixed(3), onBeat: s.fault.onBeat, offBeat: s.fault.offBeat, answer: s.fault.answer });
        }
        return out;
      }, [targetPhase]);
      console.log(mode.toUpperCase(), 'pings:', res.map(r => `ph=${r.pingedAt} on=${r.onBeat} off=${r.offBeat} ans=${r.answer}`).join(' | '));
      await api.shot(page, 'fault_' + mode, 5);
      await api.run(page, {}, 45);
      const st = await api.state(page);
      const sl = await page.evaluate(() => window.__sf.slice());
      const enemies = st.ships.filter(s => s.faction === 'enemy' && s.kind !== 'sentinel');
      console.log(`  after 45 s: enemies ${enemies0} -> ${enemies.length}, stunned ${enemies.filter(s => s.mode).length ? enemies.map(s => s.kind[0] + ':' + s.mode).join(' ') : '-'}, answer ${sl.fault.answer}`);
      console.log('  comms:', st.comms.slice(-3));
    }
  },
};
Object.assign(scenarios, sliceScenarios);

const { browser, page, errors } = await launch();
try {
  const fn = scenarios[scenario];
  if (!fn) { console.error('unknown scenario', scenario, 'available:', Object.keys(scenarios)); process.exit(1); }
  await fn({ page });
} finally {
  if (errors.length) console.log('CONSOLE ERRORS/WARNINGS:\n' + errors.slice(0, 20).join('\n'));
  await browser.close();
}
