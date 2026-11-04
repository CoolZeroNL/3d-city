// Renders one place from live map data and reports on its buildings, to diagnose odd-looking
// models from user reports ("what is happening in my hometown?"). Runs on GitHub Actions through
// .github/workflows/inspect.yml; writes pictures and stats.json to inspect-out/.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const dist = join(root, 'dist');
const out = join(root, 'inspect-out');
mkdirSync(out, { recursive: true });
const hash = (process.env.INSPECT_PLACE || 'lat=51.9244&lon=4.4778&km=4&ex=1.4').replace(/^#/, '');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = createServer((req, res) => {
  let f = join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(4321, '127.0.0.1', r));

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
await ctx.addInitScript(() => { try { localStorage.setItem('yp:tip-pin', '1'); localStorage.setItem('yp:own', '1'); } catch {} });
const page = await ctx.newPage();
const log = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => log.push(`page error: ${e.message}`));
await page.goto(`http://127.0.0.1:4321/#${hash}`);
await page.waitForFunction(() => ['ready', 'error'].includes(window.__yourPlace?.stage), null, { timeout: 240000 }).catch(() => {});
await page.waitForTimeout(1500);
const report = await page.evaluate(() => ({ stage: window.__yourPlace.stage, source: window.__yourPlace.source, stats: window.__yourPlace.stats(), camera: window.__yourPlace.camera(), buildings: window.__yourPlace.inspect() }));
report.place = hash;
report.log = log;
writeFileSync(join(out, 'stats.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ stage: report.stage, source: report.source, stats: report.stats, count: report.buildings?.count, histogram: report.buildings?.histogram, strayBuildings: report.buildings?.strayBuildings, tiny: report.buildings?.tiny, vertexYMax: report.buildings?.vertexYMax }, null, 1));

await page.addStyleTag({ content: '.topbar,.fabs,.sheet,.attribution,.toast,.notice,.status{display:none!important}' });
const d0 = report.camera?.distance ?? 6000;
const views = [
  ['overview', null],
  ['close', { azimuth: 20, tilt: 55, distance: d0 * 0.3, targetE: 0, targetN: 0 }],
  ['closer', { azimuth: 20, tilt: 60, distance: d0 * 0.1, targetE: 0, targetN: 0 }],
  ['top', { azimuth: 0, tilt: 0.5, distance: d0 * 0.9, targetE: 0, targetN: 0 }],
];
for (const [name, cam] of views) {
  if (cam) await page.evaluate((c) => window.__yourPlace.setCamera(c), cam);
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, `${name}.jpg`), type: 'jpeg', quality: 88 });
}
// a closer look at the most slender building, if there is one
const s = report.buildings?.slender?.[0];
if (s) {
  await page.evaluate((c) => window.__yourPlace.setCamera(c), { azimuth: 30, tilt: 60, distance: Math.max(150, s.height * 4), targetE: s.e, targetN: s.n });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, 'slender.jpg'), type: 'jpeg', quality: 88 });
}
await browser.close();
server.close();
