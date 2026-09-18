import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:4173/');
await page.waitForFunction(() => window.__sf && window.__sf.game);
const out = await page.evaluate(() => {
  const sf = window.__sf; sf.manual(true); sf.newGame(1333);
  const w = sf.game.world, p = w.player, st = w.stations[0], b = st.orbit.parent;
  const moons = w.bodies.filter(m => m.orbit && m.orbit.parent === b).map(m => ({ name: m.name, r: m.orbit.radius, R: m.maxRadius }));
  const log = [];
  const d0 = Math.hypot(st.pos.x - b.pos.x, st.pos.y - b.pos.y);
  sf.launch();
  for (let t = 0; t <= 10; t += 1) {
    const near = w.bodies.map(bb => ({ n: bb.name, d: (Math.hypot(p.pos.x - bb.pos.x, p.pos.y - bb.pos.y) - bb.maxRadius).toFixed(0) })).sort((a, c) => a.d - c.d)[0];
    log.push({ t, alive: p.alive, hull: p.hull.toFixed(0), spd: Math.hypot(p.vel.x, p.vel.y).toFixed(1), nearest: near, dmg: p.lastDamageSource });
    sf.step(120);
  }
  return { parent: b.name, R: b.maxRadius, stationOrbit: d0.toFixed(0), moons, stationAngle: st.angle.toFixed(2), log };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
