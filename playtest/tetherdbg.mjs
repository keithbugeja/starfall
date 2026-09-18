import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:4173/');
await page.waitForFunction(() => window.__sf && window.__sf.game);
const out = await page.evaluate(() => {
  const sf = window.__sf; sf.manual(true); sf.newGame(2024); sf.launch();
  const w = sf.game.world, p = w.player;
  const home = w.bodies.find(b => b.kind === 'planet');
  sf.teleport(home.pos.x + 900, home.pos.y + 400, 0, 0, 0);
  sf.spawnCrate(-7, 0, 'wreck');
  const ok = sf.tether();
  const k = w.pickups.find(q => q.kind === 'wreck');
  const before = { ok, tether: !!p.tether, kAlive: k.alive, kTethered: !!k.tetheredBy, kmass: k.mass, kr: k.radius, dist: Math.hypot(k.pos.x - p.pos.x, k.pos.y - p.pos.y), alive: p.alive, docked: !!p.docked, landed: !!p.landed, mode: sf.game.mode };
  const log = [];
  for (let i = 0; i < 5; i++) {
    sf.controls({ thrust: 1 });
    sf.step(1);
    log.push({ i, tether: p.tether ? p.tether.tension.toFixed(2) : null, kAlive: k.alive, kTethered: !!k.tetheredBy, dist: Math.hypot(k.pos.x - p.pos.x, k.pos.y - p.pos.y).toFixed(3), pAlive: p.alive, hull: p.hull, comms: w.comms.slice(-1).map(c => c.text) });
  }
  return { before, log };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
