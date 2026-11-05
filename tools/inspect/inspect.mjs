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
// one or more places (the part of a share link after "#"), separated by spaces
const places = (process.env.INSPECT_PLACE || 'lat=51.9244&lon=4.4778&km=4&ex=1.4').split(/\s+/).filter(Boolean).map((h) => h.replace(/^#/, ''));

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
for (const [pi, hash] of places.entries()) {
  const tag = places.length > 1 ? `-${pi + 1}` : '';
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await ctx.addInitScript(() => { try { localStorage.setItem('yp:tip-pin', '1'); localStorage.setItem('yp:own', '1'); localStorage.setItem('yp:hint-mouse', '1'); } catch {} });
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
  writeFileSync(join(out, `stats${tag}.json`), JSON.stringify(report, null, 2));
  const b = report.buildings;
  console.log(hash, JSON.stringify({ stage: report.stage, relief: [report.stats?.minElev, report.stats?.maxElev].map((v) => Math.round(v)), count: b?.count, strayBuildings: b?.strayBuildings, groundBumps: b && { ...b.groundBumps, top: b.groundBumps.top.slice(0, 3) } }));

  await page.addStyleTag({ content: '.topbar,.fabs,.sheet,.attribution,.toast,.notice,.status{display:none!important}' });
  const d0 = report.camera?.distance ?? 6000;
  const views = [
    ['overview', null],
    ['close', { azimuth: 20, tilt: 55, distance: d0 * 0.3, targetE: 0, targetN: 0 }],
  ];
  // a close look at the building with the biggest ground bump, if any
  const bump = b?.groundBumps?.top?.[0];
  if (bump && bump.bump > 3) views.push(['bump', { azimuth: 30, tilt: 55, distance: Math.max(250, Math.sqrt(bump.area) * 6), targetE: bump.e, targetN: bump.n }]);
  for (const [name, cam] of views) {
    if (cam) await page.evaluate((c) => window.__yourPlace.setCamera(c), cam);
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(out, `${name}${tag}.jpg`), type: 'jpeg', quality: 85 });
  }
  await ctx.close();
}
await browser.close();
server.close();
