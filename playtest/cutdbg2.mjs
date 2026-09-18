import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:4173/');
await page.waitForFunction(() => window.__sf && window.__sf.game);
const out = await page.evaluate(() => {
  const sf = window.__sf; sf.manual(true); sf.newGame(2024); sf.launch();
  const w = sf.game.world, p = w.player, S = w.slices, b = S.cutBody, f = S.cutFissure;
  const n = f.outline.length, half = n / 2;
  const pathL = []; for (let i = 0; i < half; i++) { const a = f.outline[i], c = f.outline[n - 1 - i]; pathL.push({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 }); }
  const ch = pathL[half - 2];
  // rest the ship on the chamber floor next to the regulator, latch, then thrust straight up
  sf.teleport(b.pos.x + ch.x, b.pos.y + ch.y, b.vel.x, b.vel.y, Math.atan2(ch.y, ch.x));
  for (let i = 0; i < 240; i++) { sf.controls({ thrust: 0 }); sf.step(1); }
  const up = Math.atan2(p.pos.y - b.pos.y, p.pos.x - b.pos.x);
  const latched = sf.tether();
  const reg = S.regulator;
  const log = [];
  const local = () => { const l = { x: p.pos.x - b.pos.x, y: p.pos.y - b.pos.y }; return `(${l.x.toFixed(1)},${l.y.toFixed(1)}) r=${Math.hypot(l.x, l.y).toFixed(1)}`; };
  // outline radii
  const radii = f.outline.map(v => Math.hypot(v.x, v.y).toFixed(0)).join(' ');
  for (let t = 0; t < 120 * 6; t++) {
    const err = Math.atan2(Math.sin(up - p.angle), Math.cos(up - p.angle));
    sf.controls({ turn: Math.max(-1, Math.min(1, err * 4)), thrust: 1 });
    sf.step(1);
    if (t % 40 === 0) log.push(`${(t / 120).toFixed(2)}s ship ${local()} vr=${((p.vel.x - b.vel.x) * Math.cos(up) + (p.vel.y - b.vel.y) * Math.sin(up)).toFixed(2)} ang=${p.angle.toFixed(2)} up=${up.toFixed(2)} landed=${p.landed ? 1 : 0} thrusting=${p.thrusting.toFixed(2)} fuel=${p.fuel.toFixed(0)} T=${p.tether ? p.tether.tension.toFixed(1) : 'x'} reg r=${Math.hypot(reg.pos.x - b.pos.x, reg.pos.y - b.pos.y).toFixed(1)} regTeth=${!!reg.tetheredBy} hull=${p.hull.toFixed(0)}`);
  }
  return { latched, radii, log };
});
console.log('latched', out.latched, '\noutline radii', out.radii);
console.log(out.log.join('\n'));
await browser.close();
