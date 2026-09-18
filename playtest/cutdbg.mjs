import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:4173/');
await page.waitForFunction(() => window.__sf && window.__sf.game);
const out = await page.evaluate(([fit]) => {
  const sf = window.__sf; sf.manual(true); sf.newGame(2024); sf.launch();
  if (fit === 'jets') sf.buyAll();
  const w = sf.game.world, p = w.player, S = w.slices, b = S.cutBody, f = S.cutFissure;
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  const n = f.outline.length, half = n / 2;
  const pathL = []; for (let i = 0; i < half; i++) { const a = f.outline[i], c = f.outline[n - 1 - i]; pathL.push({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 }); }
  const toW = l => ({ x: b.pos.x + l.x, y: b.pos.y + l.y });
  // put the ship at the chamber, resting, then latch and climb
  const ch = toW(pathL[half - 2]);
  sf.teleport(ch.x, ch.y, b.vel.x, b.vel.y, Math.atan2(ch.y - b.pos.y, ch.x - b.pos.x));
  for (let i = 0; i < 240; i++) { sf.controls({ thrust: 0 }); sf.step(1); }
  const latched = sf.tether();
  const reg = S.regulator;
  const log = [];
  const pts = pathL.slice().reverse();
  let idx = 0;
  const grav = () => { let gx = 0, gy = 0; for (const bb of w.bodies) { if (bb.mass <= 0) continue; const dx = bb.pos.x - p.pos.x, dy = bb.pos.y - p.pos.y; const d = Math.hypot(dx, dy); if (d >= bb.soi) continue; let a = bb.mass / Math.max(d, bb.radius * 0.6) ** 2; const fk = Math.max(0, Math.min(1, (bb.soi - d) / (bb.soi * 0.25))); a *= fk * fk * (3 - 2 * fk); gx += dx / d * a; gy += dy / d * a; } return [gx, gy]; };
  for (let t = 0; t < 120 * 40; t++) {
    const wp = toW(pts[idx]);
    const dx = wp.x - p.pos.x, dy = wp.y - p.pos.y, d = Math.hypot(dx, dy);
    if (d < 2.0 && idx < pts.length - 1) idx++;
    const [gx, gy] = grav();
    const sp = Math.min(fit === 'jets' ? 5 : 3.8, Math.max(1.2, d * 0.5));
    const ax = (b.vel.x + dx / d * sp - p.vel.x) * 2 - gx, ay = (b.vel.y + dy / d * sp - p.vel.y) * 2 - gy;
    const heading = Math.atan2(ay, ax), err = wrap(heading - p.angle);
    const fx = Math.cos(p.angle), fy = Math.sin(p.angle);
    const fwd = ax * fx + ay * fy, lat = ax * fy - ay * fx;
    const loadK = p.tether && p.tether.tension > 0 ? 1.7 : 1;
    const c = { turn: Math.max(-1, Math.min(1, err * 4)), thrust: Math.abs(err) < 0.45 && fwd > 0 ? Math.min(1, fwd * loadK / p.stats.thrust) : 0, retro: 0, strafe: 0, fire: false, boost: false };
    if (p.stats.strafe > 0) c.strafe = Math.max(-1, Math.min(1, lat / p.stats.strafe));
    if (p.stats.retro > 0 && fwd < 0) c.retro = Math.min(1, -fwd / p.stats.retro);
    sf.controls(c);
    sf.step(1);
    if (t % 60 === 0 || !p.alive) {
      const rd = Math.hypot(reg.pos.x - p.pos.x, reg.pos.y - p.pos.y);
      log.push(`${(t / 120).toFixed(1)}s wp${idx} d${d.toFixed(1)} landed=${p.landed ? 1 : 0} alt=${(Math.hypot(p.pos.x - b.pos.x, p.pos.y - b.pos.y)).toFixed(1)} thr=${c.thrust.toFixed(2)} err=${err.toFixed(2)} T=${p.tether ? p.tether.tension.toFixed(1) : 'x'} regd=${rd.toFixed(1)} hull=${p.hull.toFixed(0)} dmg=${p.lastDamageSource}`);
    }
    if (!p.alive) break;
  }
  sf.controls(null);
  return { latched, log, sentinels: w.ships.filter(s => s.kind === 'sentinel' && s.alive).map(s => ({ d: Math.hypot(s.pos.x - p.pos.x, s.pos.y - p.pos.y).toFixed(0), body: s.landed && s.landed.body.name })), powered: S.cutPowered };
}, [process.argv[2] ?? 'stock']);
console.log('latched', out.latched, 'powered', out.powered, 'sentinels', JSON.stringify(out.sentinels));
console.log(out.log.join('\n'));
await browser.close();
