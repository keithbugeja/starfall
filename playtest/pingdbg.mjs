import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:4173/');
await page.waitForFunction(() => window.__sf && window.__sf.game);
const out = await page.evaluate(() => {
  const sf = window.__sf; sf.manual(true); sf.newGame(2024); sf.launch();
  const w = sf.game.world, p = w.player, S = w.slices, R = S.rock;
  sf.teleport(R.pos.x + 200, R.pos.y, R.vel.x, R.vel.y, 0);
  sf.ping();
  const log = [];
  for (let t = 0; t < 120 * 2.5; t++) {
    sf.step(1);
    if (t % 30 === 0) log.push({ t: (t / 120).toFixed(2), pings: w.pings.map(q => ({ r: q.r.toFixed(0), echo: q.echo, hit: q.bodiesHit ? q.bodiesHit.size : -1 })), dRock: Math.hypot(R.pos.x - p.pos.x, R.pos.y - p.pos.y).toFixed(0), hollow: R.hollow, events: w.pingEvents.length, boxFlash: S.blackBox.flashUntil > w.time });
  }
  return log;
});
console.log(JSON.stringify(out));
await browser.close();
