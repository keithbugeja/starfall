// Playtest driver: loads the built game in headless Chromium, runs a named scenario, saves screenshots
// and prints state. Usage: node playtest/run.mjs <scenario> [--url http://localhost:4173]
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

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


/** Keep clear of hulls, stations, wreck hulks and rocks: a repulsive velocity that grows as the keep-out radius nears, looking a little ahead. Prepended to the controller sources. */
const AVOID_SRC = `
  const avoid = (w, p, vx, vy, skipStation) => {
    const look = 2.0;
    const push = (ox, oy, ovx, ovy, keep, margin, strength) => {
      const fx = (ox + ovx * look) - (p.pos.x + p.vel.x * look), fy = (oy + ovy * look) - (p.pos.y + p.vel.y * look);
      const d = Math.min(Math.hypot(ox - p.pos.x, oy - p.pos.y), Math.hypot(fx, fy));
      if (d > keep + margin) return;
      const nx = p.pos.x - ox, ny = p.pos.y - oy, nl = Math.hypot(nx, ny) || 1;
      const k = Math.min(1, (keep + margin - d) / margin);
      vx += nx / nl * strength * k; vy += ny / nl * strength * k;
    };
    for (const b of w.bodies) if (b.kind === 'hull') push(b.pos.x, b.pos.y, b.vel.x, b.vel.y, b.radius + 30, 70, 22);
    for (const s of w.stations) if (s.alive && s !== skipStation) push(s.pos.x, s.pos.y, s.vel.x, s.vel.y, s.radius * 2.2, 40, 14);
    for (const k of w.pickups) if (k.alive && k.kind === 'wreck') push(k.pos.x, k.pos.y, k.vel.x, k.vel.y, 5, 8, 7);
    for (const a of w.asteroids) if (a.alive) push(a.pos.x, a.pos.y, a.vel.x, a.vel.y, a.radius + 6, 30, 20);
    return [vx, vy];
  };
`;

/** Landing autopilot: runs inside the page. Returns a log. */
const LANDER_SRC = AVOID_SRC + `
  const w = sf.game.world, p = w.player;
  const b = w.bodies.find(b => b.name === bodyName);
  const pad = b.pads.find(q => q.name === padName);
  const log = [], hits = [];
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
    { const av = avoid(w, p, 0, 0, null); ax += av[0] * 1.6; ay += av[1] * 1.6; }
    const am = Math.hypot(ax, ay);
    const wantHeading = am > 0.3 ? Math.atan2(ay, ax) : Math.atan2(uy, ux);
    const hErr = wrap(wantHeading - p.angle);
    const c = { turn: Math.max(-1, Math.min(1, hErr * 3.0)), thrust: 0, retro: 0, strafe: 0, fire: false, boost: false };
    if (Math.abs(hErr) < 0.35 && am > 0.3) c.thrust = Math.min(1, am / p.stats.thrust);
    if (alt < 6 && Math.abs(arc) < 4) { const up = wrap(Math.atan2(uy, ux) - p.angle); c.turn = Math.max(-1, Math.min(1, up * 3)); }
    sf.controls(c);
    const hullBefore = p.hull;
    sf.step(1);
    if (p.hull < hullBefore - 0.01) {
      const near = [];
      for (const k of w.pickups) if (k.alive) near.push(['pickup ' + k.kind + ' ' + k.name, Math.hypot(k.pos.x - p.pos.x, k.pos.y - p.pos.y)]);
      for (const a of w.asteroids) if (a.alive) near.push(['rock ' + a.size + ' f' + a.field, Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y)]);
      for (const s of w.ships) if (s !== p && s.alive) near.push(['ship ' + s.kind + ' ' + s.faction, Math.hypot(s.pos.x - p.pos.x, s.pos.y - p.pos.y)]);
      for (const st of w.structures) if (st.alive) { const c2 = Math.cos(st.body.spinAngle), s2 = Math.sin(st.body.spinAngle); const x = st.body.pos.x + st.local.x * c2 - st.local.y * s2, y = st.body.pos.y + st.local.x * s2 + st.local.y * c2; near.push(['structure ' + st.name, Math.hypot(x - p.pos.x, y - p.pos.y)]); }
      near.sort((u, v) => u[1] - v[1]);
      hits.push({ t: (t / 120).toFixed(1), alt: alt.toFixed(1), arc: arc.toFixed(1), dmg: (hullBefore - p.hull).toFixed(0), src: p.lastDamageSource, near: near.slice(0, 2).map(n => n[0] + ' ' + n[1].toFixed(1)).join(' | ') });
    }
    if (t % 120 === 0) log.push({ t: (t / 120).toFixed(1), alt: alt.toFixed(1), arc: arc.toFixed(1), vr: vr.toFixed(2), vt: vt.toFixed(2), hErr: hErr.toFixed(2), hull: p.hull.toFixed(0), fuel: p.fuel.toFixed(0) });
  }
  sf.controls(null);
  return { log, hits, landed: p.landed ? { pad: p.landed.pad && p.landed.pad.name, body: p.landed.body.name } : null, hull: p.hull, alive: p.alive, crashSpeed: p.crashSpeed, fuel: p.fuel };
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
    await api.newGame(page, 12345);
    const st = await api.state(page);
    const pads = st.bodies.flatMap(b => b.pads.map(p => ({ body: b.name, pad: p.name })));
    for (const target of pads) {
      await api.newGame(page, 12345);
      await api.launch(page);
      const res = await autoLand(page, target.body, target.pad, 90);
      const st2 = await api.state(page);
      console.log(target.body, '/', target.pad, '=>', res.landed ? 'LANDED on ' + res.landed.pad : (res.alive ? 'NOT LANDED' : 'DEAD'), 'hull', res.hull.toFixed(0), 'fuel', res.fuel.toFixed(0), 'touch', res.crashSpeed.toFixed(2), 'lastDamage', st2.player.lastDamageSource);
      if (!res.landed) console.log(res.log.slice(-3));
      if (res.hits && res.hits.length) console.log('   hits:', res.hits.slice(0, 6).map(h => `${h.t}s alt${h.alt} arc${h.arc} -${h.dmg} ${h.src} [${h.near}]`).join(' || '));
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
const DOCK_SRC = AVOID_SRC + `
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
      { const av = avoid(w, p, wantVx, wantVy, st); wantVx = av[0]; wantVy = av[1]; }
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
    if (!p.alive || p.hull < minHull) break;
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

async function autoFight(page, seconds, minHull = 0) {
  return page.evaluate(([src, ticks, minHull]) => {
    const f = new Function('sf', 'ticks', 'minHull', src);
    return f(window.__sf, ticks, minHull);
  }, [FIGHT_SRC, Math.round(seconds * 120), minHull]);
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
      const base = st.pads.find(p => p.name === 'BASE KILO');
      const b = st.bodies.find(x => x.name === base.body);
      const bv = await page.evaluate(() => { const b = window.__sf.game.world.enemyCore.body; return { x: b.vel.x, y: b.vel.y, spin: b.spinAngle }; });
      await page.evaluate(([x, y, vx, vy, a]) => window.__sf.teleport(x, y, vx, vy, a + Math.PI), [b.x + Math.cos(base.angle + bv.spin) * (base.height + 55), b.y + Math.sin(base.angle + bv.spin) * (base.height + 55), bv.x, bv.y, base.angle + bv.spin]);
      const res = await page.evaluate(([ticks]) => {
        const sf = window.__sf, w = sf.game.world, p = w.player;
        const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
        const pad = w.pads.find(q => q.name === 'BASE KILO');
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
          const pa = pad.angle + b.spinAngle;
          let tx = b.pos.x + Math.cos(pa) * pad.height, ty = b.pos.y + Math.sin(pa) * pad.height;
          const sent = w.ships.filter(s => s.alive && s.kind === 'sentinel' && s.ai.home === pad);
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
        return { alive: p.alive, hull: p.hull, baseAlive: pad.alive, baseHp: pad.enemyHealth, hp0, sentinels: w.ships.filter(s => s.alive && s.kind === 'sentinel' && s.ai.home === pad).length, time: w.time, guns: w.ships.filter(s => s.kind === 'sentinel' && s.ai.home === pad).map(g => `${g.alive ? 'up' : 'dead'} heat${g.heat.toFixed(2)}${g.overheated ? 'J' : ''}`), sun: sf.bases().find(q => q.name === 'BASE KILO').sun, cause: p.lastDamageSource };
      }, [120 * 90]);
      console.log(fit, '=>', res.alive ? 'ALIVE' : 'DEAD (' + res.cause + ')', 'hull', res.hull.toFixed(0), 'base', res.baseAlive ? 'STANDS ' + res.baseHp.toFixed(0) + '/' + res.hp0 : 'DESTROYED', 'its guns', res.guns.join(','), 'sun', res.sun.toFixed(2), 'time', res.time.toFixed(0));
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
const FOLLOW_SRC = AVOID_SRC + `
  const w = sf.game.world, p = w.player;
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  const body = bodyName ? w.bodies.find(b => b.name === bodyName) : null;
  const toWorld = (l) => { if (!body) return l; const c = Math.cos(body.rotates ? body.spinAngle : 0), s = Math.sin(body.rotates ? body.spinAngle : 0); return { x: body.pos.x + l.x * c - l.y * s, y: body.pos.y + l.x * s + l.y * c }; };
  const log = [], hits = [];
  let idx = 0, t = 0, stuck = 0;
  const grav = () => sf.gravity(p.pos.x, p.pos.y);
  while (idx < pts.length && t < ticks && p.alive) {
    const wp = toWorld(pts[idx]);
    const refVel = body ? { x: body.vel.x, y: body.vel.y } : refVel0;
    const dx = wp.x - p.pos.x, dy = wp.y - p.pos.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    if (d < tol) { idx++; stuck = 0; continue; }
    const [gx, gy] = grav();
    let cap = maxSpeed;
    for (const b of w.bodies) { if (b.kind === 'star' || b.kind === 'hull') continue; const alt = Math.hypot(p.pos.x - b.pos.x, p.pos.y - b.pos.y) - b.radius; if (alt < b.radius * 1.5) cap = Math.min(cap, 14); }
    const sp = Math.min(cap, Math.max(1.2, d * 0.5));
    // reference frame: the body the waypoints belong to (its velocity)
    let wantVx = refVel.x + dx / d * sp, wantVy = refVel.y + dy / d * sp;
    if (avoidOn) { const av = avoid(w, p, wantVx, wantVy, null); wantVx = av[0]; wantVy = av[1]; }
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
    const hullBefore = p.hull;
    sf.step(1);
    if (p.hull < hullBefore - 0.01) hits.push({ t: t / 120, wp: idx, x: p.pos.x, y: p.pos.y, dmg: hullBefore - p.hull, src: p.lastDamageSource });
    t++;
    if (t % 120 === 0) log.push({ t: (t / 120).toFixed(0), wp: idx, d: d.toFixed(1), hull: p.hull.toFixed(0), fuel: p.fuel.toFixed(0), spd: Math.hypot(p.vel.x - refVel.x, p.vel.y - refVel.y).toFixed(1), tension: p.tether ? p.tether.tension.toFixed(0) : '-' });
    if (++stuck > 120 * 25) { log.push({ stuck: idx }); break; }
  }
  sf.controls(null);
  return { log, hits, reached: idx, of: pts.length, alive: p.alive, hull: p.hull, fuel: p.fuel, ticks: t, tethered: !!p.tether, peak: p.tether ? p.tether.peak : null };
`;

/** Chase loose pickups: fly to the nearest free-floating piece with velocity matched to it, collect on contact, repeat. Runs inside the page. */
const CHASE_SRC = AVOID_SRC + `
  const w = sf.game.world, p = w.player;
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  const loose = k => k.alive && !k.carriedBy && !k.socketBody && (k.kind === 'salvage' || k.kind === 'ore' || k.kind === 'fuel') && w.bodies.every(b => b.kind === 'star' || Math.hypot(k.pos.x - b.pos.x, k.pos.y - b.pos.y) > (b.kind === 'hull' ? b.radius + 80 : b.radius * 1.5 + 40));
  let t = 0, stuck = 0, last = null;
  const hits = [];
  const before = p.cargo.ore + p.cargo.salvage, fuelBefore = p.fuel;
  while (t < ticks && p.alive && !w.flare.active && !w.flare.warned) {
    let best = null, bd = radius;
    for (const k of w.pickups) { if (!loose(k)) continue; const d = Math.hypot(k.pos.x - p.pos.x, k.pos.y - p.pos.y); if (d < bd) { bd = d; best = k; } }
    if (!best) break;
    if (p.cargo.ore + p.cargo.salvage >= p.cargo.capacity && best.kind !== 'fuel') break;
    if (best !== last) { last = best; stuck = 0; }
    const dx = best.pos.x - p.pos.x, dy = best.pos.y - p.pos.y, d = Math.hypot(dx, dy) || 1e-6;
    const sp = Math.min(maxSpeed, Math.max(2, d * 0.5));
    let wantVx = best.vel.x + dx / d * sp, wantVy = best.vel.y + dy / d * sp;
    { const av = avoid(w, p, wantVx, wantVy, null); wantVx = av[0]; wantVy = av[1]; }
    const [gx, gy] = sf.gravity(p.pos.x, p.pos.y);
    const ax = (wantVx - p.vel.x) * 2.6 - gx, ay = (wantVy - p.vel.y) * 2.6 - gy;
    const am = Math.hypot(ax, ay);
    const c = { turn: 0, thrust: 0, retro: 0, strafe: 0, fire: false, boost: false };
    if (am > 0.3) { const err = wrap(Math.atan2(ay, ax) - p.angle); c.turn = Math.max(-1, Math.min(1, err * 4)); const fwd = ax * Math.cos(p.angle) + ay * Math.sin(p.angle); if (Math.abs(err) < 0.5 && fwd > 0) c.thrust = Math.min(1, fwd / p.stats.thrust); }
    sf.controls(c);
    const h0 = p.hull;
    sf.step(1);
    if (p.hull < h0 - 0.01) hits.push({ t: (t / 120).toFixed(1), dmg: (h0 - p.hull).toFixed(1), src: p.lastDamageSource, near: sf.surroundings() });
    t++;
    if (++stuck > 120 * 30) break;
  }
  sf.controls(null);
  return { got: p.cargo.ore + p.cargo.salvage - before, fuel: p.fuel - fuelBefore, ticks: t, alive: p.alive, hull: p.hull, hits };
`;
async function chase(page, radius, maxSpeed, seconds) {
  return page.evaluate(([src, radius, maxSpeed, ticks]) => { const f = new Function('sf', 'radius', 'maxSpeed', 'ticks', src); return f(window.__sf, radius, maxSpeed, ticks); }, [CHASE_SRC, radius, maxSpeed, Math.round(seconds * 120)]);
}

/** Climb off a world: a gentle lift on the struts, then a radial ascent at a modest speed to a target altitude, keeping clear of hulls. Runs inside the page. */
const CLIMB_SRC = AVOID_SRC + `
  const w = sf.game.world, p = w.player;
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  let b = p.landed ? p.landed.body : null;
  if (!b) { let bd = 1e9; for (const q of w.bodies) { if (q.kind === 'star' || q.kind === 'hull') continue; const d = Math.hypot(p.pos.x - q.pos.x, p.pos.y - q.pos.y) - q.radius; if (d < bd) { bd = d; b = q; } } }
  let t = 0;
  for (; t < 30 && p.landed; t++) { sf.controls({ turn: 0, thrust: 0.6, retro: 0, strafe: 0, fire: false, boost: false }); sf.step(1); }
  while (t < ticks && p.alive) {
    const dx = p.pos.x - b.pos.x, dy = p.pos.y - b.pos.y, r = Math.hypot(dx, dy) || 1;
    const alt = r - b.radius;
    if (alt > targetAlt) break;
    const ux = dx / r, uy = dy / r;
    const sp = Math.min(maxSpeed, Math.max(4, alt * 0.35));
    let wantVx = b.vel.x + ux * sp, wantVy = b.vel.y + uy * sp;
    { const av = avoid(w, p, wantVx, wantVy, null); wantVx = av[0]; wantVy = av[1]; }
    const [gx, gy] = sf.gravity(p.pos.x, p.pos.y);
    const ax = (wantVx - p.vel.x) * 2.4 - gx, ay = (wantVy - p.vel.y) * 2.4 - gy;
    const c = { turn: 0, thrust: 0, retro: 0, strafe: 0, fire: false, boost: false };
    const err = wrap(Math.atan2(ay, ax) - p.angle);
    c.turn = Math.max(-1, Math.min(1, err * 4));
    const fwd = ax * Math.cos(p.angle) + ay * Math.sin(p.angle);
    if (Math.abs(err) < 0.5 && fwd > 0) c.thrust = Math.min(1, fwd / p.stats.thrust);
    sf.controls(c);
    sf.step(1);
    t++;
  }
  sf.controls(null);
  return { alive: p.alive, hull: p.hull, ticks: t, landed: !!p.landed };
`;
async function climb(page, targetAlt, maxSpeed, seconds) {
  return page.evaluate(([src, targetAlt, maxSpeed, ticks]) => { const f = new Function('sf', 'targetAlt', 'maxSpeed', 'ticks', src); return f(window.__sf, targetAlt, maxSpeed, ticks); }, [CLIMB_SRC, targetAlt, maxSpeed, Math.round(seconds * 120)]);
}

async function follow(page, pts, opts = {}) {
  const { seconds = 120, tol = 2.2, maxSpeed = 4.5, gain = 2.2, refVel = { x: 0, y: 0 }, body = null, avoid = false } = opts;
  return page.evaluate(([src, pts, ticks, tol, maxSpeed, gain, refVel0, bodyName, avoidOn]) => {
    const f = new Function('sf', 'pts', 'ticks', 'tol', 'maxSpeed', 'gain', 'refVel0', 'bodyName', 'avoidOn', src);
    return f(window.__sf, pts, ticks, tol, maxSpeed, gain, refVel0, bodyName, avoidOn);
  }, [FOLLOW_SRC, pts, Math.round(seconds * 120), tol, maxSpeed, gain, refVel, body, avoid]);
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

  async launchcheck({ page }) {
    // what does the ship hit in the first seconds after launch?
    await api.manual(page, true);
    const seed = Number(process.env.PLANET_SEED ?? 12345);
    await api.newGame(page, seed);
    await api.launch(page);
    const out = await page.evaluate(() => {
      const sf = window.__sf, w = sf.game.world, p = w.player;
      const log = [];
      let last = p.hull;
      for (let t = 0; t < 120 * 12; t++) {
        sf.step(1);
        if (p.hull < last - 0.01) {
          const near = [];
          for (const k of w.pickups) if (k.alive) near.push({ what: 'pickup ' + k.kind + ' ' + k.name + ' m' + k.mass, d: Math.hypot(k.pos.x - p.pos.x, k.pos.y - p.pos.y) });
          for (const a of w.asteroids) if (a.alive) near.push({ what: 'rock ' + a.size + ' f' + a.field, d: Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) });
          for (const s of w.ships) if (s !== p && s.alive) near.push({ what: 'ship ' + s.kind, d: Math.hypot(s.pos.x - p.pos.x, s.pos.y - p.pos.y) });
          for (const st of w.stations) near.push({ what: 'station ' + st.name, d: Math.hypot(st.pos.x - p.pos.x, st.pos.y - p.pos.y) });
          for (const b of w.bodies) near.push({ what: 'body ' + b.name, d: Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y) - b.maxRadius });
          near.sort((a, b) => a.d - b.d);
          log.push({ t: (t / 120).toFixed(2), hull: p.hull.toFixed(0), src: p.lastDamageSource, spd: Math.hypot(p.vel.x, p.vel.y).toFixed(1), near: near.slice(0, 3).map(n => n.what + ' ' + n.d.toFixed(1)) });
          last = p.hull;
          if (!p.alive) break;
        }
      }
      return { log, alive: p.alive, hull: p.hull, pos: { x: p.pos.x, y: p.pos.y } };
    });
    console.log(JSON.stringify(out, null, 1));
  },

  async landone({ page }) {
    await api.manual(page, true);
    await api.newGame(page, Number(process.env.PLANET_SEED ?? 12345));
    await api.launch(page);
    const st = await api.state(page);
    const body = process.env.LAND_BODY ?? st.bodies[2].name;
    const pad = process.env.LAND_PAD ?? st.bodies.find(b => b.name === body).pads[0].name;
    const res = await autoLand(page, body, pad, 90);
    console.log(body, '/', pad, '=>', res.landed ? 'LANDED' : res.alive ? 'NOT LANDED' : 'DEAD', 'hull', res.hull.toFixed(0), 'hits', res.hits.length);
    console.log(JSON.stringify(res.log.slice(0, 12)));
    console.log(JSON.stringify(res.hits.slice(0, 8)));
  },

  async padcheck({ page }) {
    // every pad on the cut worlds, approached from forty units up with the body's velocity: is it landable?
    await api.manual(page, true);
    const seed = Number(process.env.PLANET_SEED ?? 12345);
    await api.newGame(page, seed);
    const geo = await page.evaluate(() => window.__sf.geo());
    let ok = 0, n = 0;
    for (const g of geo) {
      for (const pad of g.pads) {
        await api.newGame(page, seed);
        await api.launch(page);
        // the free hull in home orbit crosses the approach column on some seeds; park it far away for this test
        await page.evaluate(() => { const w = window.__sf.game.world; const h = w.bodies.find(b => b.name === 'THE SLIPWAY'); if (h) { h.pos.x += 4000; h.pos.y += 4000; } });
        const G = (await page.evaluate(() => window.__sf.geo())).find(x => x.name === g.name);
        const q = G.pads.find(x => x.name === pad.name);
        const a = q.angle + G.spin;
        await page.evaluate(([x, y, vx, vy, a]) => window.__sf.teleport(x, y, vx, vy, a), [G.x + Math.cos(a) * (G.maxR + 40), G.y + Math.sin(a) * (G.maxR + 40), G.vx, G.vy, a]);
        const res = await autoLand(page, g.name, pad.name, 60);
        n++; if (res.landed) ok++;
        console.log(`${g.role} ${g.name} / ${pad.kind} ${pad.name} => ${res.landed ? 'LANDED on ' + res.landed.pad : res.alive ? 'NOT LANDED' : 'DEAD'} hull ${res.hull.toFixed(0)}${res.hits.length ? ' hits: ' + res.hits.slice(0, 3).map(h => `${h.t}s -${h.dmg} ${h.src} [${h.near}]`).join(' || ') : ''}`);
        if (!res.landed) console.log('   ', JSON.stringify(res.log.slice(-3)));
      }
    }
    console.log(`landed ${ok}/${n}`);
  },

  async voidprobe({ page }) {
    // where is the player relative to the Cut's outline, and what does the void mask look like in colour?
    await api.manual(page, true);
    await api.newGame(page, 2024);
    await api.launch(page);
    const sl = await page.evaluate(() => window.__sf.slice());
    const path = sl.cut.path;
    const bodyVel = await page.evaluate(() => { const b = window.__sf.game.world.slices.cutBody; return { x: b.vel.x, y: b.vel.y }; });
    const ch = path[path.length - 3];
    await page.evaluate(([x, y, vx, vy]) => window.__sf.teleport(x, y, vx, vy, 0), [ch.x, ch.y, bodyVel.x, bodyVel.y]);
    await api.run(page, {}, 0.5);
    const info = await page.evaluate(() => {
      const g = window.__sf.game, w = g.world, p = w.player, b = w.slices.cutBody, f = w.slices.cutFissure;
      const c = Math.cos(-b.spinAngle), s = Math.sin(-b.spinAngle);
      const dx = p.pos.x - b.pos.x, dy = p.pos.y - b.pos.y;
      const l = { x: dx * c - dy * s, y: dx * s + dy * c };
      let inside = false; const poly = f.outline;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y; if ((yi > y0(l)) !== (yj > y0(l)) && l.x < ((xj - xi) * (l.y - yi)) / (yj - yi) + xi) inside = !inside; }
      function y0(v) { return v.y; }
      const xs = poly.map(v => v.x), ys = poly.map(v => v.y);
      return { underground: g.underground && g.underground.name, spin: b.spinAngle, local: l, inside, bbox: [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], n: poly.length, cam: { x: g.camPos.x, y: g.camPos.y, h: g.camHeight, tilt: g.camTilt }, ship: { x: p.pos.x, y: p.pos.y }, body: { x: b.pos.x, y: b.pos.y } };
    });
    console.log(JSON.stringify(info));
    await api.shot(page, 'void_mask_off', 20);
    await page.evaluate(() => { window.__sf.game.debugVoid = true; });
    await api.shot(page, 'void_mask_on', 20);
  },

  async planets({ page }) {
    // the cut worlds: from above, at a mouth, and a flight through every chamber of the biggest complex at seven units a second
    await api.manual(page, true);
    const seed = Number(process.env.PLANET_SEED ?? 2024);
    const speed = Number(process.env.CAVE_SPEED ?? 7);
    await api.newGame(page, seed);
    await api.launch(page);
    const geo = await page.evaluate(() => window.__sf.geo());
    const refresh = async name => (await page.evaluate(() => window.__sf.geo())).find(x => x.name === name);
    let totalHits = 0;
    for (const g0 of geo) {
      console.log(`${g0.role} ${g0.name} R=${g0.r}: motifs ${g0.motifs.map(m => m.kind).join(',')}`);
      console.log(`   pads: ${g0.pads.map(p => p.kind + ':' + p.name).join(', ')}`);
      console.log(`   nets: ${g0.networks.map(n => `${n.name}[${n.kind} ${n.chambers.length}c ${n.links.length}l ${n.mouths.length}m: ${n.chambers.map(c => c.kind[0] + c.r.toFixed(0) + ':' + c.content).join(',')}]`).join(' | ')}; problems ${g0.problems.length} ${g0.problems.join(' / ')}`);
      console.log(`   placed: ${g0.placed.join('; ')}`);
      let G = await refresh(g0.name);
      const colony = G.pads.find(p => p.kind === 'colony') ?? G.pads[0];
      const a = Math.atan2(colony.y - G.y, colony.x - G.x);
      await page.evaluate(([x, y, vx, vy, a]) => window.__sf.teleport(x, y, vx, vy, a), [G.x + Math.cos(a) * (G.r + 42), G.y + Math.sin(a) * (G.r + 42), G.vx, G.vy, a]);
      await api.shot(page, `planet_${g0.role}_colony`, 40);
      const net = G.networks.slice().sort((p, q) => q.chambers.length - p.chambers.length)[0];
      if (!net || !net.chambers.length) continue;
      const mouthA = net.mouths[0] + G.spin;
      const e0 = net.entry[0];
      const c0 = Math.cos(G.spin), s0 = Math.sin(G.spin);
      const ex = G.x + e0.x * c0 - e0.y * s0, ey = G.y + e0.x * s0 + e0.y * c0;
      await page.evaluate(([x, y, vx, vy, a]) => window.__sf.teleport(x, y, vx, vy, a), [ex + Math.cos(mouthA) * 14, ey + Math.sin(mouthA) * 14, G.vx, G.vy, mouthA]);
      await page.evaluate(() => window.__sf.ping());
      await api.run(page, {}, 1.0);
      await api.shot(page, `planet_${g0.role}_mouth`, 5);
      // a route: breadth first over the links from the entry chamber, walking back along the tree between branches
      const byId = new Map(net.chambers.map(c => [c.id, c]));
      const adj = new Map(net.chambers.map(c => [c.id, []]));
      for (const l of net.links) { adj.get(l.a).push(l); adj.get(l.b).push(l); }
      const seen = new Set();
      const route = [];
      const walk = id => {
        seen.add(id); route.push(byId.get(id).local);
        for (const l of adj.get(id)) {
          const o = l.a === id ? l.b : l.a;
          if (seen.has(o) || l.blocked) continue;
          for (const q of (l.a === id ? l.pts : l.pts.slice().reverse())) route.push(q.local);
          walk(o);
          for (const q of (l.a === id ? l.pts.slice().reverse() : l.pts)) route.push(q.local);
          route.push(byId.get(id).local);
        }
      };
      walk(net.chambers[0].id);
      const path = [{ x: e0.x + Math.cos(net.mouths[0]) * 14, y: e0.y + Math.sin(net.mouths[0]) * 14 }, ...net.entry, ...route];
      const t0 = (await api.state(page)).time;
      const res = await follow(page, path, { seconds: 240, tol: 3.0, maxSpeed: speed, gain: 2.4, body: G.name });
      const st = await api.state(page);
      console.log(`   ${net.name}: ${net.chambers.length} chambers, route ${path.length} waypoints at ${speed} u/s: reached ${res.reached}/${res.of} alive ${res.alive} hull ${res.hull.toFixed(0)} fuel ${res.fuel.toFixed(0)} in ${(st.time - t0).toFixed(0)} s; frame ${st.frameTime.toFixed(1)} ms; underground ${st.underground}`);
      totalHits += 100 - res.hull;
      if (res.hits && res.hits.length) {
        // where the damage happened: the nearest chamber or link, by world position
        const G2 = await refresh(g0.name);
        const net2 = G2.networks.find(n => n.name === net.name);
        const tally = {};
        for (const h of res.hits) {
          let best = 'outside', bd = 1e9;
          for (const c of net2.chambers) { const d = Math.hypot(c.x - h.x, c.y - h.y) - c.r; if (d < bd) { bd = d; best = `${c.kind} r${c.r.toFixed(0)}`; } }
          for (const l of net2.links) for (let i = 0; i + 1 < l.pts.length; i++) { const a = l.pts[i], b2 = l.pts[i + 1]; const vx = b2.x - a.x, vy = b2.y - a.y; const l2 = vx * vx + vy * vy || 1e-9; let u = ((h.x - a.x) * vx + (h.y - a.y) * vy) / l2; u = Math.max(0, Math.min(1, u)); const d = Math.hypot(h.x - (a.x + vx * u), h.y - (a.y + vy * u)) - l.hw; if (d < bd) { bd = d; best = l.narrow ? `squeeze hw${l.hw.toFixed(1)}` : `passage hw${l.hw.toFixed(1)}`; } }
          const e = net2.entry; for (const q of e) { const d = Math.hypot(q.x - h.x, q.y - h.y) - 8; if (d < bd) { bd = d; best = 'entry'; } }
          tally[best] = (tally[best] ?? 0) + h.dmg;
        }
        console.log('   damage by place:', Object.entries(tally).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', '));
      }
      if (res.reached < res.of) console.log('   ', JSON.stringify(res.log.slice(-3)));
      await api.shot(page, `planet_${g0.role}_inside`, 30);
      // the biggest chamber, from its centre
      G = await refresh(g0.name);
      const hall = G.networks.flatMap(n => n.chambers).sort((p, q) => q.r - p.r)[0];
      if (hall) {
        await page.evaluate(([x, y, vx, vy]) => window.__sf.teleport(x, y, vx, vy, 0), [hall.x, hall.y, G.vx, G.vy]);
        await api.run(page, {}, 0.5);
        await api.shot(page, `planet_${g0.role}_hall`, 30);
      }
      // the sun: day or night side where the flight was
      const sun = await page.evaluate(([x, y]) => window.__sf.sun(x, y), [hall ? hall.x : ex, hall ? hall.y : ey]);
      console.log(`   sunlight at the hall: ${JSON.stringify(sun)}`);
    }
    const rescues = (await page.evaluate(() => window.__sf.log(0))).filter(e => e.kind === 'wall-rescue');
    console.log('wall rescues during the tour:', rescues.length, rescues.map(r => `${r.t}s ${r.text}`).join(', '));
  },

  async tow({ page }) {
    // towing room: latch a rubble rock in a chamber and fly it out of the complex along the route at five units a second
    await api.manual(page, true);
    const seed = Number(process.env.PLANET_SEED ?? 2024);
    await api.newGame(page, seed);
    await api.launch(page);
    const geo = await page.evaluate(() => window.__sf.geo());
    for (const g0 of geo) {
      const G = (await page.evaluate(() => window.__sf.geo())).find(x => x.name === g0.name);
      const net = G.networks.filter(n => n.chambers.some(c => c.content === 'rubble' || c.content === 'workings')).sort((p, q) => q.chambers.length - p.chambers.length)[0];
      if (!net) { console.log(`${g0.role} ${g0.name}: no rubble to tow`); continue; }
      const ch = net.chambers.find(c => c.content === 'rubble' || c.content === 'workings');
      // the rock nearest the chamber centre
      const rock = await page.evaluate(([x, y]) => { const w = window.__sf.game.world; let best = null, bd = 1e9; for (const a of w.asteroids) { if (!a.alive) continue; const d = Math.hypot(a.pos.x - x, a.pos.y - y); if (d < bd) { bd = d; best = { x: a.pos.x, y: a.pos.y, r: a.radius, size: a.size, d }; } } return best; }, [ch.x, ch.y]);
      if (!rock || rock.d > ch.r + 4) { console.log(`${g0.role} ${g0.name}: no rock near ${ch.kind} ${ch.content}`); continue; }
      // sit beside the rock, latch, then follow the route back to the mouth and out
      await page.evaluate(([x, y, vx, vy]) => window.__sf.teleport(x, y, vx, vy, 0), [rock.x + rock.r + 2.5, rock.y, G.vx, G.vy]);
      await api.run(page, {}, 0.3);
      const latched = await page.evaluate(() => window.__sf.tether());
      // route: from this chamber back to the entry along the link tree, then out through the mouth
      const byId = new Map(net.chambers.map(c => [c.id, c]));
      const adj = new Map(net.chambers.map(c => [c.id, []]));
      for (const l of net.links) { adj.get(l.a).push(l); adj.get(l.b).push(l); }
      const prev = new Map([[net.chambers[0].id, null]]);
      const queue = [net.chambers[0].id];
      while (queue.length) { const id = queue.shift(); for (const l of adj.get(id)) { const o = l.a === id ? l.b : l.a; if (!prev.has(o) && !l.blocked) { prev.set(o, { id, l }); queue.push(o); } } }
      const path = [];
      let cur = ch.id;
      while (cur !== null && prev.has(cur)) { const p = prev.get(cur); path.push(byId.get(cur).local); if (!p) break; for (const q of (p.l.b === cur ? p.l.pts.slice().reverse() : p.l.pts)) path.push(q.local); cur = p.id; }
      const e = net.entry.slice().reverse();
      const m0 = { x: net.entry[0].x + Math.cos(net.mouths[0]) * 16, y: net.entry[0].y + Math.sin(net.mouths[0]) * 16 };
      path.push(...e, m0);
      const t0 = (await api.state(page)).time;
      const res = await follow(page, path, { seconds: 240, tol: 3.2, maxSpeed: 5, gain: 2.2, body: G.name });
      const st = await api.state(page);
      const sl = await page.evaluate(() => window.__sf.slice());
      const out = await page.evaluate(([bx, by, maxR]) => { const p = window.__sf.game.world.player; return Math.hypot(p.pos.x - bx, p.pos.y - by) - maxR; }, [G.x, G.y, G.maxR]);
      const rescues = (await page.evaluate(() => window.__sf.log(0))).filter(e => e.kind === 'wall-rescue').length;
      console.log(`${g0.role} ${g0.name} ${net.name}: latched ${latched} rock size ${rock.size} r ${rock.r.toFixed(1)}; towed ${res.reached}/${res.of} waypoints, alive ${res.alive}, hull ${res.hull.toFixed(0)}, still tethered ${res.tethered}, peak tension ${res.peak}, ${(st.time - t0).toFixed(0)} s, now ${out.toFixed(0)} above the rim, underground ${st.underground}, rescues ${rescues}`);
      if (res.reached < res.of) console.log('   ', JSON.stringify(res.log.slice(-4)));
      await api.shot(page, `tow_${g0.role}`, 20);
      void sl;
    }
  },

  async gunpost({ page }) {
    // a gun position under the ground: sit in its chamber and see whether it shoots, cools, and shows up on the map once found
    await api.manual(page, true);
    const seed0 = Number(process.env.PLANET_SEED ?? 2024);
    let found = 0;
    for (let k = 0; k < 8 && found < 2; k++) {
    const seed = seed0 + k;
    await api.newGame(page, seed);
    await api.launch(page);
    const geo = await page.evaluate(() => window.__sf.geo());
    for (const g0 of geo) {
      const G = (await page.evaluate(() => window.__sf.geo())).find(x => x.name === g0.name);
      for (const net of G.networks) for (const ch of net.chambers) {
        if (ch.content !== 'gun' && ch.content !== 'dead') continue;
        found++;
        await page.evaluate(([x, y, vx, vy]) => window.__sf.teleport(x, y, vx, vy, 0), [ch.x, ch.y, G.vx, G.vy]);
        const before = (await api.state(page)).player.hull;
        // hover in the middle of the chamber for ten seconds (the follower holds against gravity)
        const res = await follow(page, [ch.local, { x: ch.local.x + 0.01, y: ch.local.y }], { seconds: 10, tol: 0.001, maxSpeed: 2, gain: 3, body: G.name });
        const st = await api.state(page);
        const info = await page.evaluate(([x, y]) => {
          const w = window.__sf.game.world;
          const near = w.ships.filter(s => s.alive && s.kind === 'sentinel').map(s => ({ home: s.ai && s.ai.home ? s.ai.home.name : null, heat: s.heat.toFixed(2), jam: s.overheated, target: s.ai && s.ai.target ? s.ai.target.kind : null, d: Math.hypot(s.pos.x - x, s.pos.y - y).toFixed(1), landed: !!s.landed })).filter(q => Number(q.d) < 60);
          const posts = w.pads.filter(p => p.interior).map(p => ({ name: p.name, alive: p.alive, guns: p.guns, discovered: w.discovered.has(p.name), powered: window.__sf.game.world.power.find(s => s.name === p.name)?.powered ?? null }));
          return { near, posts, shots: w.projectiles.length };
        }, [ch.x, ch.y]);
        const bySrc = {}; for (const h of res.hits || []) bySrc[h.src] = (bySrc[h.src] ?? 0) + h.dmg;
        console.log(`seed ${seed} ${g0.role} ${g0.name} ${net.name} ${ch.kind} r${ch.r.toFixed(0)} ${ch.content}: hull ${before.toFixed(0)} -> ${st.player.hull.toFixed(0)} in 10 s (${Object.entries(bySrc).map(([k, v]) => k + ' ' + v.toFixed(0)).join(', ') || 'no damage'}); sentinels near ${JSON.stringify(info.near)}; posts ${JSON.stringify(info.posts)}; underground ${st.underground}`);
        await api.shot(page, `gunpost_${g0.role}_${ch.content}`, 20);
      }
    }
    }
    if (!found) console.log('no gun position in these seeds');
  },

  async jump({ page }) {
    // the sector slice, end to end: buy the drive, pick the star, climb out, charge, jump, coast in, dock, trade, jump home
    await api.manual(page, true);
    const seed = Number(process.env.PLANET_SEED ?? 2024);
    await api.newGame(page, seed);
    await api.launch(page);
    let st = await api.state(page);
    console.log(`home: ${st.system}, credits ${st.credits}`);
    // the chart before a drive is fitted
    await api.mode(page, 'map');
    await api.press(page, 'KeyV');
    await api.shot(page, 'jump_chart_nodrive', 10);
    await api.press(page, 'KeyV');
    await api.mode(page, 'flight');
    // fit the drive and aim it
    await page.evaluate(() => { window.__sf.game.world.credits += 2000; window.__sf.drive('ember'); });
    await api.mode(page, 'map');
    await api.press(page, 'KeyV');
    await api.shot(page, 'jump_chart', 10);
    await api.press(page, 'KeyV');
    await api.mode(page, 'flight');
    // climb out of the well from the harbour: full thrust along the bearing, measure how long the gate takes to open
    let chk = await page.evaluate(() => window.__sf.driveCheck());
    console.log(`at the harbour: ${chk.reason}, well ${chk.gravity.toFixed(4)}, bearing ${(chk.bearing * 57.3).toFixed(0)} deg, fuel needed ${chk.fuelNeeded}`);
    // clear the harbour first (turning at the gap drives you straight back into the hub), then nose onto the bearing
    await api.run(page, { thrust: 1 }, 5);
    await page.evaluate(([a]) => { const p = window.__sf.game.world.player; p.angle = a; }, [chk.bearing]);
    const t0 = (await api.state(page)).time;
    let opened = -1;
    for (let sec = 0; sec < 240; sec += 2) {
      await api.run(page, { thrust: 1, boost: sec < 30 }, 2);
      await page.evaluate(([a]) => { const p = window.__sf.game.world.player; p.angle = a; p.angVel = 0; }, [chk.bearing]);
      chk = await page.evaluate(() => window.__sf.driveCheck());
      if (chk.gravity <= 0.02 && opened < 0) { opened = (await api.state(page)).time - t0; break; }
    }
    st = await api.state(page);
    console.log(`well gate opened after ${opened.toFixed(0)} s of climbing (boost for the first 30): ${chk.reason}, fuel ${st.player.fuel.toFixed(0)}`);
    console.log('   where:', JSON.stringify(await page.evaluate(() => { const w = window.__sf.game.world, p = w.player; const home = w.stations[0].orbit ? w.stations[0].orbit.parent : null; const slip = w.bodies.find(b => b.name === 'THE SLIPWAY'); return { docked: p.docked ? p.docked.name : null, landed: p.landed ? p.landed.body.name : null, alive: p.alive, hull: p.hull, speed: Math.hypot(p.vel.x, p.vel.y), toHome: home ? Math.hypot(p.pos.x - home.pos.x, p.pos.y - home.pos.y) : null, toSlipway: slip ? Math.hypot(p.pos.x - slip.pos.x, p.pos.y - slip.pos.y) : null, toStar: Math.hypot(p.pos.x - w.star.pos.x, p.pos.y - w.star.pos.y), mode: window.__sf.game.mode, override: !!window.__sf.game.input.override }; })));
    await api.run(page, {}, 0.5);
    await api.shot(page, 'jump_ready', 10);
    // charge, loud and hot, and watch who notices
    const sigBefore = await page.evaluate(() => window.__sf.signature());
    await page.evaluate(() => window.__sf.charge(true));
    await api.run(page, {}, 4);
    const sigDuring = await page.evaluate(() => window.__sf.signature());
    const heatDuring = (await api.state(page)).player.heat;
    await api.shot(page, 'jump_charging', 5);
    await api.run(page, {}, 5);
    await page.evaluate(() => window.__sf.charge(false));
    st = await api.state(page);
    console.log(`signature ${sigBefore.toFixed(2)} -> ${sigDuring.toFixed(2)} while charging, heat ${heatDuring.toFixed(2)}; now in ${st.system}, sector time ${st.sectorTime.toFixed(0)}`);
    if (st.system !== 'ember') { console.log('DID NOT JUMP:', JSON.stringify(await page.evaluate(() => window.__sf.driveCheck()))); return; }
    await api.shot(page, 'jump_arrival', 20);
    const arrive = await page.evaluate(() => { const w = window.__sf.game.world, p = w.player; return { dist: Math.hypot(p.pos.x - w.star.pos.x, p.pos.y - w.star.pos.y), speed: Math.hypot(p.vel.x, p.vel.y), systemRadius: w.systemRadius, star: w.star.name, worlds: w.bodies.filter(b => b.kind === 'planet').map(b => b.name), port: w.stations[0].name, fuel: p.fuel }; });
    console.log(`arrived at ${arrive.star}: ${arrive.dist.toFixed(0)} units out (system radius ${arrive.systemRadius.toFixed(0)}), ${arrive.speed.toFixed(0)} u/s inward, fuel ${arrive.fuel.toFixed(0)}; worlds ${arrive.worlds.join(', ')}; port ${arrive.port}`);
    // the coast in: how long to the port at arrival speed, and with boost
    console.log(`   coast to the port at ${arrive.speed.toFixed(0)} u/s: about ${(arrive.dist / arrive.speed / 60).toFixed(1)} min; boosting at 135: about ${(arrive.dist / 135 / 60).toFixed(1)} min`);
    await api.mode(page, 'map');
    await api.shot(page, 'jump_ember_map', 10);
    await api.press(page, 'KeyV');
    await api.shot(page, 'jump_chart_ember', 10);
    await api.press(page, 'KeyV');
    await api.mode(page, 'flight');
    // to the port: teleport alongside and dock
    const portPos = await page.evaluate(() => { const st = window.__sf.game.world.stations[0]; return { x: st.pos.x, y: st.pos.y, vx: st.vel.x, vy: st.vel.y, name: st.name }; });
    await page.evaluate(([x, y, vx, vy]) => window.__sf.teleport(x + 60, y, vx, vy, Math.PI), [portPos.x, portPos.y, portPos.vx, portPos.vy]);
    const dockRes = await autoDock(page, portPos.name, 90);
    st = await api.state(page);
    console.log(`docked at the port: ${st.mode === 'docked'} (${JSON.stringify(dockRes).slice(0, 120)})`);
    if (st.mode === 'docked') {
      const market = await page.evaluate(([n]) => window.__sf.market(n), [portPos.name]);
      console.log('   port market:', JSON.stringify(market));
      await api.shot(page, 'jump_port_dock', 10);
      // buy ore here, and remember what home pays
      const bought = await page.evaluate(([n]) => { const w = window.__sf.game.world, st = w.stations.find(s => s.name === n), p = w.player; const before = w.credits; let n0 = 0; for (let i = 0; i < 4; i++) { const e = st.market.ore; if (e.stock > 0) { w.credits -= Math.max(1, Math.round(e.base * Math.min(1.9, Math.max(0.55, 1.5 - e.stock / (2 * e.baseStock))))); e.stock--; p.cargo.ore++; n0++; } } return { n: n0, spent: before - w.credits, ore: p.cargo.ore }; }, [portPos.name]);
      console.log(`   bought ${bought.n} ore for ${bought.spent} cr; cargo ore ${bought.ore}`);
      console.log('   prices seen:', JSON.stringify(await page.evaluate(() => window.__sf.prices())));
      await api.launch(page);
    }
    // home again: the ledger and the refinery
    await page.evaluate(() => { window.__sf.drive('home'); const p = window.__sf.game.world.player; p.fuel = p.fuelMax; });
    chk = await page.evaluate(() => window.__sf.driveCheck());
    const park = await page.evaluate(([bearing]) => { const w = window.__sf.game.world, p = w.player; const sf = window.__sf; for (let r = w.systemRadius * 0.5; r < w.systemRadius * 0.95; r += 60) for (let k = 0; k < 24; k++) { const a = k / 24 * Math.PI * 2; const x = w.star.pos.x + Math.cos(a) * r, y = w.star.pos.y + Math.sin(a) * r; const g = sf.gravity(x, y); if (Math.hypot(g[0], g[1]) < 0.01 && w.bodies.every(b => Math.hypot(x - b.pos.x, y - b.pos.y) > b.soi + 50)) { sf.teleport(x, y, 0, 0, bearing); return true; } } return false; }, [chk.bearing]);
    await page.evaluate(() => window.__sf.charge(true));
    await api.run(page, {}, 9.5);
    await page.evaluate(() => window.__sf.charge(false));
    st = await api.state(page);
    console.log(`parked ${park}; back in ${st.system}; sector time ${st.sectorTime.toFixed(0)}; ledgers: ${JSON.stringify((await page.evaluate(() => window.__sf.sector())).ledgers.ember).slice(0, 200)}`);
    await api.shot(page, 'jump_home_again', 20);
    const saved = await page.evaluate(() => { try { return localStorage.getItem('starfall.run') !== null; } catch { return false; } });
    console.log('run saved on arrival:', saved);
    // the saved run continues: a fresh game, then F2's path
    const before = await page.evaluate(() => { const w = window.__sf.game.world; return { credits: w.credits, ore: w.player.cargo.ore, journal: w.journal.length, upgrades: w.player.upgrades.length }; });
    await api.newGame(page, 99);
    const loaded = await page.evaluate(() => window.__sf.loadRun());
    st = await api.state(page);
    const after = await page.evaluate(() => { const w = window.__sf.game.world; return { credits: w.credits, ore: w.player.cargo.ore, journal: w.journal.length, upgrades: w.player.upgrades.length, docked: w.player.docked ? w.player.docked.name : null }; });
    console.log(`continued: ${loaded}; system ${st.system}; before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    await api.shot(page, 'jump_continued', 20);
  },

  async earn({ page }) {
    // a pilot who knows the game, from a fresh start: how long to the first jump drive, and where the credits came from
    await api.manual(page, true);
    const seed = Number(process.env.PLANET_SEED ?? 2024);
    const limitMin = Number(process.env.EARN_MINUTES ?? 30);
    const fights = process.env.EARN_FIGHT === '1';
    await api.newGame(page, seed);
    const price = await page.evaluate(() => window.__sf.drivePrice());
    await page.evaluate(() => window.__sf.setLives(9)); // test instrumentation: game over would truncate the measurement
    const income = {};
    let lastCredits = 0;
    const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const seenComms = new Set();
    const mark = async (note, source) => {
      const st = await api.state(page);
      for (const c of st.comms) { if (!seenComms.has(c)) { seenComms.add(c); if (/\+\d+ CR/.test(c)) console.log(`   comm: ${c}`); } }
      const d = Math.round(st.credits - lastCredits);
      if (source && d !== 0) income[source] = (income[source] ?? 0) + d;
      lastCredits = st.credits;
      console.log(`t=${String(Math.round(st.time)).padStart(4)}s  cr ${String(Math.round(st.credits)).padStart(5)} (${d >= 0 ? '+' : ''}${d})  hull ${st.player.hull.toFixed(0)} fuel ${st.player.fuel.toFixed(0)} cargo ${st.player.cargo.ore}/${st.player.cargo.salvage}  :: ${note}`);
      return st;
    };
    const harbourName = (await api.state(page)).stations.find(s => s.kind === 'harbour').name;
    let kills = 0;
    const harbour = s => s.stations.find(q => q.name === harbourName);
    // obstacles: worlds, hulls and stations, each with a keep-out radius
    const obstacles = s => [
      ...s.bodies.filter(b => b.kind !== 'star').map(b => ({ x: b.x, y: b.y, R: b.kind === 'hull' ? b.r + 60 : b.r * 1.4 + 50 })),
      ...s.stations.map(q => ({ x: q.x, y: q.y, R: q.r * 3 + 25 })),
    ];
    // a leg: step out of anything we are inside, detour round the first thing the line crosses, then the target
    const plan = (s, from, to, keepOut = null) => {
      const obs = obstacles(s).filter(o => !keepOut || near(o, keepOut) > 1);
      const pts = [];
      let cur = { x: from.x, y: from.y };
      for (const o of obs) { const d = near(o, cur); if (d < o.R && d > 1e-6) { cur = { x: o.x + (cur.x - o.x) / d * (o.R + 5), y: o.y + (cur.y - o.y) / d * (o.R + 5) }; pts.push(cur); } }
      let best = null;
      for (const o of obs) {
        const vx = to.x - cur.x, vy = to.y - cur.y, l2 = vx * vx + vy * vy || 1e-9;
        const t = Math.max(0, Math.min(1, ((o.x - cur.x) * vx + (o.y - cur.y) * vy) / l2));
        const px = cur.x + vx * t, py = cur.y + vy * t;
        if (Math.hypot(px - o.x, py - o.y) < o.R && t > 0.02 && t < 0.98 && (!best || t < best.t)) best = { o, t, px, py };
      }
      if (best) { let nx = best.px - best.o.x, ny = best.py - best.o.y, nl = Math.hypot(nx, ny); if (nl < 1) { nx = -(to.y - cur.y); ny = to.x - cur.x; nl = Math.hypot(nx, ny) || 1; } pts.push({ x: best.o.x + nx / nl * best.o.R, y: best.o.y + ny / nl * best.o.R }); }
      pts.push({ x: to.x, y: to.y });
      return pts;
    };
    // cruise toward a moving target, replanning every couple of seconds
    const cruise = async (getTarget, tol, speed, seconds, keepOut = null) => {
      const t0 = (await api.state(page)).time;
      for (;;) {
        const s = await stateWithLoot();
        if (!s.player.alive || s.time - t0 > seconds || s.flare.active || s.flare.warned) return false;
        const tg = getTarget(s);
        if (!tg) return false;
        if (near(tg, s.player) < tol) return true;
        const pts = plan(s, s.player, tg, keepOut ? keepOut(s) : null);
        const res = await follow(page, pts, { seconds: 2, tol, maxSpeed: speed, gain: 2.2, refVel: { x: tg.vx ?? 0, y: tg.vy ?? 0 }, avoid: true });
        if (res.hits.some(h => h.src === 'weapon') && res.hull >= 50) {
          const e = await wasps(s);
          if (e.onlyWasps) { const k0 = s.kills; const f = await autoFight(page, 40, 40); const q2 = await api.state(page); kills += q2.kills - k0; if (q2.kills - k0) await mark(`shot down ${q2.kills - k0} wasp${q2.kills - k0 > 1 ? 's' : ''} that harried us`, 'bounties and rewards'); continue; }
        }
        if (res.hits.length) console.log(`   hit on a cruise leg: ${res.hits.map(h => `-${h.dmg.toFixed(1)} ${h.src} wp${h.wp}`).join(' ')} from (${s.player.x.toFixed(0)},${s.player.y.toFixed(0)}) v(${s.player.vx.toFixed(0)},${s.player.vy.toFixed(0)}) via ${pts.map(q => `(${q.x.toFixed(0)},${q.y.toFixed(0)})`).join(' ')} :: ${JSON.stringify(await page.evaluate(() => window.__sf.surroundings()))}`);
      }
    };
    // out of the bay and away from the world, not into the rubble ring below the harbour
    const leaveHarbour = async () => {
      await api.launch(page);
      await api.run(page, { thrust: 0.8 }, 1.2);
      await cruise(q => { const h = harbour(q); const star = q.bodies.find(b => b.kind === 'star'); let home = null, bd = 1e9; for (const b of q.bodies) { if (b.kind === 'star' || b.kind === 'hull') continue; const d = near(b, h); if (d < bd) { bd = d; home = b; } } const d = near(home, h) || 1; return { x: h.x + (h.x - home.x) / d * 80, y: h.y + (h.y - home.y) / d * 80, vx: h.vx, vy: h.vy }; }, 20, 18, 40, q => harbour(q));
    };
    const wasps = async (q) => { const kinds = await page.evaluate(([x, y]) => window.__sf.enemyKindsNear(x, y, 260), [q.player.x, q.player.y]); return { any: kinds.length > 0, onlyWasps: kinds.length > 0 && kinds.every(k => k === 'wasp') }; };
    const dockAtHarbour = async () => {
      let s = await api.state(page);
      if (s.mode === 'docked') return true;
      if (s.player.landed) await climb(page, 70, 20, 60);
      // a standoff point five radii out on our side, at a modest speed, then the docking run
      await cruise(q => { const h = harbour(q); const d = near(h, q.player) || 1; return { x: h.x + (q.player.x - h.x) / d * h.r * 5, y: h.y + (q.player.y - h.y) / d * h.r * 5, vx: h.vx, vy: h.vy }; }, 14, 32, 240, q => harbour(q));
      await autoDock(page, harbourName, 150);
      s = await api.state(page);
      return s.mode === 'docked';
    };
    const service = async () => {
      const sold = await page.evaluate(() => ({ ore: window.__sf.sell('ore'), salvage: window.__sf.sell('salvage') }));
      if (sold.ore) await mark(`sold ore for ${sold.ore}`, 'ore sold');
      if (sold.salvage) await mark(`sold salvage for ${sold.salvage}`, 'salvage sold');
      const s1 = await api.state(page);
      if (s1.player.fuel < 75) { const c = await page.evaluate(() => window.__sf.buyFuel()); if (c) await mark(`refuelled for ${c}`, 'fuel'); }
      if (s1.player.hull < 100) { const c = await page.evaluate(() => window.__sf.buyRepair()); if (c) await mark(`repaired for ${c}`, 'repairs'); }
    };
    const lootNear = async (s, r) => page.evaluate(([x, y, r]) => window.__sf.loot(x, y, r), [s.player.x, s.player.y, r]);
    const stateWithLoot = async () => { const q = await api.state(page); q.loot = await lootNear(q, 1600); return q; };
    let st = await mark('fresh game, docked at the harbour', null);
    let bought = false, deaths = 0, phases = 0;
    const emptyMarkers = new Set();
    const postMortem = async () => JSON.stringify(await page.evaluate(() => window.__sf.surroundings()));
    await leaveHarbour();
    while (!bought && phases++ < 80) {
      st = await api.state(page);
      if (st.time / 60 > limitMin || st.gameOver) break;
      if (!st.player.alive) { deaths++; await mark(`KESTREL LOST (${st.player.lastDamageSource}) ${await postMortem()}`, null); await api.run(page, {}, 6); continue; }
      if (st.mode === 'docked') {
        await service();
        st = await api.state(page);
        if (st.credits >= price && st.player.docked === harbourName) { bought = await page.evaluate(() => window.__sf.buy('drive')); await mark('BOUGHT THE JUMP DRIVE', 'drive'); break; }
        await leaveHarbour();
        st = await api.state(page);
      }
      const tStart = st.time, creditsStart = st.credits;
      const room = st.player.cargo.capacity - st.player.cargo.ore - st.player.cargo.salvage;
      const active = st.events.filter(e => !e.resolved && !e.failed);
      const pieces = await lootNear(st, 1600);
      const fight = fights && st.player.hull >= 75 ? active.find(e => (e.kind === 'raid' || e.kind === 'convoy' || e.kind === 'hunt') && near(e, st.player) < 3000) : null;
      const stranded = active.find(e => e.kind === 'stranded' && e.target && e.target.alive && near(e.target, st.player) < 3000);
      const salvageEvent = active.find(e => e.kind === 'salvage' && near(e, st.player) < 2500 && !emptyMarkers.has(e.id));
      const threatened = await page.evaluate(([x, y]) => window.__sf.enemiesNear(x, y, 220), [st.player.x, st.player.y]);
      if (phases === 1 && !salvageEvent) {
        // the opening beat: CONTROL calls a debris field within half a minute of launch
        for (let k = 0; k < 8; k++) { const q = await api.state(page); if (q.events.some(e => e.kind === 'salvage' && !e.resolved)) break; await api.run(page, {}, 4); }
        continue;
      }
      if (st.flare.active || st.flare.warned) {
        // a flare: into the shadow of the nearest world and wait it out
        const shelter = q => { const star = q.bodies.find(b => b.kind === 'star'); let best = null, bd = 1e9; for (const b of q.bodies) { if (b.kind === 'star' || b.kind === 'hull') continue; const d = near(b, q.player); if (d < bd) { bd = d; best = b; } } const dx = best.x - star.x, dy = best.y - star.y, l = Math.hypot(dx, dy) || 1; const R = best.r * 1.6 + 20; return { x: best.x + dx / l * R, y: best.y + dy / l * R, vx: best.vx, vy: best.vy }; };
        await mark('flare called: running for shadow', null);
        const t0 = st.time;
        for (let k = 0; k < 60; k++) {
          const q = await stateWithLoot();
          if (!q.player.alive || (!q.flare.active && !q.flare.warned) || q.time - t0 > 200) break;
          const tg = shelter(q);
          if (near(tg, q.player) < 14) { await api.run(page, {}, 3); continue; }
          const fr = await follow(page, plan(q, q.player, tg), { seconds: 3, tol: 12, maxSpeed: 40, gain: 2.4, refVel: { x: tg.vx, y: tg.vy }, avoid: true });
          if (k < 3 || fr.ticks < 300) console.log(`   shelter leg ${k}: flare ${JSON.stringify(q.flare)} mode ${q.mode} landed ${!!q.player.landed} docked ${q.player.docked} ticks ${fr.ticks} reached ${fr.reached}/${fr.of} alive ${fr.alive} d ${near(tg, q.player).toFixed(0)}`);
        }
        await mark('flare over', null);
        continue;
      }
      if (threatened && !fight) {
        const e = await wasps(st);
        if (e.onlyWasps && st.player.hull >= 50) {
          const k0 = st.kills;
          await autoFight(page, 45, 40);
          const q2 = await api.state(page);
          kills += q2.kills - k0;
          await mark(`wasps at the door: ${q2.kills - k0} shot down`, 'bounties and rewards');
          continue;
        }
        // outgunned or hurt: back to the harbour's guns
        await mark(`enemies close (${threatened}): running for the harbour`, null);
        const ok = await dockAtHarbour();
        if (!ok) await mark(`could not dock ${await postMortem()}`, null);
        continue;
      }
      if (pieces.length && room > 0) {
        // fly to the nearest loose piece, then sweep the field
        let got = 0, fuel = 0;
        for (let k = 0; k < 4; k++) {
          const s = await api.state(page);
          const list = await lootNear(s, 1600);
          if (!list.length || s.player.cargo.ore + s.player.cargo.salvage >= s.player.cargo.capacity) break;
          // the nearest loose piece, re-chosen every leg as the field drifts
          let latest = null;
          await cruise(q => { const l = q.loot; if (!l || !l.length) return null; l.sort((a, b) => near(a, q.player) - near(b, q.player)); latest = l[0]; return latest; }, 60, 28, 90);
          const res = await chase(page, 400, 14, 75);
          got += res.got; fuel += res.fuel;
          if (res.hits.length) console.log('   hits while collecting:', res.hits.slice(0, 4).map(h => `${h.t}s -${h.dmg} ${h.src} ${JSON.stringify(h.near)}`).join(' | '));
          if (!res.alive) break;
        }
        await mark(`debris: picked up ${got} pieces${fuel > 0 ? `, ${fuel.toFixed(0)} fuel` : ''}`, null);
      } else if (salvageEvent && room > 0) {
        await cruise(q => { const e = q.events.find(e => e.id === salvageEvent.id && !e.resolved && !e.failed); return e ? { x: e.x, y: e.y } : null; }, 120, 35, 120);
        const s5 = await api.state(page);
        if (!(await lootNear(s5, 1600)).length) { emptyMarkers.add(salvageEvent.id); await mark('reached the debris marker: nothing loose left', null); }
      } else if (stranded) {
        await cruise(q => { const e = q.events.find(e => e.kind === 'stranded' && !e.resolved && !e.failed); return e && e.target && e.target.alive ? { x: e.target.x, y: e.target.y } : null; }, 5, 30, 150);
        await page.evaluate(() => window.__sf.transfer(true));
        await api.run(page, {}, 6);
        await page.evaluate(() => window.__sf.transfer(false));
        await api.run(page, {}, 3);
        await mark('stranded shuttle refuelled', 'rescue reward');
      } else if (fight) {
        const k0 = st.kills;
        await cruise(q => { const e = q.events.find(e => e.kind === fight.kind && !e.resolved && !e.failed); return e ? { x: e.x, y: e.y } : null; }, 120, 45, 120);
        const res = await autoFight(page, 90, 45);
        const s2 = await api.state(page);
        kills += s2.kills - k0;
        await mark(`${fight.kind}: ${s2.kills - k0} kills`, 'bounties and rewards');
        if (s2.player.alive) { const got = await chase(page, 250, 14, 40); if (got.got) await mark(`picked up ${got.got} pieces after the fight`, null); }
      } else if (room >= 3) {
        const mines = st.pads.filter(p => p.kind === 'mine' && p.alive && p.stock >= 3);
        const withPos = mines.map(m => { const b = st.bodies.find(q => q.name === m.body); return { m, b, d: b ? near(b, st.player) : 1e9 }; }).filter(q => q.d < 6000).sort((a, b) => a.d - b.d);
        if (!withPos.length) { await api.run(page, {}, 20); await mark('nothing to do: waiting', null); continue; }
        const { m, b } = withPos[0];
        await cruise(q => { const bb = q.bodies.find(z => z.name === b.name); const d = near(bb, q.player) || 1; return { x: bb.x + (q.player.x - bb.x) / d * (bb.r * 1.6 + 100), y: bb.y + (q.player.y - bb.y) / d * (bb.r * 1.6 + 100), vx: bb.vx, vy: bb.vy }; }, 30, 45, 200, q => q.bodies.find(z => z.name === b.name));
        const res = await autoLand(page, b.name, m.name, 150);
        if (res.landed) {
          for (let k = 0; k < 12; k++) { await api.run(page, {}, 3); const s3 = await api.state(page); const pad = s3.pads.find(q => q.name === m.name); if (!pad || pad.stock <= 0 || s3.player.cargo.ore >= s3.player.cargo.capacity) break; }
          await mark(`landed at ${m.name} on ${b.name}, loaded ore`, null);
          const c = await climb(page, 70, 20, 60);
          if (!c.alive) { await mark('lost on the climb', null); continue; }
        } else { await mark(`could not land at ${m.name} (${res.alive ? 'stuck' : 'died'})`, null); if (res.hits.length) console.log('   landing hits:', res.hits.slice(-4).map(h => `${h.t}s alt ${h.alt} -${h.dmg} ${h.src} ${h.near}`).join(' | ')); console.log('   lander log tail:', JSON.stringify(res.log.slice(-3))); }
      } else {
        await api.run(page, {}, 10);
      }
      const s4 = await api.state(page);
      if (!s4.player.alive) continue;
      if (s4.credits !== creditsStart) await mark('rewards came in during the phase', 'bounties and rewards');
      if (s4.time - tStart < 3) await api.run(page, {}, 3);
      const cargo = s4.player.cargo.ore + s4.player.cargo.salvage;
      const needDock = cargo >= 5 || s4.player.fuel < 35 || s4.player.hull < 65 || s4.credits >= price || (cargo > 0 && !(await lootNear(s4, 1600)).length && !s4.events.some(e => !e.resolved && !e.failed && e.kind === 'salvage' && near(e, s4.player) < 2500));
      if (needDock) { const ok = await dockAtHarbour(); if (!ok) await mark(`could not dock ${await postMortem()}`, null); }
    }
    st = await api.state(page);
    console.log(`RESULT seed ${seed}: drive ${bought ? 'BOUGHT' : 'NOT bought'} after ${(st.time / 60).toFixed(1)} min of play; credits ${Math.round(st.credits)}; deaths ${deaths}; kills ${kills}; income by source ${JSON.stringify(income)}`);
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
    console.log('LAND stern main:', res.landed ? 'OK' : (res.alive ? 'NOT LANDED' : 'DEAD'), 'hull', res.hull.toFixed(0), 'player fuel', res.fuel.toFixed(0), 'cause', (await api.state(page)).player.lastDamageSource, 'hostiles near', (await api.state(page)).ships.filter(s => s.faction === 'enemy' && Math.hypot(s.x - sl.pilgrim.x, s.y - sl.pilgrim.y) < 400).map(s => s.kind + ':' + s.mode).join(','));
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
    // the box swings through the hollow's centre (linear gravity inside a body): go and meet it
    for (let i = 0; i < 3; i++) {
      const bl = await page.evaluate(() => { const w = window.__sf.game.world, b = w.slices.blackBox, r = w.slices.rock; if (!b || !b.alive) return null; const c = Math.cos(-r.spinAngle), s = Math.sin(-r.spinAngle); const dx = b.pos.x - r.pos.x, dy = b.pos.y - r.pos.y; return { x: dx * c - dy * s, y: dx * s + dy * c }; });
      if (!bl) break;
      await follow(page, [bl], { seconds: 12, tol: 1.2, maxSpeed: 3, gain: 2.4, body: 'HOLLOW' });
    }
    let st = await api.state(page);
    sl = await page.evaluate(() => window.__sf.slice());
    console.log('CAVE: reached', inn.reached, '/', inn.of, 'alive', inn.alive, 'hull', inn.hull.toFixed(0), 'box alive', sl.signal.box.alive, 'log line', sl.signal.logLine, 'box dist', sl.signal.box.alive ? Math.hypot(sl.signal.box.x - st.player.x, sl.signal.box.y - st.player.y).toFixed(1) : '-', 'end-of-path dist', Math.hypot(path[path.length - 1].x - st.player.x, path[path.length - 1].y - st.player.y).toFixed(1));
    if (sl.signal.box.alive) { const probe = await page.evaluate(() => { const w = window.__sf.game.world, b = w.slices.blackBox, r = w.slices.rock; const c = Math.cos(-r.spinAngle), s = Math.sin(-r.spinAngle); const dx = b.pos.x - r.pos.x, dy = b.pos.y - r.pos.y; return { boxLocal: { x: (dx * c - dy * s).toFixed(1), y: (dx * s + dy * c).toFixed(1) }, rockSpin: r.spinAngle.toFixed(3), rotates: r.rotates, inFissure: !!w.slices.rock.fissures[0] }; }); console.log('   box probe', JSON.stringify(probe), 'path end local', JSON.stringify(sl.signal.rock.pathLocal[sl.signal.rock.pathLocal.length - 1])); }
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

  // ------------------------------------------------------------------ THE KILN
  // Nothing below is scripted in the game. These are the approaches the design memo proposed, plus a
  // few it did not, tried against the general rules to see which of them the rules actually permit.
  async kiln({ page }) {
    await api.manual(page, true);
    const parts = (process.env.KILN_PARTS || '1,2,3,4,5,6,7,8,9').split(',');
    const P = (n) => parts.includes(n);
    const seed = 2024;
    const bases = async () => page.evaluate(() => window.__sf.bases());
    const sense = async () => page.evaluate(() => window.__sf.sense());
    const kilnOf = async () => (await bases()).find(b => b.name === 'THE KILN');
    /** Put the Kiln's pad at a given sunlight by turning its world (a test tool, not a game feature). */
    const setDay = async (wantSun) => page.evaluate(([wantSun]) => {
      const sf = window.__sf, w = sf.game.world;
      const pad = w.pads.find(p => p.name === 'THE KILN'); const b = pad.body;
      const sunAng = Math.atan2(w.star.pos.y - b.pos.y, w.star.pos.x - b.pos.x);
      // pad world angle = pad.angle + spinAngle; want it at sunAng (day) or sunAng + PI (night) or the terminator
      const want = wantSun === 'day' ? sunAng : wantSun === 'night' ? sunAng + Math.PI : sunAng + Math.PI / 2;
      sf.spinTo(b.name, want - pad.angle);
      sf.step(1);
      return sf.bases().find(q => q.name === 'THE KILN').sun;
    }, [wantSun]);
    /** World point at an arc offset (units along the surface, + = counter-clockwise) and altitude from the Kiln pad. */
    const at = async (arc, alt) => page.evaluate(([arc, alt]) => {
      const sf = window.__sf, w = sf.game.world;
      const pad = w.pads.find(p => p.name === 'THE KILN'); const b = pad.body;
      const a = pad.angle + (b.rotates ? b.spinAngle : 0) + arc / b.radius;
      // altitude above the local terrain, so 'low' really is low
      const seg = b.segments; const la = a - (b.rotates ? b.spinAngle : 0);
      const t = ((la / (2 * Math.PI)) * seg % seg + seg) % seg; const i0 = Math.floor(t);
      const r = b.terrain[i0] + alt;
      return { x: b.pos.x + Math.cos(a) * r, y: b.pos.y + Math.sin(a) * r, vx: b.vel.x, vy: b.vel.y, a, body: b.name };
    }, [arc, alt]);
    const place = async (arc, alt, facing = 'down') => {
      const q = await at(arc, alt);
      await page.evaluate(([x, y, vx, vy, a]) => window.__sf.teleport(x, y, vx, vy, a), [q.x, q.y, q.vx, q.vy, facing === 'down' ? q.a + Math.PI : q.a]);
      return q;
    };
    /** Hover at a Kiln-relative point for a while. engines: 'on' holds position with thrust, 'off' drifts. Samples once a second. */
    const hover = async (arc, alt, seconds, engines = 'on', stopWhenJammed = false) => page.evaluate(([arc, alt, ticks, engines, stopWhenJammed]) => {
      const sf = window.__sf, w = sf.game.world, p = w.player;
      const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
      const pad = w.pads.find(q => q.name === 'THE KILN'); const b = pad.body;
      const samples = []; let shotsAtMe = 0; let hitsOnMe = 0; let lastHull = p.hull;
      for (let t = 0; t < ticks; t++) {
        if (!p.alive) break;
        if (stopWhenJammed && t % 12 === 0) { const gs = w.ships.filter(s => s.alive && s.kind === 'sentinel' && s.ai.home === pad); if (gs.length && gs.every(g => g.overheated)) break; }
        const a = pad.angle + b.spinAngle + arc / b.radius;
        const r = pad.height + alt;
        const wx = b.pos.x + Math.cos(a) * r, wy = b.pos.y + Math.sin(a) * r;
        if (engines === 'on') {
          const [gx, gy] = sf.gravity(p.pos.x, p.pos.y);
          const wantVx = b.vel.x + (wx - p.pos.x) * 0.8, wantVy = b.vel.y + (wy - p.pos.y) * 0.8;
          const ax = (wantVx - p.vel.x) * 2 - gx, ay = (wantVy - p.vel.y) * 2 - gy;
          const am = Math.hypot(ax, ay);
          const heading = Math.atan2(ay, ax), err = wrap(heading - p.angle);
          sf.controls({ turn: Math.max(-1, Math.min(1, err * 4)), thrust: am > 0.3 && Math.abs(err) < 0.45 ? Math.min(1, am / p.stats.thrust) : 0, retro: 0, strafe: 0, fire: false, boost: false });
        } else sf.controls({ turn: 0, thrust: 0, retro: 0, strafe: 0, fire: false, boost: false });
        sf.step(1);
        if (p.hull < lastHull) { hitsOnMe++; lastHull = p.hull; }
        if (t % 120 === 0) {
          const K = sf.bases().find(q => q.name === 'THE KILN');
          const guns = K.guns.map(g => `${g.heat.toFixed(2)}${g.overheated ? 'J' : ''}${g.target ? '*' : ''}`).join('/');
          shotsAtMe = K.guns.reduce((s, g) => s + g.shots, 0);
          const sees = sf.sense().filter(s => s.kind === 'sentinel' && s.d < 400).some(s => s.seesPlayer);
          samples.push({ t: t / 120, guns, sees, shots: shotsAtMe, hull: p.hull.toFixed(0), alt: (Math.hypot(p.pos.x - b.pos.x, p.pos.y - b.pos.y) - pad.height).toFixed(0), sun: K.sun.toFixed(2), rad: K.radiator ? K.radiator.integrity.toFixed(0) : 'x' });
        }
      }
      sf.controls(null);
      return { samples, alive: p.alive, hull: p.hull, hits: hitsOnMe, t: w.time };
    }, [arc, alt, Math.round(seconds * 120), engines, stopWhenJammed]);
    /** Hover above the guns' reach over a surface arc with a rock on the cable, lead the world's turn, let go, and report where it fell. */
    const dropRock = async (arc, size) => {
      const alt = 134;
      // aim: a hovering ship tracks a surface point, so the rock leaves with the surface's angular rate at a
      // larger radius and lands ahead of it. Integrate the fall and pick the release arc that lands on target.
      const lead = await page.evaluate(([arc, alt]) => {
        const sf = window.__sf, w = sf.game.world; const pad = w.pads.find(p => p.name === 'THE KILN'); const b = pad.body;
        const landing = (relArc) => {
          const a0 = pad.angle + b.spinAngle + relArc / b.radius; const r0 = pad.height + alt;
          let x = b.pos.x + Math.cos(a0) * r0, y = b.pos.y + Math.sin(a0) * r0;
          let vx = b.vel.x - Math.sin(a0) * b.spin * r0, vy = b.vel.y + Math.cos(a0) * b.spin * r0; // hover velocity over a turning surface
          let bx = b.pos.x, by = b.pos.y, spin = b.spinAngle;
          const dt = 0.05;
          for (let t = 0; t < 120; t += dt) {
            const [gx, gy] = sf.gravity(x, y); vx += gx * dt; vy += gy * dt; x += vx * dt; y += vy * dt; bx += b.vel.x * dt; by += b.vel.y * dt; spin += b.spin * dt;
            const rr = Math.hypot(x - bx, y - by);
            const ang = Math.atan2(y - by, x - bx);
            const seg = b.segments; const la = ang - spin; const i0 = Math.floor(((la / (2 * Math.PI)) * seg % seg + seg) % seg);
            if (rr <= b.terrain[i0] + 1) { const d = la - pad.angle; return Math.atan2(Math.sin(d), Math.cos(d)) * b.radius; }
          }
          return NaN;
        };
        // secant iteration on the release arc
        let a1 = arc, l1 = landing(a1);
        let a2 = arc - (l1 - arc), l2 = landing(a2);
        for (let i = 0; i < 4 && Math.abs(l2 - arc) > 0.3 && isFinite(l2) && l2 !== l1; i++) { const a3 = a2 - (l2 - arc) * (a2 - a1) / (l2 - l1); a1 = a2; l1 = l2; a2 = a3; l2 = landing(a2); }
        return { arc: a2 - arc, spin: b.spin, predicted: l2 };
      }, [arc, alt]);
      // a moon may be sweeping through this altitude: let it pass first
      const waited = await page.evaluate(([arc, alt]) => {
        const sf = window.__sf, w = sf.game.world; const pad = w.pads.find(p => p.name === 'THE KILN'); const b = pad.body;
        let t = 0;
        const moons = w.bodies.filter(m => m.kind === 'moon' && m.orbit && m.orbit.parent === b);
        const clear = () => {
          for (let dtq = 0; dtq <= 70; dtq += 5) {
            const a = pad.angle + b.spinAngle + b.spin * dtq + arc / b.radius;
            for (let h = 20; h <= alt + 10; h += 30) {
              const hx = Math.cos(a) * (pad.height + h), hy = Math.sin(a) * (pad.height + h); // relative to the world centre
              for (const m of moons) { const ma = m.orbit.phase + m.orbit.angularSpeed * (w.time + dtq); const mx = Math.cos(ma) * m.orbit.radius, my = Math.sin(ma) * m.orbit.radius; if (Math.hypot(mx - hx, my - hy) < m.maxRadius + 60) return false; }
            }
          }
          return true;
        };
        for (; t < 120 * 600; t += 600) { if (clear()) break; sf.step(600); }
        return t / 120;
      }, [arc + lead.arc, alt]);
      const q = await at(arc + lead.arc, alt);
      await page.evaluate(([x, y, vx, vy, a]) => window.__sf.teleport(x, y, vx, vy, a), [q.x, q.y, q.vx, q.vy, q.a]);
      await untether(page);
      await page.evaluate(([ax, ay, size]) => window.__sf.spawnRock(-ax * 9, -ay * 9, size), [Math.cos(q.a), Math.sin(q.a), size]);
      const latched = await page.evaluate(() => window.__sf.tether());
      const hold = await hover(arc + lead.arc, alt, 3, 'on');
      // let the load stop swinging before letting go (release at the bottom of a swing, load still)
      const settle = await page.evaluate(([arc, alt]) => {
        const sf = window.__sf, w = sf.game.world, p = w.player; const pad = w.pads.find(q => q.name === 'THE KILN'); const b = pad.body;
        const wrap = q => Math.atan2(Math.sin(q), Math.cos(q));
        const a0 = w.asteroids.find(x => x.handled);
        let t = 0, rel = 99;
        if (!a0) return { t: 0, rel: -1 };
        for (; t < 120 * 40; t++) {
          const aa = pad.angle + b.spinAngle + arc / b.radius; const wx = b.pos.x + Math.cos(aa) * (pad.height + alt), wy = b.pos.y + Math.sin(aa) * (pad.height + alt);
          const [gx, gy] = sf.gravity(p.pos.x, p.pos.y);
          const svx = b.vel.x - Math.sin(aa) * b.spin * (pad.height + alt), svy = b.vel.y + Math.cos(aa) * b.spin * (pad.height + alt);
          const ax = (svx + (wx - p.pos.x) * 0.25 - p.vel.x) * 1.2 - gx, ay = (svy + (wy - p.pos.y) * 0.25 - p.vel.y) * 1.2 - gy;
          const am = Math.hypot(ax, ay), err = wrap(Math.atan2(ay, ax) - p.angle);
          sf.controls({ turn: Math.max(-1, Math.min(1, err * 4)), thrust: am > 0.3 && Math.abs(err) < 0.45 ? Math.min(1, am / p.stats.thrust) : 0, retro: 0, strafe: 0, fire: false, boost: false });
          sf.step(1);
          rel = Math.hypot(a0.vel.x - p.vel.x, a0.vel.y - p.vel.y);
          if (t > 240 && rel < 0.3) break;
        }
        sf.controls(null);
        return { t: t / 120, rel };
      }, [arc + lead.arc, alt]);
      await untether(page);
      const fall = await page.evaluate(([arc]) => {
        const sf = window.__sf, w = sf.game.world; const a = w.asteroids.find(x => x.handled); const pad = w.pads.find(p => p.name === 'THE KILN'); const b = pad.body;
        if (!a) return { alive: false, rested: false, maxV: 0, t: 0, landedArc: 0, wantArc: arc, log: ['the rock broke up on the cable before release'] };
        let maxV = 0, tEnd = 0;
        for (let t = 0; t < 120 * 45; t++) { sf.step(1); tEnd = t / 120; if (a.alive) maxV = Math.max(maxV, Math.hypot(a.vel.x - b.vel.x, a.vel.y - b.vel.y)); if (!a.alive || a.rested) break; }
        const ang = Math.atan2(a.pos.y - b.pos.y, a.pos.x - b.pos.x) - b.spinAngle - pad.angle;
        const landedArc = Math.atan2(Math.sin(ang), Math.cos(ang)) * b.radius;
        return { alive: a.alive, rested: a.rested, maxV, t: tEnd, landedArc, wantArc: arc, log: w.log.slice(-2).map(e => e.kind + ':' + e.text) };
      }, [arc]);
      return `waited ${waited.toFixed(0)} s for the moon, latched ${latched}, hover hull ${hold.hull.toFixed(0)}, settled in ${settle.t.toFixed(1)} s (load ${settle.rel.toFixed(2)} u/s), release ${lead.arc.toFixed(1)} from target (predicted landing ${lead.predicted.toFixed(1)}), fell ${fall.t.toFixed(1)} s to ${fall.maxV.toFixed(1)} u/s, ${fall.alive ? (fall.rested ? 'RESTS' : 'still moving') : 'SHATTERED'} at arc ${fall.landedArc.toFixed(1)} (wanted ${fall.wantArc}); log ${fall.log.join(' ; ')}`;
    };
    const fmt = (r) => r.samples.map(s => `${s.t}s g[${s.guns}] ${s.sees ? 'SEEN' : 'unseen'} shots${s.shots} hull${s.hull}`).join(' | ');

    await api.newGame(page, seed);
    await api.launch(page);
    await api.step(page, 2);
    let K = await kilnOf();
    console.log('THE KILN on', K.body, 'sun', K.sun.toFixed(2), 'powered', K.powered, 'guns', K.guns.length, 'plant', K.plant && K.plant.integrity, 'radiator', K.radiator && K.radiator.integrity, 'mast', K.mast && K.mast.integrity, 'socket', K.socket && K.socket.core, 'range', K.socket && K.socket.range);
    await place(0, 60);
    await api.shot(page, 'kiln_above', 60);

    // ---- 1. sensing survey: where do the guns see a ship, engines off vs on, above vs behind the rim
    if (P('1')) {
    console.log('--- 1. SENSING SURVEY (sees = any Kiln gun senses the player)');
    for (const [arc, alt, label] of [[0, 30, 'above, low'], [0, 80, 'above'], [0, 150, 'above, high'], [0, 250, 'above, very high'], [40, 4, 'side, hugging the ground'], [40, 14, 'side, over the rim'], [60, 4, 'far side, low'], [30, 40, 'side, high']]) {
      await place(arc, alt);
      const off = await page.evaluate(() => { const sf = window.__sf; sf.controls({ thrust: 0 }); sf.step(12); const r = sf.sense().filter(s => s.kind === 'sentinel' && s.d < 400); sf.controls(null); return { sees: r.some(s => s.seesPlayer), blocker: r[0] && r[0].blocker, sig: sf.sense().find(s => s.kind === 'player').signature }; });
      const on = await page.evaluate(() => { const sf = window.__sf; sf.controls({ thrust: 1 }); sf.step(12); const r = sf.sense().filter(s => s.kind === 'sentinel' && s.d < 400); const sig = sf.sense().find(s => s.kind === 'player').signature; sf.controls(null); return { sees: r.some(s => s.seesPlayer), sig }; });
      console.log(`  ${label.padEnd(24)} arc ${arc} alt ${alt}: engines off ${off.sees ? 'SEEN' : 'unseen'} (sig ${off.sig.toFixed(2)}${off.blocker ? ', blocked by ' + off.blocker : ''})  engines on ${on.sees ? 'SEEN' : 'unseen'} (sig ${on.sig.toFixed(2)})`);
    }

    }
    // ---- 2. thermal overload: sit in the guns' sights and let them fire, day and night
    if (P('2')) {
    for (const day of ['day', 'night']) {
      await api.newGame(page, seed);
      await api.launch(page);
      const sun = await setDay(day);
      await place(0, 100);
      const r = await hover(0, 100, 50, 'on');
      console.log(`--- 2. THERMAL, ${day.toUpperCase()} (sun ${sun.toFixed(2)}): ${r.alive ? 'alive' : 'DEAD'} hull ${r.hull.toFixed(0)}, hits taken ${r.hits}`);
      console.log('   ', fmt(r));
      if (day === 'day') await api.shot(page, 'kiln_thermal_day', 10);
    }

    }
    // ---- 3. environmental timing: a flare on the day side
    if (P('3')) {
    {
      await api.newGame(page, seed);
      await api.launch(page);
      const sun = await setDay('day');
      await place(0, 140);
      await page.evaluate(() => window.__sf.forceFlare());
      const r = await hover(0, 140, 40, 'on');
      console.log(`--- 3. FLARE ON THE DAY SIDE (sun ${sun.toFixed(2)}): ${r.alive ? 'alive' : 'DEAD'} hull ${r.hull.toFixed(0)}`);
      console.log('   ', fmt(r));
    }

    }
    // ---- 4. line of sight: a rock parked on the rim, then an approach in its lee
    if (P('4')) {
    {
      await api.newGame(page, seed);
      await api.launch(page);
      await setDay('night');
      // drop a big rock onto the rim between the guns and the approach lane
      const rim = await at(18, 6);
      const rockId = await page.evaluate(([x, y, vx, vy]) => window.__sf.spawnRockAt(x, y, vx, vy, 3), [rim.x, rim.y, rim.vx, rim.vy]);
      await api.step(page, 120 * 6);
      const rock = await page.evaluate(([id]) => { const a = window.__sf.game.world.asteroids.find(a => a.id === id); return a ? { alive: a.alive, rested: a.rested, r: a.radius } : null; }, [rockId]);
      console.log('--- 4. LINE OF SIGHT: rock on the rim', rock);
      for (const [arc, alt] of [[40, 10], [40, 18], [30, 14], [26, 12]]) {
        await place(arc, alt);
        const r = await page.evaluate(() => { const sf = window.__sf; sf.controls({ thrust: 1 }); sf.step(12); const s = sf.sense().filter(s => s.kind === 'sentinel' && s.d < 400); sf.controls(null); return s.map(q => (q.seesPlayer ? 'SEEN' : 'unseen') + (q.blocker ? '(' + q.blocker + ')' : '')).join(','); });
        console.log(`   engines on at arc ${arc} alt ${alt}: ${r}`);
      }
      await place(30, 14);
      await api.shot(page, 'kiln_rock_lee', 30);
      // can a rock be towed along the ground at all in this gravity? latch one and pull
      await api.newGame(page, seed);
      await api.launch(page);
      await setDay('night');
      for (const size of [3, 2, 1]) {
        const q = await at(70, 6);
        await page.evaluate(([x, y, vx, vy, a]) => window.__sf.teleport(x, y, vx, vy, a), [q.x, q.y, q.vx, q.vy, q.a]);
        await untether(page);
        await page.evaluate(([ax, ay, size]) => window.__sf.spawnRockAt(window.__sf.game.world.player.pos.x - ax * 4.5, window.__sf.game.world.player.pos.y - ay * 4.5, window.__sf.game.world.player.vel.x, window.__sf.game.world.player.vel.y, size), [Math.cos(q.a), Math.sin(q.a), size]);
        await api.step(page, 120);
        const latched = await page.evaluate(() => window.__sf.tether());
        const lift = await pull(page, q.a, 8, 1);
        const rockAlt = await page.evaluate(() => { const w = window.__sf.game.world; const pad = w.pads.find(p => p.name === 'THE KILN'); const b = pad.body; const a = w.asteroids.find(x => x.handled); return a ? (Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) - pad.height).toFixed(1) : 'gone'; });
        console.log(`   lift a size-${size} rock straight up at full thrust for 8 s: latched ${latched}, peak tension ${lift.peak.toFixed(0)}, cable ${lift.snapped ? 'PARTED' : 'held'}, rock alt now ${rockAlt}`);
      }
      // so the way to put a rock on the rim is to drop it there from above the guns' reach
      await api.newGame(page, seed);
      await api.launch(page);
      await setDay('night');
      const dropRim = await dropRock(18, 2);
      console.log(`   drop a size-2 rock onto the rim from above gun range: ${dropRim}`);
      for (const [arc, alt] of [[40, 18], [30, 14], [26, 12]]) {
        await place(arc, alt);
        const r = await page.evaluate(() => { const sf = window.__sf; sf.controls({ thrust: 1 }); sf.step(12); const s = sf.sense().filter(s => s.kind === 'sentinel' && s.d < 400); sf.controls(null); return s.map(q => (q.seesPlayer ? 'SEEN' : 'unseen') + (q.blocker ? '(' + q.blocker + ')' : '')).join(','); });
        console.log(`   after the drop, engines on at arc ${arc} alt ${alt}: ${r}`);
      }
    }

    }
    // ---- 5. low-emission approach: coast in with the engines off, night side, and see when the guns wake
    if (P('5')) {
    for (const mode of ['off', 'ping']) {
      await api.newGame(page, seed);
      await api.launch(page);
      await setDay('night');
      const q = await at(0, 220);
      // fall straight in at 6 u/s
      await page.evaluate(([x, y, vx, vy, a, ax, ay]) => window.__sf.teleport(x, y, vx - ax * 6, vy - ay * 6, a + Math.PI), [q.x, q.y, q.vx, q.vy, q.a, Math.cos(q.a), Math.sin(q.a)]);
      const r = await page.evaluate(([mode]) => {
        const sf = window.__sf, w = sf.game.world, p = w.player;
        const pad = w.pads.find(q => q.name === 'THE KILN'); const b = pad.body;
        let seenAt = null, firstShot = null, hull0 = p.hull;
        for (let t = 0; t < 120 * 40; t++) {
          const alt = Math.hypot(p.pos.x - b.pos.x, p.pos.y - b.pos.y) - pad.height;
          if (alt < 12) break;
          // 'ping' falls the same way but scans every two seconds
          sf.controls({ turn: 0, thrust: 0, retro: 0, strafe: 0, fire: false, boost: false });
          if (mode === 'ping' && t % 240 === 0) sf.ping();
          sf.step(1);
          if (t % 12 === 0) {
            const s = sf.sense().filter(q => q.kind === 'sentinel' && q.d < 400);
            if (seenAt === null && s.some(q => q.seesPlayer)) seenAt = alt;
            if (firstShot === null && p.hull < hull0) firstShot = alt;
          }
        }
        sf.controls(null);
        return { seenAt, firstShot, hull: p.hull, alive: p.alive };
      }, [mode]);
      console.log(`--- 5. APPROACH engines ${mode}: first sensed at alt ${r.seenAt === null ? 'never' : r.seenAt.toFixed(0)}, first hit at alt ${r.firstShot === null ? 'never' : r.firstShot.toFixed(0)}, hull ${r.hull.toFixed(0)}`);
    }

    }
    // ---- 6. power removal: jam the guns by daylight, then go down and take the core
    if (P('6')) {
    {
      await api.newGame(page, seed);
      await api.launch(page);
      await setDay('day');
      await place(0, 100);
      const bait = await hover(0, 100, 60, 'on', true);
      const jammed = bait.samples[bait.samples.length - 1];
      console.log(`--- 6. POWER: bait for ${bait.samples.length} s until both guns jammed [${jammed.guns}] hull ${bait.hull.toFixed(0)}`);
      K = await kilnOf();
      // dive to the socket and latch the core
      const sock = await page.evaluate(() => { const w = window.__sf.game.world; const pad = w.pads.find(p => p.name === 'THE KILN'); const src = w.power.find(s => s.name === 'THE KILN'); const b = pad.body; const c = Math.cos(-b.spinAngle), s = Math.sin(-b.spinAngle); const wp = { x: src.socketLocal.x, y: src.socketLocal.y }; const l = Math.hypot(wp.x, wp.y); return { local: wp, up: { x: wp.x / l, y: wp.y / l }, body: b.name }; });
      const path = [{ x: sock.local.x + sock.up.x * 30, y: sock.local.y + sock.up.y * 30 }, { x: sock.local.x + sock.up.x * 4.5, y: sock.local.y + sock.up.y * 4.5 }];
      const dive = await follow(page, path, { seconds: 40, tol: 2.0, maxSpeed: 8, gain: 2.4, body: sock.body });
      const latched = await page.evaluate(() => window.__sf.tether());
      const cores = await page.evaluate(() => window.__sf.cores());
      console.log(`   dive: reached ${dive.reached}/${dive.of} hull ${dive.hull.toFixed(0)}; latched ${latched}`, cores.filter(c => c.tethered));
      const out = await follow(page, [{ x: sock.local.x + sock.up.x * 40, y: sock.local.y + sock.up.y * 40 }], { seconds: 40, tol: 3, maxSpeed: 6, gain: 2.2, body: sock.body });
      K = await kilnOf();
      const st = await api.state(page);
      console.log(`   climb out: reached ${out.reached}/${out.of} tethered ${out.tethered} hull ${out.hull.toFixed(0)}; Kiln powered ${K.powered}, socket core ${K.socket.core}, guns [${K.guns.map(g => g.target ? '*' : '-').join('')}]`);
      console.log('   comms:', st.comms.slice(-3));
      await api.shot(page, 'kiln_core_out', 20);
      // carry the core past the (dark) guns: nothing to see. Now put it back and see the pass work on live guns
      const back = await follow(page, [{ x: sock.local.x + sock.up.x * 4.5, y: sock.local.y + sock.up.y * 4.5 }], { seconds: 40, tol: 2, maxSpeed: 6, gain: 2.2, body: sock.body });
      await untether(page);
      await api.step(page, 240);
      K = await kilnOf();
      console.log(`   core returned: powered ${K.powered} (reached ${back.reached})`);
      await page.evaluate(() => window.__sf.heal());
      const relatch = await page.evaluate(() => window.__sf.tether());
      const pass = await hover(6, 12, 20, 'on');
      console.log(`   holding the core on the cable in front of live guns: latched ${relatch}, hits taken ${pass.hits}, hull ${pass.hull.toFixed(0)}, powered now ${(await kilnOf()).powered}`);
      const jn = await page.evaluate(() => window.__sf.journal());
      console.log('   journal:', jn.map(e => e.text));
    }

    }
    // ---- 7. not in the memo: drop a rock on the plant
    if (P('7')) {
    {
      await api.newGame(page, seed);
      await api.launch(page);
      await setDay('night');
      K = await kilnOf();
      const plantLocal = await page.evaluate(() => { const w = window.__sf.game.world; const pad = w.pads.find(p => p.name === 'THE KILN'); return { local: pad.plant.local, up: pad.plant.normalLocal, body: pad.body.name }; });
      const drop = await dropRock(14.5, 2);
      const latched = true; const tow = { reached: 1, of: 1 };
      console.log(`   ${drop}`);
      K = await kilnOf();
      const st = await api.state(page);
      console.log(`--- 7. ROCK ON THE PLANT: latched ${latched}, reached ${tow.reached}/${tow.of}, hull ${st.player.hull.toFixed(0)}; plant`, K.plant, 'powered', K.powered, 'socket', K.socket);
      console.log('   comms:', st.comms.slice(-3));
      await api.shot(page, 'kiln_rock_drop', 20);
    }

    }
    // ---- 8. not in the memo: shoot the fins from above, then bait again
    if (P('8')) {
    {
      await api.newGame(page, seed);
      await api.launch(page);
      await setDay('day');
      await place(0, 120);
      const r = await page.evaluate(([ticks]) => {
        const sf = window.__sf, w = sf.game.world, p = w.player;
        const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
        const pad = w.pads.find(q => q.name === 'THE KILN'); const b = pad.body; const rad = pad.radiator;
        let fired = 0;
        for (let t = 0; t < ticks; t++) {
          if (!p.alive || !rad.alive) break;
          const c = Math.cos(b.spinAngle), s = Math.sin(b.spinAngle);
          const rx = b.pos.x + rad.local.x * c - rad.local.y * s, ry = b.pos.y + rad.local.x * s + rad.local.y * c;
          const [gx, gy] = sf.gravity(p.pos.x, p.pos.y);
          // hold altitude with short bursts, otherwise aim at the fins and fire (shots inherit our velocity; we hover, so aim straight)
          const wantVx = b.vel.x, wantVy = b.vel.y;
          const ax = (wantVx - p.vel.x) * 2 - gx, ay = (wantVy - p.vel.y) * 2 - gy;
          const am = Math.hypot(ax, ay);
          const need = (t % 720) >= 480; // four seconds aiming, two seconds climbing
          const aim = Math.atan2(ry - p.pos.y, rx - p.pos.x);
          const heading = need ? Math.atan2(ay, ax) : aim;
          const err = wrap(heading - p.angle);
          const fire = !need && Math.abs(err) < 0.08;
          if (fire && p.fireCooldown <= 0) fired++;
          sf.controls({ turn: Math.max(-1, Math.min(1, err * 4)), thrust: need && Math.abs(err) < 0.4 ? Math.min(1, am / p.stats.thrust) : 0, retro: 0, strafe: 0, fire, boost: false });
          sf.step(1);
        }
        sf.controls(null);
        return { radAlive: rad.alive, fired, hull: p.hull, alive: p.alive, t: w.time };
      }, [120 * 40]);
      console.log(`--- 8. FINS: radiator ${r.radAlive ? 'still up' : 'DESTROYED'} after ${r.fired} shots, hull ${r.hull.toFixed(0)}`);
      const bait = await hover(0, 100, 40, 'on');
      console.log('    bait after fins gone:', fmt(bait));
    }

    }
    // ---- 9. the direct solution must still work: fly in and shoot the pad
    if (P('9')) {
    {
      await api.newGame(page, seed);
      await api.launch(page);
      await page.evaluate(() => window.__sf.buyAll());
      await page.evaluate(() => window.__sf.weapon('mass'));
      await place(0, 55);
      const res = await page.evaluate(([ticks]) => {
        const sf = window.__sf, w = sf.game.world, p = w.player;
        const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
        const pad = w.pads.find(q => q.name === 'THE KILN');
        const b = pad.body;
        const hp0 = pad.enemyHealth;
        for (let t = 0; t < ticks; t++) {
          if (!p.alive || !pad.alive) break;
          const rx = p.pos.x - b.pos.x, ry = p.pos.y - b.pos.y, r = Math.hypot(rx, ry);
          const ux = rx / r, uy = ry / r;
          const [gx, gy] = sf.gravity(p.pos.x, p.pos.y);
          const wantAlt = pad.height + 40;
          const wantVr = (wantAlt - r) * 0.3;
          const vr = (p.vel.x - b.vel.x) * ux + (p.vel.y - b.vel.y) * uy;
          const ax = (ux * (wantVr - vr)) * 1.5 - gx, ay = (uy * (wantVr - vr)) * 1.5 - gy;
          const am = Math.hypot(ax, ay);
          const pa = pad.angle + b.spinAngle;
          let tx = b.pos.x + Math.cos(pa) * pad.height, ty = b.pos.y + Math.sin(pa) * pad.height;
          const sent = w.ships.filter(s => s.alive && s.kind === 'sentinel' && s.ai.home === pad);
          if (sent.length) { tx = sent[0].pos.x; ty = sent[0].pos.y; }
          const aim = Math.atan2(ty - p.pos.y, tx - p.pos.x);
          const needThrust = am > 4;
          const heading = needThrust ? Math.atan2(ay, ax) : aim;
          const err = wrap(heading - p.angle);
          sf.controls({ turn: Math.max(-1, Math.min(1, err * 4)), thrust: needThrust && Math.abs(err) < 0.4 ? Math.min(1, am / p.stats.thrust) : 0, retro: 0, strafe: 0, fire: !needThrust && Math.abs(err) < 0.15, boost: false });
          sf.step(1);
        }
        sf.controls(null);
        return { alive: p.alive, hull: p.hull, baseAlive: pad.alive, baseHp: pad.enemyHealth, hp0, sentinels: w.ships.filter(s => s.alive && s.kind === 'sentinel' && s.ai.home === pad).length, time: w.time };
      }, [120 * 90]);
      console.log(`--- 9. DIRECT ASSAULT (armoured, mass driver): ${res.alive ? 'ALIVE' : 'DEAD'} hull ${res.hull.toFixed(0)}, base ${res.baseAlive ? 'STANDS ' + res.baseHp.toFixed(0) + '/' + res.hp0 : 'DESTROYED'}, guns left ${res.sentinels}, t ${res.time.toFixed(0)}`);
    }
    }
  },

  // ------------------------------------------------------------------ the living system, unattended
  // Park the ship and let the world run. Everything the sim logs is printed so that interactions nobody
  // authored can be found: guns jamming in daylight, traffic shot down, contacts lost behind moons.
  async living({ page }) {
    await api.manual(page, true);
    const seeds = (process.env.LIVING_SEEDS || '2024,4321').split(',').map(Number);
    for (const seed of seeds) {
      for (const where of ['mid', 'enemy']) {
        await api.newGame(page, seed);
        await api.launch(page);
        await api.step(page, 2);
        // park in a high, dark orbit around the world in question
        const parked = await page.evaluate(([where]) => {
          const sf = window.__sf, w = sf.game.world;
          const kiln = w.pads.find(p => p.name === 'THE KILN');
          const b = where === 'mid' ? kiln.body : w.enemyCore.body;
          const r = b.radius * 4.2;
          const a = Math.random() * Math.PI * 2;
          const v = Math.sqrt(b.mass / r);
          sf.teleport(b.pos.x + Math.cos(a) * r, b.pos.y + Math.sin(a) * r, b.vel.x - Math.sin(a) * v, b.vel.y + Math.cos(a) * v, a);
          return { body: b.name, r };
        }, [where]);
        console.log(`=== seed ${seed}, parked ${parked.r.toFixed(0)} out from ${parked.body} (${where}) for 14 minutes`);
        let lastLog = 0;
        const counts = {};
        for (let minute = 1; minute <= 14; minute++) {
          await api.step(page, 120 * 60);
          const snap = await page.evaluate(([since]) => {
            const sf = window.__sf, w = sf.game.world, p = w.player;
            const logs = w.log.filter(e => e.time >= since).map(e => ({ t: Math.round(e.time), kind: e.kind, text: e.text }));
            const K = sf.bases();
            return { time: w.time, logs, alive: p.alive, hull: p.hull, threat: w.threat, civs: w.ships.filter(s => s.alive && s.faction === 'civ').length, enemies: w.ships.filter(s => s.alive && s.faction === 'enemy' && s.kind !== 'sentinel').length, bases: K.map(b => `${b.name.replace('THE ', '').replace('BASE ', '')}:${b.powered ? 'on' : 'OFF'}/sun${b.sun.toFixed(1)}/${b.guns.map(g => (g.overheated ? 'J' : g.heat.toFixed(1)) + (g.target ? '*' : '')).join(',')}`), events: w.events.filter(e => !e.resolved && !e.failed).map(e => e.label), journal: w.journal.length, comms: w.comms.filter(c => c.time >= since).map(c => c.from + ': ' + c.text) };
          }, [lastLog]);
          lastLog = snap.time;
          for (const l of snap.logs) counts[l.kind] = (counts[l.kind] || 0) + 1;
          const notable = snap.logs.filter(l => l.kind !== 'rock-rest' && l.kind !== 'rock-fall');
          console.log(`  ${String(minute).padStart(2)}m threat ${snap.threat.toFixed(1)} civs ${snap.civs} hostiles ${snap.enemies} | ${snap.bases.join(' ')} | ${snap.events.join('; ') || 'quiet'}`);
          for (const l of notable) console.log(`      ${l.t}s ${l.kind}: ${l.text}`);
          for (const c of snap.comms) if (/DOWN|GONE|SILENT|DESTROYED|CRACKED|LOST|BROKEN|STOPPED|RESUMED|MADE IT|REPELLED/.test(c)) console.log(`      comm: ${c}`);
          if (!snap.alive) { console.log('      (the parked ship was destroyed; hull', snap.hull, ')'); break; }
        }
        console.log('  log counts:', JSON.stringify(counts));
        const jn = await page.evaluate(() => window.__sf.journal());
        console.log('  journal:', jn.map(e => `${e.t}s ${e.text}`));
      }
    }
  },

  // ------------------------------------------------------------------ deepening pass: stealth, brute force, flares, traffic
  /** Fly toward a world point with the main engine (loud) or coast (quiet); returns per-second samples of who has us. */
  async stealth({ page }) {
    await api.manual(page, true);
    const seed = 2024;
    const who = async () => page.evaluate(() => { const sf = window.__sf, w = sf.game.world, p = w.player; return { tracked: sf.tracked(), sig: sf.signature(), contact: sf.contact(), hunters: w.ships.filter(s => s.alive && s.faction === 'enemy' && s.kind !== 'sentinel').map(s => `${s.kind[0]}:${s.ai.mode}${s.ai.target === p ? '*' : ''}`).join(' ') }; });
    // ---- 1. a wave is hunting us near the home world. cut engines, coast behind the moon; then thrust; then ping
    await api.newGame(page, seed);
    await api.launch(page);
    const st0 = await api.state(page);
    const home = st0.bodies.find(b => b.kind === 'planet');
    const moon = st0.bodies.find(b => b.kind === 'moon');
    await page.evaluate(([x, y]) => window.__sf.teleport(x, y, 0, 0, 0), [home.x + 420, home.y]);
    await page.evaluate(() => { for (let i = 0; i < 3; i++) window.__sf.spawnEnemy('wasp', -140 - i * 10, 30 * i, 'hunt'); });
    await page.evaluate(() => { const w = window.__sf.game.world, p = w.player; for (const s of w.ships) if (s.ai && s.kind === 'wasp') s.ai.targetPos = { x: p.pos.x, y: p.pos.y }; });
    console.log('--- 1. HUNTED: three wasps sent to our position 140 out');
    const phases = [
      { name: 'thrust away 6 s (loud)', c: { thrust: 1 }, sec: 6 },
      { name: 'coast 15 s (quiet)', c: {}, sec: 15 },
      { name: 'coast 15 s more', c: {}, sec: 15 },
      { name: 'boost 4 s', c: { thrust: 1, boost: true }, sec: 4 },
      { name: 'coast 12 s', c: {}, sec: 12 },
    ];
    for (const ph of phases) {
      await api.run(page, ph.c, ph.sec);
      const r = await who();
      console.log(`   after ${ph.name}: tracked by ${r.tracked}, signature ${r.sig.toFixed(2)}, contact age ${r.contact ? r.contact.age.toFixed(0) + 's by ' + r.contact.by : 'none'} | ${r.hunters}`);
    }
    // a ping while quiet
    await page.evaluate(() => window.__sf.ping());
    await api.run(page, {}, 4);
    let r = await who();
    console.log(`   after a ping: tracked by ${r.tracked}, signature ${r.sig.toFixed(2)}, contact age ${r.contact ? r.contact.age.toFixed(0) + 's' : 'none'} | ${r.hunters}`);
    // ---- 2. break line of sight: put the moon between us and them
    await api.newGame(page, seed);
    await api.launch(page);
    const mv = await page.evaluate(([name]) => { const m = window.__sf.game.world.bodies.find(b => b.name === name); return { x: m.pos.x, y: m.pos.y, vx: m.vel.x, vy: m.vel.y, r: m.radius }; }, [moon.name]);
    // we sit 60 beyond the moon on the far side from the wasps, at the moon's velocity; wasps 200 on the near side, hunting our position
    await page.evaluate(([x, y, vx, vy]) => window.__sf.teleport(x, y, vx, vy, 0), [mv.x + mv.r + 40, mv.y, mv.vx, mv.vy]);
    await page.evaluate(([mx, my, r]) => { const sf = window.__sf, w = sf.game.world, p = w.player; const n0 = w.ships.length; for (let i = 0; i < 2; i++) { sf.spawnEnemy('wasp', -(2 * r + 200) - i * 15, 10 * i, 'hunt'); } window.__hunters = w.ships.slice(n0).map(s => s.id); for (const s of w.ships.slice(n0)) { s.ai.targetPos = { x: p.pos.x, y: p.pos.y }; s.vel.x = p.vel.x; s.vel.y = p.vel.y; } }, [mv.x, mv.y, mv.r]);
    console.log('--- 2. OCCLUSION: two wasps hunting our position from the far side of a moon; we hold still behind it');
    for (let i = 0; i < 6; i++) {
      await api.run(page, {}, 5);
      r = await who();
      const near = await page.evaluate(([name]) => { const w = window.__sf.game.world, p = w.player; return window.__hunters.map(id => { const s = w.ships.find(q => q.id === id); if (!s) return 'gone'; return `${s.alive ? '' : 'DEAD(' + s.lastDamageSource + ') '}d${Math.hypot(s.pos.x - p.pos.x, s.pos.y - p.pos.y).toFixed(0)}/${window.__sf.los(s.pos.x, s.pos.y, p.pos.x, p.pos.y) ?? 'clear'} ${s.ai.mode}${s.ai.target === p ? '*' : ''}`; }).join(' | '); }, [moon.name]);
      console.log(`   ${(i + 1) * 5}s: tracked ${r.tracked}, ${r.hunters} | ${near}`);
    }
    const lost = await page.evaluate(() => window.__sf.log().filter(e => e.kind === 'contact-lost').map(e => e.t + 's ' + e.text));
    console.log('   contact-lost log:', lost);
    // ---- 3. dark approach to BASE KILO by night versus a loud one, and whether a wave launches at us
    for (const mode of ['dark', 'loud']) {
      await api.newGame(page, seed);
      await api.launch(page);
      const kilo = await page.evaluate(([mode]) => {
        const sf = window.__sf, w = sf.game.world, p = w.player;
        const pad = w.pads.find(q => q.name === 'BASE KILO'); const b = pad.body;
        const sunAng = Math.atan2(w.star.pos.y - b.pos.y, w.star.pos.x - b.pos.x);
        sf.spinTo(b.name, sunAng + Math.PI - pad.angle); sf.step(1);
        const a = pad.angle + b.spinAngle;
        // fall in from 300 above at 5 u/s; loud = boost pulses on the way
        sf.teleport(b.pos.x + Math.cos(a) * (pad.height + 300), b.pos.y + Math.sin(a) * (pad.height + 300), b.vel.x - Math.cos(a) * 5, b.vel.y - Math.sin(a) * 5, a + Math.PI);
        pad.spawnTimer = 20; // a wave is due soon: where does it go?
        let seenAt = null, hitAt = null, hull0 = p.hull, waveTarget = null, waveAt = null;
        for (let t = 0; t < 120 * 60; t++) {
          const alt = Math.hypot(p.pos.x - b.pos.x, p.pos.y - b.pos.y) - pad.height;
          if (alt < 15 || !p.alive) break;
          sf.controls(mode === 'loud' && (t % 240) < 60 ? { thrust: 1, boost: true } : { thrust: 0 });
          sf.step(1);
          if (t % 12 === 0) {
            const s = sf.sense().filter(q => q.kind === 'sentinel' && q.d < 400);
            if (seenAt === null && s.some(q => q.seesPlayer)) seenAt = alt;
            if (hitAt === null && p.hull < hull0) hitAt = alt;
            if (waveAt === null) { const hunters = w.ships.filter(q => q.alive && q.kind === 'wasp' && q.ai.mode === 'hunt' && q.ai.targetPos); if (hunters.length) { waveAt = t / 120; const h = hunters[0]; waveTarget = Math.hypot(h.ai.targetPos.x - p.pos.x, h.ai.targetPos.y - p.pos.y).toFixed(0); } }
          }
        }
        sf.controls(null);
        return { seenAt, hitAt, hull: p.hull, waveAt, waveTarget, contact: sf.contact() };
      }, [mode]);
      console.log(`--- 3. KILO at night, ${mode}: sensed at alt ${kilo.seenAt === null ? 'never' : kilo.seenAt.toFixed(0)}, first hit at ${kilo.hitAt === null ? 'never' : kilo.hitAt.toFixed(0)}, hull ${kilo.hull.toFixed(0)}; wave ${kilo.waveAt === null ? 'never launched at us' : 'launched at ' + kilo.waveAt.toFixed(0) + 's aimed ' + kilo.waveTarget + ' from us'}; tide contact ${kilo.contact ? 'age ' + kilo.contact.age.toFixed(0) + 's by ' + kilo.contact.by : 'none'}`);
    }
  },

  /** The heavy build: armour, tuned engine, mass driver. What does it cost in heat and emissions? */
  async brute({ page }) {
    await api.manual(page, true);
    const seed = 2024;
    for (const fit of ['stock', 'heavy']) {
      await api.newGame(page, seed);
      await api.launch(page);
      if (fit === 'heavy') await page.evaluate(() => { const sf = window.__sf, p = sf.game.world.player; for (const u of ['armour', 'engine', 'mass']) if (!p.upgrades.includes(u)) p.upgrades.push(u); sf.buyAll(); sf.weapon('mass'); });
      const r = await page.evaluate(() => {
        const sf = window.__sf, w = sf.game.world, p = w.player;
        const b = w.pads.find(q => q.name === 'THE KILN').body;
        const u = { x: -b.pos.x / Math.hypot(b.pos.x, b.pos.y), y: -b.pos.y / Math.hypot(b.pos.x, b.pos.y) };
        const out = {};
        for (const where of ['sun', 'shadow']) {
          const x = where === 'sun' ? b.pos.x + u.x * 400 : b.pos.x - u.x * 130, y = where === 'sun' ? b.pos.y + u.y * 400 : b.pos.y - u.y * 130;
          sf.teleport(x, y, b.vel.x, b.vel.y, 0);
          p.heat = 0; p.overheated = false;
          let jamAt = null, shots = 0, lastCd = 0, sigFiring = 0, sigIdle = sf.signature();
          for (let t = 0; t < 120 * 30; t++) { sf.controls({ fire: true }); sf.step(1); if (p.fireCooldown > lastCd) shots++; lastCd = p.fireCooldown; if (t === 60) sigFiring = sf.signature(); if (jamAt === null && p.overheated) jamAt = t / 120; }
          sf.controls(null);
          out[where] = { jamAt, shots, sigIdle: sigIdle.toFixed(2), sigFiring: sigFiring.toFixed(2) };
        }
        // emissions under way
        sf.teleport(b.pos.x + u.x * 400, b.pos.y + u.y * 400, b.vel.x, b.vel.y, 0);
        sf.controls({ thrust: 1 }); sf.step(30); const sigThrust = sf.signature();
        sf.controls({ thrust: 1, boost: true }); sf.step(30); const sigBoost = sf.signature();
        sf.controls(null);
        return { out, sigThrust: sigThrust.toFixed(2), sigBoost: sigBoost.toFixed(2), mass: p.massMul.toFixed(2), thrust: p.stats.thrust.toFixed(1), turn: (p.stats.turnRate / Math.sqrt(p.massMul)).toFixed(2), weapon: p.weapon.kind };
      });
      console.log(`${fit.toUpperCase()} (${r.weapon}, mass x${r.mass}, thrust ${r.thrust}, turn ${r.turn}): continuous fire jams at ${r.out.sun.jamAt ?? 'never'} s in sun (${r.out.sun.shots} shots), ${r.out.shadow.jamAt ?? 'never'} s in shadow; signature idle ${r.out.sun.sigIdle}, firing ${r.out.sun.sigFiring}, thrusting ${r.sigThrust}, boosting ${r.sigBoost}`);
    }
    // the heavy build against the Kiln by night, from the front: how far out do the guns see it firing, and does it still win in seconds
    await api.newGame(page, seed);
    await api.launch(page);
    await page.evaluate(() => { const sf = window.__sf, p = sf.game.world.player; for (const u of ['armour', 'engine', 'mass']) if (!p.upgrades.includes(u)) p.upgrades.push(u); sf.buyAll(); sf.weapon('mass'); });
    const k = await page.evaluate(() => {
      const sf = window.__sf, w = sf.game.world, p = w.player;
      const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
      const pad = w.pads.find(q => q.name === 'THE KILN'); const b = pad.body;
      const sunAng = Math.atan2(w.star.pos.y - b.pos.y, w.star.pos.x - b.pos.x);
      sf.spinTo(b.name, sunAng + Math.PI - pad.angle); sf.step(1);
      const a = pad.angle + b.spinAngle;
      sf.teleport(b.pos.x + Math.cos(a) * (pad.height + 55), b.pos.y + Math.sin(a) * (pad.height + 55), b.vel.x, b.vel.y, a + Math.PI);
      const hp0 = pad.enemyHealth; let t = 0;
      for (; t < 120 * 90; t++) {
        if (!p.alive || !pad.alive) break;
        const rx = p.pos.x - b.pos.x, ry = p.pos.y - b.pos.y, r = Math.hypot(rx, ry); const ux = rx / r, uy = ry / r;
        const [gx, gy] = sf.gravity(p.pos.x, p.pos.y);
        const wantVr = (pad.height + 40 - r) * 0.3; const vr = (p.vel.x - b.vel.x) * ux + (p.vel.y - b.vel.y) * uy;
        const ax = ux * (wantVr - vr) * 1.5 - gx, ay = uy * (wantVr - vr) * 1.5 - gy; const am = Math.hypot(ax, ay);
        const pa = pad.angle + b.spinAngle; let tx = b.pos.x + Math.cos(pa) * pad.height, ty = b.pos.y + Math.sin(pa) * pad.height;
        const sent = w.ships.filter(s => s.alive && s.kind === 'sentinel' && s.ai.home === pad); if (sent.length) { tx = sent[0].pos.x; ty = sent[0].pos.y; }
        const aim = Math.atan2(ty - p.pos.y, tx - p.pos.x); const need = am > 4; const err = wrap((need ? Math.atan2(ay, ax) : aim) - p.angle);
        sf.controls({ turn: Math.max(-1, Math.min(1, err * 4)), thrust: need && Math.abs(err) < 0.4 ? Math.min(1, am / p.stats.thrust) : 0, fire: !need && Math.abs(err) < 0.15 });
        sf.step(1);
      }
      sf.controls(null);
      return { alive: p.alive, hull: p.hull, base: pad.alive ? `STANDS ${pad.enemyHealth.toFixed(0)}/${hp0}` : 'DESTROYED', t: (t / 120).toFixed(0), heat: p.heat.toFixed(2), jammed: p.overheated };
    });
    console.log(`HEAVY vs THE KILN by night: ${k.alive ? 'alive' : 'DEAD'} hull ${k.hull.toFixed(0)}, base ${k.base} in ${k.t} s, weapon heat ${k.heat}${k.jammed ? ' JAMMED' : ''}`);
  },

  /** Flares as tactics: hunters chasing us into a planet's shadow at flare time; a base's guns during the front. */
  async flareops({ page }) {
    await api.manual(page, true);
    const seed = 2024;
    await api.newGame(page, seed);
    await api.launch(page);
    const r = await page.evaluate(() => {
      const sf = window.__sf, w = sf.game.world, p = w.player;
      const b = w.bodies.find(q => q.kind === 'planet');
      const u = { x: -b.pos.x / Math.hypot(b.pos.x, b.pos.y), y: -b.pos.y / Math.hypot(b.pos.x, b.pos.y) };
      // we hold in the planet's shadow cone, 240 behind it, on a circular path; three wasps come hunting from the sunlit side
      { const rr = b.radius + 240; const v = Math.sqrt(b.mass / rr); sf.teleport(b.pos.x - u.x * rr, b.pos.y - u.y * rr, b.vel.x - u.y * v, b.vel.y + u.x * v, 0); }
      for (let i = 0; i < 3; i++) sf.spawnEnemy('wasp', u.x * (2 * b.radius + 260) + i * 12, u.y * (2 * b.radius + 260) - i * 12, 'hunt');
      for (const s of w.ships) if (s.ai && s.kind === 'wasp') { s.ai.targetPos = { x: p.pos.x, y: p.pos.y }; s.vel.x = b.vel.x; s.vel.y = b.vel.y; }
      sf.forceFlare();
      const out = [];
      for (let t = 0; t < 120 * 40; t++) {
        sf.step(1);
        if (!p.alive) { out.push(`${(t / 120).toFixed(1)}s WE DIED: ${p.lastDamageSource}`); break; }
        if (t % 480 === 0) out.push(`${t / 120}s flare ${w.flare.active ? 'ACTIVE' : w.flare.warned ? 'coming' : 'over'} me hull ${p.hull.toFixed(0)} shadow ${sf.sun(p.pos.x, p.pos.y) === 0 ? 'y' : 'n'} | wasps ${w.ships.filter(s => s.kind === 'wasp').map(s => `${s.alive ? s.hull.toFixed(0) : 'dead'}${s.alive && sf.sun(s.pos.x, s.pos.y) === 0 ? 's' : ''}`).join(' ')}`);
      }
      return out;
    });
    console.log('--- FLARE, hunters chasing us into a planet\'s shadow:');
    for (const l of r) console.log('   ' + l);
    // a base during the front: KILO by day, its guns and its heat
    await api.newGame(page, seed);
    await api.launch(page);
    const g = await page.evaluate(() => {
      const sf = window.__sf, w = sf.game.world;
      const pad = w.pads.find(q => q.name === 'BASE KILO'); const b = pad.body;
      const sunAng = Math.atan2(w.star.pos.y - b.pos.y, w.star.pos.x - b.pos.x);
      sf.spinTo(b.name, sunAng - pad.angle); sf.step(1);
      sf.forceFlare();
      const out = [];
      for (let t = 0; t < 120 * 40; t++) { sf.step(1); if (t % 600 === 0) { const K = sf.bases().find(q => q.name === 'BASE KILO'); out.push(`${t / 120}s flare ${w.flare.active ? 'ACTIVE' : w.flare.warned ? 'coming' : 'over'} guns ${K.guns.map(q => q.heat.toFixed(2) + (q.overheated ? 'J' : '')).join(',')} sun ${K.sun.toFixed(1)}`); } }
      return out;
    });
    console.log('--- FLARE over BASE KILO at noon, nobody shooting:', g.join(' | '));
  },

  /** Traffic as evidence: shuttles into the colony beside the Kiln for ten minutes, Kiln lit and dark; what is left behind. */
  async traffic({ page }) {
    await api.manual(page, true);
    const seed = 2024;
    for (const lit of [true, false]) {
      await api.newGame(page, seed);
      await api.launch(page);
      const r = await page.evaluate(([lit]) => {
        const sf = window.__sf, w = sf.game.world;
        const kiln = w.pads.find(q => q.name === 'THE KILN'); const b = kiln.body; const colony = b.pads.find(q => q.kind === 'colony');
        if (!lit) { const src = w.power.find(s => s.name === 'THE KILN'); src.core.pos.x += 500; }
        const a = kiln.angle + b.spinAngle + Math.PI; sf.teleport(b.pos.x + Math.cos(a) * (b.radius + 320), b.pos.y + Math.sin(a) * (b.radius + 320), b.vel.x, b.vel.y, 0);
        const ids = []; let sent = 0, landed = 0, dead = 0, shot = 0;
        const seen = new Set();
        for (let t = 0; t < 120 * 600; t++) {
          // a shuttle every 40 s from a random bearing 260 out
          if (t % (120 * 40) === 0) { const ang = Math.random() * Math.PI * 2; ids.push(sf.spawnCiv('shuttle', b.pos.x + Math.cos(ang) * (b.radius + 260), b.pos.y + Math.sin(ang) * (b.radius + 260), colony.name)); sent++; }
          sf.step(1);
          for (const id of ids) { if (seen.has(id)) continue; const s = w.ships.find(q => q.id === id); if (!s) { seen.add(id); dead++; continue; } if (s.landed) { seen.add(id); landed++; } else if (!s.alive) { seen.add(id); dead++; if (s.lastDamageSource === 'weapon') shot++; } }
        }
        const salvage = w.pickups.filter(k => k.alive && k.kind === 'salvage' && Math.hypot(k.pos.x - b.pos.x, k.pos.y - b.pos.y) < b.radius + 120).length;
        const K = sf.bases().find(q => q.name === 'THE KILN');
        const causes = {}; for (const e of sf.log()) if (e.kind === 'civ-lost') { const c = e.text.split('|')[1]; causes[c] = (causes[c] || 0) + 1; }
        return { sent, landed, dead, shot, salvage, causes, kilnShots: K.guns.reduce((s, g) => s + g.shots, 0), civShotLogs: sf.log().filter(e => e.kind === 'civ-shot').length, sunNow: K.sun.toFixed(2) };
      }, [lit]);
      console.log(`TRAFFIC 10 min, Kiln ${lit ? 'LIT' : 'DARK'}: ${r.sent} shuttles sent, ${r.landed} landed, ${r.dead} lost (${r.shot} to guns); losses by cause ${JSON.stringify(r.causes)}; salvage lying near the world ${r.salvage}; civ-shot logs ${r.civShotLogs}`);
    }
  },

  /** The living system with the player on patrol rather than parked: a loop between the harbour, the mid colony and back, engines on. */
  async patrol({ page }) {
    await api.manual(page, true);
    const seeds = (process.env.LIVING_SEEDS || '2024').split(',').map(Number);
    for (const seed of seeds) {
      await api.newGame(page, seed);
      await api.launch(page);
      const st = await api.state(page);
      const kilnBody = st.pads.find(p => p.name === 'THE KILN').body;
      const wps = [st.stations[0], st.bodies.find(b => b.name === kilnBody), st.stations[1], st.bodies.find(b => b.kind === 'planet')];
      console.log(`=== seed ${seed}: patrol loop ${wps.map(x => x.name).join(' -> ')} for 12 minutes, engines on`);
      let lastLog = 0, leg = 0; const counts = {};
      for (let minute = 1; minute <= 12; minute++) {
        // fly toward the current waypoint for a minute at cruise, bounded 300 units from it, then pick the next
        const wp = wps[leg % wps.length];
        const res = await page.evaluate(([name, ticks]) => {
          const sf = window.__sf, w = sf.game.world, p = w.player;
          sf.refuel();
          if (p.docked) sf.launch();
          const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
          const tgt = w.stations.find(s => s.name === name) || w.bodies.find(b => b.name === name);
          let arrived = false;
          for (let t = 0; t < ticks && p.alive; t++) {
            const dx = tgt.pos.x - p.pos.x, dy = tgt.pos.y - p.pos.y, d = Math.hypot(dx, dy);
            if (d < 320) { arrived = true; break; }
            if (p.docked) sf.launch();
            // steer around the star and any world that lies across the line (the test pilot is not suicidal)
            let ux = dx / d, uy = dy / d;
            for (const b of w.bodies) { const R = (b.kind === 'star' ? b.radius * 2.2 : b.maxRadius + 90); const bx = b.pos.x - p.pos.x, by = b.pos.y - p.pos.y; const along = bx * ux + by * uy; if (along <= 0 || along > d) continue; const perp = bx * uy - by * ux; if (Math.abs(perp) < R) { const side = perp > 0 ? -1 : 1; const px = -uy * side, py = ux * side; const gx0 = b.pos.x + px * R * 1.1, gy0 = b.pos.y + py * R * 1.1; const ddx = gx0 - p.pos.x, ddy = gy0 - p.pos.y, dl = Math.hypot(ddx, ddy) || 1; ux = ddx / dl; uy = ddy / dl; break; } }
            const wantVx = tgt.vel.x + ux * 45, wantVy = tgt.vel.y + uy * 45;
            const [gx, gy] = sf.gravity(p.pos.x, p.pos.y);
            const ax = (wantVx - p.vel.x) * 1.2 - gx, ay = (wantVy - p.vel.y) * 1.2 - gy; const am = Math.hypot(ax, ay);
            const err = wrap(Math.atan2(ay, ax) - p.angle);
            // shoot back at anything the sensors show within 90
            let fire = false; const e = w.ships.find(s => s.alive && s.faction === 'enemy' && s.kind !== 'sentinel' && w.time - s.sensedAt < 0.3 && Math.hypot(s.pos.x - p.pos.x, s.pos.y - p.pos.y) < 90);
            let turn = Math.max(-1, Math.min(1, err * 4));
            if (e) { const ea = Math.atan2(e.pos.y - p.pos.y, e.pos.x - p.pos.x); const ee = wrap(ea - p.angle); turn = Math.max(-1, Math.min(1, ee * 4)); fire = Math.abs(ee) < 0.15; }
            sf.controls({ turn, thrust: !e && am > 0.5 && Math.abs(err) < 0.5 ? Math.min(1, am / p.stats.thrust) : 0, fire });
            sf.step(1);
          }
          sf.controls(null);
          if (!p.alive) { sf.teleport(p.pos.x, p.pos.y, 0, 0, 0); }
          return { arrived, alive: p.alive, hull: p.hull };
        }, [wp.name, 120 * 60]);
        if (res.arrived) leg++;
        const snap = await page.evaluate(([since]) => {
          const sf = window.__sf, w = sf.game.world, p = w.player;
          const logs = w.log.filter(e => e.time >= since && e.kind !== 'rock-fall' && e.kind !== 'rock-rest').map(e => ({ t: Math.round(e.time), kind: e.kind, text: e.text }));
          return { time: w.time, logs, hull: p.hull, tracked: sf.tracked(), sig: sf.signature(), contact: sf.contact(), kills: w.kills, events: w.events.filter(e => !e.resolved && !e.failed).map(e => e.label), journal: w.journal.length, comms: w.comms.filter(c => c.time >= since).map(c => c.from + ': ' + c.text) };
        }, [lastLog]);
        lastLog = snap.time;
        for (const l of snap.logs) counts[l.kind] = (counts[l.kind] || 0) + 1;
        console.log(`  ${String(minute).padStart(2)}m -> ${wp.name}${res.arrived ? ' (arrived)' : ''} hull ${snap.hull.toFixed(0)} kills ${snap.kills} tracked ${snap.tracked} sig ${snap.sig.toFixed(2)} contact ${snap.contact ? snap.contact.age.toFixed(0) + 's' : 'none'} | ${snap.events.join('; ') || 'quiet'}`);
        for (const l of snap.logs) if (l.kind !== 'contact-lost' || l.text.includes('|') && !l.text.endsWith('THE DARK')) console.log(`      ${l.t}s ${l.kind}: ${l.text}`);
        for (const c of snap.comms) if (/LAUNCHING|DOWN|GONE|SILENT|DESTROYED|CRACKED|LOST|STOPPED|RESUMED|REPELLED|VECTORING/.test(c)) console.log(`      comm: ${c}`);
      }
      console.log('  log counts:', JSON.stringify(counts));
      const jn = await page.evaluate(() => window.__sf.journal());
      console.log('  journal:', jn.map(e => `${e.t}s ${e.text}`));
    }
  },

  /** Existing events under different conditions: a raid by day and by night, a siege in and out of the planet's shadow, a rescue during a flare. */
  async conditions({ page }) {
    await api.manual(page, true);
    const seed = 2024;
    // ---- raid: the player approaches the raided colony from behind the planet, engines off, day and night
    for (const day of ['day', 'night']) {
      await api.newGame(page, seed);
      await api.launch(page);
      const r = await page.evaluate(([day]) => {
        const sf = window.__sf, w = sf.game.world, p = w.player;
        sf.forceEvent('raid'); sf.step(1);
        const e = w.events.find(q => q.kind === 'raid'); const pad = e.target; const b = pad.body;
        const sunAng = Math.atan2(w.star.pos.y - b.pos.y, w.star.pos.x - b.pos.x);
        sf.spinTo(b.name, (day === 'day' ? sunAng : sunAng + Math.PI) - pad.angle); sf.step(1);
        // we start 250 above the pad, drifting in at 4 u/s, engines off
        const a = pad.angle + b.spinAngle;
        sf.teleport(b.pos.x + Math.cos(a) * (pad.height + 250), b.pos.y + Math.sin(a) * (pad.height + 250), b.vel.x - Math.cos(a) * 4, b.vel.y - Math.sin(a) * 4, a + Math.PI);
        let firstTracked = null, t = 0;
        for (; t < 120 * 90; t++) { sf.step(1); if (firstTracked === null && sf.tracked() > 0) firstTracked = t / 120; const alt = Math.hypot(p.pos.x - b.pos.x, p.pos.y - b.pos.y) - pad.height; if (alt < 20 || !p.alive) break; }
        const raiders = e.ships.filter(s => s.alive).map(s => `${s.kind}:${s.ai.mode}${s.ai.target === p ? '*' : ''} heat${s.heat.toFixed(2)}`);
        return { colony: pad.name, sun: sf.sun(p.pos.x, p.pos.y).toFixed(1), firstTracked, alive: p.alive, hull: p.hull, raiders, t: (t / 120).toFixed(0), label: e.label };
      }, [day]);
      console.log(`RAID on ${r.colony} (${day}): drifting in engines off for ${r.t} s, first tracked at ${r.firstTracked ?? 'never'} s, hull ${r.hull.toFixed(0)}; raiders ${r.raiders.join(' ')} | ${r.label}`);
    }
    // ---- siege: where the dreadnought sits relative to the planet's shadow, and whether its turrets ever jam
    await api.newGame(page, seed);
    await api.launch(page);
    const s = await page.evaluate(() => {
      const sf = window.__sf, w = sf.game.world;
      sf.forceEvent('siege'); sf.step(1);
      const e = w.events.find(q => q.kind === 'siege'); const st = e.target; const dn = e.ships.find(q => q.kind === 'dreadnought');
      const out = [];
      for (let t = 0; t < 120 * 240; t++) { sf.step(1); if (t % (120 * 30) === 0) out.push(`${t / 120}s station ${st.health.toFixed(0)} ${sf.sun(st.pos.x, st.pos.y) === 0 ? 'in shadow' : 'lit'}; dread ${dn.alive ? dn.hull.toFixed(0) + ' heat ' + dn.heat.toFixed(2) + (dn.overheated ? 'J' : '') + (sf.sun(dn.pos.x, dn.pos.y) === 0 ? ' shadow' : ' lit') : 'dead'} d${Math.hypot(dn.pos.x - st.pos.x, dn.pos.y - st.pos.y).toFixed(0)}`); if (!st.alive || !dn.alive) break; }
      return { station: st.name, out };
    });
    console.log(`SIEGE of ${s.station}, unattended:`, s.out.join(' | '));
    // ---- rescue during a flare: a stranded shuttle in sunlight versus in shadow
    await api.newGame(page, seed);
    await api.launch(page);
    const q = await page.evaluate(() => {
      const sf = window.__sf, w = sf.game.world;
      sf.forceEvent('stranded'); sf.step(1);
      const e = w.events.find(x => x.kind === 'stranded'); const sh = e.target;
      const shadow0 = sf.sun(sh.pos.x, sh.pos.y) === 0;
      sf.forceFlare();
      let t = 0; for (; t < 120 * 60 && sh.alive; t++) sf.step(1);
      return { shadow0, alive: sh.alive, hull: sh.hull.toFixed(0), t: (t / 120).toFixed(0), cause: sh.lastDamageSource };
    });
    console.log(`RESCUE + FLARE: shuttle started ${q.shadow0 ? 'in shadow' : 'in sunlight'}; after ${q.t} s it is ${q.alive ? 'alive, hull ' + q.hull : 'DEAD (' + q.cause + ')'}`);
  },

  // ------------------------------------------------------------------ the Lighthouse: land, sit out a flare, feed it, speak to it
  async lighthouse({ page }) {
    await api.manual(page, true);
    await api.newGame(page, 2024);
    await api.launch(page);
    await page.evaluate(() => window.__sf.buyAll());
    const lh = await page.evaluate(() => window.__sf.places().lighthouse);
    // approach from the dark side, 70 out, matching its motion
    const dark = await page.evaluate(() => { const w = window.__sf.game.world; const b = w.bodies.find(x => x.name === 'THE LIGHTHOUSE'); const ux = b.pos.x / Math.hypot(b.pos.x, b.pos.y), uy = b.pos.y / Math.hypot(b.pos.x, b.pos.y); return { x: b.pos.x + ux * 70, y: b.pos.y + uy * 70, vx: b.vel.x, vy: b.vel.y, a: Math.atan2(uy, ux) }; });
    await page.evaluate(([x, y, vx, vy, a]) => window.__sf.teleport(x, y, vx, vy, a), [dark.x, dark.y, dark.vx, dark.vy, dark.a]);
    const g0 = await page.evaluate(() => { const sf = window.__sf, p = sf.game.world.player; const [gx, gy] = sf.gravity(p.pos.x, p.pos.y); return { g: Math.hypot(gx, gy).toFixed(2), sun: sf.sun(p.pos.x, p.pos.y).toFixed(2), found: sf.places().lighthouse.found }; });
    console.log(`LIGHTHOUSE at ${Math.hypot(lh.x, lh.y).toFixed(0)} from the star; on its dark side 70 out: gravity ${g0.g}, sunlight ${g0.sun}, named yet ${g0.found}`);
    const res = await autoLand(page, 'THE LIGHTHOUSE', 'LIGHTHOUSE DECK', 120);
    console.log(`LAND on the deck: ${res.landed ? 'OK on ' + res.landed.pad : (res.alive ? 'NOT LANDED' : 'DEAD')} hull ${res.hull.toFixed(0)} fuel ${res.fuel.toFixed(0)} touch ${res.crashSpeed.toFixed(2)}`);
    if (!res.landed) console.log(res.log.slice(-5).map(l => `${l.t}s alt${l.alt} arc${l.arc} vr${l.vr} vt${l.vt}`).join(' | '));
    // a flare while landed on the deck
    const fl = await page.evaluate(() => { const sf = window.__sf, w = sf.game.world, p = w.player; sf.forceFlare(); const h0 = p.hull, heat0 = p.heat; for (let t = 0; t < 120 * 32; t++) sf.step(1); return { hull: h0 + ' -> ' + p.hull.toFixed(0), heat: heat0.toFixed(2) + ' -> ' + p.heat.toFixed(2), landed: !!p.landed, flareOver: !w.flare.active, sun: sf.sun(p.pos.x, p.pos.y).toFixed(2) }; });
    console.log('FLARE while on the deck:', JSON.stringify(fl));
    // the array's recorder, and whether the deck is named now
    const found = await page.evaluate(() => window.__sf.places());
    console.log('found:', found.discovered, '| recorder alive', found.logs.find(l => l.from === 'THE ARRAY').alive);
    // feed it: bring the Kiln's core onto its socket, then three pings on the peak
    const fed = await page.evaluate(() => {
      const sf = window.__sf, w = sf.game.world;
      const src = w.power.find(q => q.name === 'THE LIGHTHOUSE'); const core = w.pickups.find(k => k.role === 'core' && k.origin === 'THE KILN');
      const lh = src.body; const c = Math.cos(lh.spinAngle), s = Math.sin(lh.spinAngle);
      core.pos.x = lh.pos.x + src.socketLocal.x * c - src.socketLocal.y * s; core.pos.y = lh.pos.y + src.socketLocal.x * s + src.socketLocal.y * c; core.vel.x = lh.vel.x; core.vel.y = lh.vel.y;
      sf.step(30);
      const out = [];
      for (let n = 0; n < 3; n++) { let guard = 0; while (Math.abs(((w.time % 3) / 3)) > 0.03 && ((w.time % 3) / 3) < 0.97 && guard++ < 800) sf.step(1); sf.ping(); const t = w.time; for (let i = 0; i < 300; i++) sf.step(1); out.push({ pingedAt: (t % 3 / 3).toFixed(3), onBeat: w.slices.lighthouseOnBeat }); }
      const enemies = w.ships.filter(q => q.alive && q.faction === 'enemy');
      return { powered: src.powered, pings: out, stunned: enemies.filter(q => q.stunned > 200).length, of: enemies.length, stillUntil: (w.slices.tideStillUntil - w.time).toFixed(0), journal: sf.journal().map(e => e.text).filter(t => t.includes('ARRAY')), comms: w.comms.slice(-2).map(c => c.text) };
    });
    console.log('FED AND SPOKEN TO:', JSON.stringify(fed));
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
// an ad-hoc script: SF_SCRIPT=<path to an .mjs whose default export is async ({ page, api, helpers }) => {}>
scenarios.script = async ({ page }) => {
  const mod = await import(pathToFileURL(path.resolve(process.env.SF_SCRIPT)).href);
  await mod.default({ page, api, helpers: { autoLand, autoDock, autoFight, follow, chase, climb, pull } });
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
