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

const { browser, page, errors } = await launch();
try {
  const fn = scenarios[scenario];
  if (!fn) { console.error('unknown scenario', scenario, 'available:', Object.keys(scenarios)); process.exit(1); }
  await fn({ page });
} finally {
  if (errors.length) console.log('CONSOLE ERRORS/WARNINGS:\n' + errors.slice(0, 20).join('\n'));
  await browser.close();
}
