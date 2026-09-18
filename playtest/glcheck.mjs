import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
const here = path.dirname(fileURLToPath(import.meta.url));
const argsSets = [
  ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  [],
];
for (const args of argsSets) {
  const browser = await chromium.launch({ headless: true, args });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const msgs = [];
  page.on('console', m => msgs.push(m.text()));
  await page.goto(pathToFileURL(path.join(here, 'glcheck.html')).href);
  await page.waitForTimeout(300);
  const out = await page.evaluate(() => window.__out);
  console.log('ARGS', JSON.stringify(args));
  console.log(JSON.stringify(out, null, 1));
  if (msgs.length) console.log('console:', msgs.slice(0, 5));
  await page.screenshot({ path: path.join(here, 'out', 'glcheck.png') });
  await browser.close();
  if (out && !out.error) break;
}
