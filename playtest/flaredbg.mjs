import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:4173/');
await page.waitForFunction(() => window.__sf && window.__sf.game);
const out = await page.evaluate(() => {
  const sf = window.__sf; sf.manual(true); sf.newGame(80); sf.launch();
  const w = sf.game.world, p = w.player;
  // open space: 900 units from the star along +x, no bodies nearby
  sf.teleport(0, 2600, 0, 0, 0);
  sf.forceEvent('flare');
  sf.step(120 * 29);
  const h0 = p.hull, active0 = w.flare.active;
  sf.step(120 * 6);
  const h1 = p.hull;
  // docked ship during a flare
  sf.newGame(81);
  const w2 = sf.game.world, p2 = w2.player;
  sf.forceEvent('flare');
  sf.step(120 * 40);
  return { exposed: { h0, h1, activeAt29: active0, activeAt35: w.flare.active }, docked: { hull: p2.hull, docked: !!p2.docked, active: w2.flare.active, intensity: w2.flare.intensity } };
});
console.log(JSON.stringify(out));
await browser.close();
