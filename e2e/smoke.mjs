/**
 * End-to-end smoke test: builds nothing itself — run `npm run e2e` (build + this).
 *
 * Serves dist/, drives the app in headless Chromium, and saves screenshots to e2e/out/.
 * Overpass and the geocoders are answered from a deterministic synthetic fixture;
 * terrain tiles are real (downloaded once with curl into e2e/out/tiles/).
 * Fails on any console error, page error, or unmet expectation.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorld, DORSTADT, RURAL, synthesize } from './fixtures/synthetic-city.mjs';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not installed. Install it with `npm i -D playwright && npx playwright install chromium`.');
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const out = join(here, 'out');
const tiles = join(out, 'tiles');
mkdirSync(tiles, { recursive: true });
if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/ is missing — run `npm run build` first (or `npm run e2e`).');
  process.exit(2);
}

// ------------------------------------------------------------------ static server

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(dist, path);
  if (!file.startsWith(dist)) return res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return res.writeHead(404).end('not found');
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

// ------------------------------------------------------------------ network fixtures

const PLACE = { lat: 48.7765, lon: 9.1772, name: 'Stuttgart', city: 'Stuttgart', state: 'Baden-Württemberg', country: 'Germany' };
const photon = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [PLACE.lon, PLACE.lat] }, properties: { name: PLACE.name, state: PLACE.state, country: PLACE.country, osm_value: 'city' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [9.18, 48.78] }, properties: { name: 'Stuttgart Hauptbahnhof', city: 'Stuttgart', country: 'Germany' } },
  ],
};
const reverseFixture = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [PLACE.lon, PLACE.lat] }, properties: { district: 'Mitte', city: 'Stuttgart', country: 'Germany' } }] };

// a rural postcode: Photon returns the postcode area (its middle is open country) naming Dorstadt
const postcodeFixture = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [RURAL.lon, RURAL.lat] }, properties: { name: '38312', city: 'Dorstadt', country: 'Germany', osm_key: 'boundary', osm_value: 'postal_code' } }] };
const dorstadtFixture = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [DORSTADT.lon, DORSTADT.lat] }, properties: { name: 'Dorstadt', osm_key: 'place', osm_value: 'village', state: 'Lower Saxony', country: 'Germany' } }] };

let overpassMode = 'ok';
let tilesMode = 'ok';

// ---- fake OpenFreeMap: real vector tiles cut from the synthetic world
const geojsonvt = require('geojson-vt');
const vtpbf = require('vt-pbf');
const t0World = Date.now();
const world = Object.fromEntries(
  Object.entries(buildWorld()).map(([k, v]) => [k, (geojsonvt.default ?? geojsonvt)(v, { maxZoom: 14, indexMaxZoom: 4, extent: 4096, buffer: 64, tolerance: 1 })]),
);
console.log(`synthetic tile world indexed in ${Date.now() - t0World} ms`);
const TILE_TEMPLATE = 'https://tiles.openfreemap.org/planet/e2e/{z}/{x}/{y}.pbf';
function tileBytes(z, x, y) {
  const layers = {};
  for (const [name, idx] of Object.entries(world)) {
    const t = idx.getTile(z, x, y);
    if (t) layers[name] = t;
  }
  return Buffer.from(vtpbf.fromGeojsonVt(layers, { version: 2, extent: 4096 }));
}
const counters = { overpass: 0, tiles: 0 };

async function routeAll(context) {
  await context.route(/tiles\.openfreemap\.org\/planet(\?.*)?$/, (route) => {
    if (tilesMode === 'fail') return route.fulfill({ status: 503, body: 'down' });
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ tiles: [TILE_TEMPLATE], minzoom: 0, maxzoom: 14 }) });
  });
  await context.route(/tiles\.openfreemap\.org\/planet\/.+\.pbf/, (route) => {
    counters.tiles2d = (counters.tiles2d ?? 0) + 1;
    if (tilesMode === 'fail') return route.fulfill({ status: 503, body: 'down' });
    const m = /\/(\d+)\/(\d+)\/(\d+)\.pbf/.exec(route.request().url());
    route.fulfill({ status: 200, contentType: 'application/x-protobuf', headers: { 'access-control-allow-origin': '*' }, body: tileBytes(+m[1], +m[2], +m[3]) });
  });
  await context.route(/overpass|maps\.mail\.ru/, async (route) => {
    counters.overpass++;
    if (overpassMode === 'fail') return route.fulfill({ status: 504, body: 'Gateway Timeout' });
    const body = new URLSearchParams(route.request().postData() ?? '').get('data') ?? '';
    await new Promise((r) => setTimeout(r, 300)); // a little latency, like the real thing
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(synthesize(body)) });
  });
  await context.route(/photon\.komoot\.io\/reverse/, (route) => {
    const lat = Number(new URL(route.request().url()).searchParams.get('lat'));
    const body = lat > 52 && lat < 52.2 ? { type: 'FeatureCollection', features: [] } : reverseFixture;
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  await context.route(/photon\.komoot\.io\/api/, (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get('q') ?? '';
    let body = photon;
    if (url.searchParams.get('osm_tag') === 'place') body = dorstadtFixture;
    else if (/38312/.test(q)) body = postcodeFixture;
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  await context.route(/nominatim\.openstreetmap\.org/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify([{ lat: String(PLACE.lat), lon: String(PLACE.lon), name: 'Stuttgart', display_name: 'Stuttgart, Baden-Württemberg, Germany' }]) }),
  );
  await context.route(/elevation-tiles-prod\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/, async (route) => {
    counters.tiles++;
    const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url());
    const file = join(tiles, `${m[1]}-${m[2]}-${m[3]}.png`);
    if (!existsSync(file)) {
      try {
        execFileSync('curl', ['-sS', '-f', '-m', '30', '-o', file, route.request().url()]);
      } catch {
        return route.fulfill({ status: 502, body: 'tile download failed' });
      }
    }
    route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: readFileSync(file) });
  });
}

// ------------------------------------------------------------------ helpers

const failures = [];
const expect = (cond, msg) => {
  if (!cond) failures.push(msg);
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
};

function watchConsole(page, label) {
  page.on('console', (m) => {
    if (m.type() === 'error') failures.push(`[${label}] console error: ${m.text()}`);
    if (m.type() === 'warning' && !/GPU stall|ReadPixels|swiftshader/i.test(m.text())) console.log(`[${label}] warning: ${m.text()}`);
  });
  page.on('pageerror', (e) => failures.push(`[${label}] page error: ${e.message}`));
}

function watchConsoleLenient(page, label) {
  page.on('pageerror', (e) => failures.push(`[${label}] page error: ${e.message}`));
}

async function waitStage(page, stages, timeout = 180000) {
  await page.waitForFunction((s) => s.includes(window.__yourPlace?.stage), stages, { timeout, polling: 250 });
  return page.evaluate(() => ({ stage: window.__yourPlace.stage, timings: window.__yourPlace.timings, stats: window.__yourPlace.stats() }));
}

const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });

/** Screen point over a building, away from the centre (searching outwards from the middle of the view). */
function findBuilding(page) {
  return page.evaluate(() => {
    const yp = window.__yourPlace;
    for (let d = 0; d <= 320; d += 16)
      for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const x = innerWidth * 0.6 + sx * d;
        const y = innerHeight * 0.5 + sy * d;
        const h = yp.pick(x, y);
        if (h?.building && Math.hypot(h.e, h.n) > 60) return { x, y, e: h.e, n: h.n };
      }
    return null;
  });
}
const settle = (page, ms = 600) => page.waitForTimeout(ms);

// ------------------------------------------------------------------ run

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
try {
  // ---------------- desktop
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
  await routeAll(desktop);
  const page = await desktop.newPage();
  watchConsole(page, 'desktop');
  await page.goto(base);
  await page.waitForSelector('#welcome', { state: 'visible' });
  expect((await page.locator('.preset').count()) === 6, 'landing shows 6 preset places');
  await shot(page, '01-landing-desktop');

  await page.fill('#search-input', 'Stuttgart');
  await page.waitForSelector('#suggestions li[role="option"]', { timeout: 5000 });
  expect((await page.locator('#suggestions li[role="option"]').count()) === 2, 'type-ahead shows suggestions');
  await page.keyboard.press('ArrowDown');
  expect((await page.getAttribute('#search-input', 'aria-activedescendant')) === 'sugg-0', 'arrow keys move through suggestions');
  await page.keyboard.press('Enter');
  const t = await waitStage(page, ['ready', 'error']);
  console.log('timings (ms, SwiftShader software GL):', JSON.stringify(Object.fromEntries(Object.entries(t.timings).map(([k, v]) => [k, Math.round(v)]))));
  console.log('stats:', JSON.stringify(t.stats));
  expect(t.stage === 'ready', 'model reaches ready state');
  expect((await page.evaluate(() => window.__yourPlace.source)) === 'tiles', 'map data comes from vector tiles');
  expect(t.stats.buildings > 1000, `buildings are extruded (${t.stats.buildings})`);
  expect(t.stats.maxElev - t.stats.minElev > 20, `terrain has relief (${Math.round(t.stats.minElev)}–${Math.round(t.stats.maxElev)} m)`);
  expect(t.stats.tallest >= 100, `building heights come from the data (tallest ${Math.round(t.stats.tallest)} m)`);
  const hash = await page.evaluate(() => location.hash);
  expect(/lat=48\.7765/.test(hash) && /cam=/.test(hash), 'URL hash holds coordinates and camera');
  expect(!/stuttgart/i.test(hash), 'URL hash holds no address text');
  expect(/Stuttgart/.test(await page.textContent('#place-title')), 'sheet shows the place name');
  expect(/buildings/.test(await page.textContent('#describe')), 'text description lists buildings');
  await settle(page, 2200);
  await shot(page, '02-model-desktop');

  // controls
  await page.click('#contour-switch');
  await page.$eval('#ex-range', (el) => {
    el.value = '3';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(page, 900);
  expect((await page.textContent('#ex-out')) === '×3.0', 'exaggeration slider updates its readout');
  await shot(page, '03-contours-exaggerated');
  await page.click('#style-group [data-value="ramp"]');
  expect(await page.isVisible('#legend'), 'height legend appears with height colours');
  await page.focus('#scene');
  for (let k = 0; k < 7; k++) await page.keyboard.press('ArrowDown');
  for (let k = 0; k < 3; k++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('+');
  await settle(page, 1500);
  const cam = await page.evaluate(() => window.__yourPlace.camera());
  await shot(page, '04-height-colours-tilted');
  await page.click('[data-layer="roads"]');
  await settle(page, 500);
  expect((await page.getAttribute('[data-layer="roads"]', 'aria-pressed')) === 'false', 'road layer toggles off');
  await page.click('[data-layer="roads"]');

  // compass reset
  await page.click('#compass-btn');
  // software GL renders slowly; wait for the animation's last frame rather than a fixed delay
  await page.waitForFunction(() => Math.abs(window.__yourPlace.camera()?.azimuth ?? 99) < 1, null, { timeout: 15000 }).catch(() => undefined);
  const az = await page.evaluate(() => window.__yourPlace.camera()?.azimuth ?? 0);
  expect(Math.abs(az) < 1, `compass resets to north (azimuth ${az?.toFixed?.(1)})`);
  expect(cam && cam.tilt > 40, `keyboard tilts the camera (tilt ${cam?.tilt?.toFixed?.(1)}°)`);

  // the pin: click a building → the pin moves onto it, the building is marked, the link carries it
  const spot = await findBuilding(page);
  expect(!!spot, 'a building can be picked under the cursor');
  await page.mouse.click(spot.x, spot.y);
  await page.waitForFunction(() => /pin=/.test(location.hash), null, { timeout: 5000 }).catch(() => undefined);
  const pin = await page.evaluate(() => window.__yourPlace.pin());
  expect(pin?.marked && Math.hypot(pin.e - spot.e, pin.n - spot.n) < 1, 'clicking a building moves the pin onto it and marks it');
  expect(/^Pin moved to this building/.test((await page.evaluate(() => window.__yourPlace.notice())) ?? ''), 'a notice confirms the pin and offers “Centre here”');
  expect(/pin=48\.\d{5},9\.\d{5}/.test(await page.evaluate(() => location.hash)), 'the link carries the pin as coordinates');
  await settle(page, 1200);
  await shot(page, '04b-pinned-building');
  await page.mouse.move(spot.x, spot.y);
  await page.mouse.down();
  await page.mouse.move(spot.x + 140, spot.y + 10, { steps: 8 });
  await page.mouse.up();
  const pinAfterDrag = await page.evaluate(() => window.__yourPlace.pin());
  expect(pinAfterDrag && Math.abs(pinAfterDrag.e - pin.e) < 1e-6 && Math.abs(pinAfterDrag.n - pin.n) < 1e-6, 'dragging turns the model but leaves the pin');
  const slideFrom = await page.evaluate(() => window.__yourPlace.camera());
  await page.focus('#scene');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowUp');
  await page
    .waitForFunction((b) => { const c = window.__yourPlace.camera(); return Math.hypot(c.targetE - b.targetE, c.targetN - b.targetN) > 50; }, slideFrom, { timeout: 15000 })
    .catch(() => undefined);
  const slideTo = await page.evaluate(() => window.__yourPlace.camera());
  expect(Math.hypot(slideTo.targetE - slideFrom.targetE, slideTo.targetN - slideFrom.targetN) > 50, 'Shift + arrow keys slide the model');

  // share + poster
  await page.click('#share-btn');
  await page.waitForSelector('#share-dialog[open]');
  const shareUrl = await page.inputValue('#share-url');
  expect(shareUrl.includes('#lat='), 'share dialog shows the link');
  await shot(page, '05-share-dialog');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#poster-btn')]);
  const posterPath = join(out, '06-poster.png');
  await download.saveAs(posterPath);
  const posterSize = statSync(posterPath).size;
  expect(posterSize > 200000, `poster PNG downloaded (${download.suggestedFilename()}, ${Math.round(posterSize / 1024)} KB)`);

  // reload from the link: same view
  const p2 = await desktop.newPage();
  watchConsole(p2, 'reload');
  await p2.goto(base + new URL(shareUrl).hash);
  const t2 = await waitStage(p2, ['ready', 'error']);
  const s2 = await p2.evaluate(() => window.__yourPlace.state());
  expect(t2.stage === 'ready', 'shared link rebuilds the model');
  expect(s2.contours === true && s2.style === 'ramp' && Math.abs(s2.exaggeration - 3) < 1e-6, 'shared link restores settings');
  expect(/Mitte|Stuttgart/.test(await p2.textContent('#place-title')), 'shared link resolves a neighbourhood name');
  const pin2 = await p2.evaluate(() => window.__yourPlace.pin());
  expect(pin2?.marked && Math.hypot(pin2.e - pin.e, pin2.n - pin.n) < 2, 'shared link puts the pin back on the same building');
  // "Centre here": a new square around the pinned building
  const spot2 = await findBuilding(p2);
  await p2.mouse.click(spot2.x, spot2.y);
  await p2.waitForFunction(() => /^Pin moved/.test(window.__yourPlace.notice() ?? ''), null, { timeout: 5000 }).catch(() => undefined);
  const wanted = await p2.evaluate(() => window.__yourPlace.state().pin);
  await p2.click('#notice-actions .btn-primary');
  await p2
    .waitForFunction((w) => { const yp = window.__yourPlace; const c = yp.state().center; return c && Math.abs(c.lat - w.lat) < 1e-9 && yp.stage === 'ready'; }, wanted, { timeout: 120000 })
    .catch(() => undefined);
  const centred = await p2.evaluate(() => ({ c: window.__yourPlace.state().center, pin: window.__yourPlace.pin() }));
  expect(
    centred.c && Math.abs(centred.c.lat - wanted.lat) < 1e-9 && Math.abs(centred.c.lon - wanted.lon) < 1e-9 && centred.pin?.marked && Math.hypot(centred.pin.e, centred.pin.n) < 0.01,
    '“Centre here” builds a new square around the pinned building',
  );
  await p2.close();

  // map tiles down → Overpass fallback still builds the model
  tilesMode = 'fail';
  const pf = await desktop.newPage();
  watchConsoleLenient(pf, 'tiles-down');
  await pf.goto(`${base}#lat=48.7765&lon=9.1772&km=1&ex=1.5`);
  const tf = await waitStage(pf, ['ready', 'error']);
  expect(tf.stage === 'ready' && (await pf.evaluate(() => window.__yourPlace.source)) === 'overpass' && tf.stats.buildings > 100, 'map tiles down → falls back to Overpass and still builds');
  await pf.close();

  // failure path: both sources down → terrain still shows, retry offered
  overpassMode = 'fail';
  const p3 = await desktop.newPage();
  p3.on('pageerror', (e) => failures.push(`[failure] page error: ${e.message}`));
  // a different spot than the fallback test above, whose Overpass answers are cached by now
  await p3.goto(`${base}#lat=48.7800&lon=9.1820&km=1&ex=1.5`);
  const t3 = await waitStage(p3, ['error', 'ready']);
  expect(t3.stage === 'error', 'Overpass outage is reported');
  expect(await p3.isVisible('#status .retry'), 'a Retry button is offered');
  await settle(p3, 1500);
  await shot(p3, '07-overpass-down');
  overpassMode = 'ok';
  tilesMode = 'ok';
  await p3.click('#status .retry');
  const t3b = await waitStage(p3, ['ready'], 180000);
  expect(t3b.stage === 'ready', 'Retry recovers once Overpass answers');
  await p3.close();
  await desktop.close();

  // ---------------- villages: postcode search and empty squares
  const vctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await routeAll(vctx);
  const vp = await vctx.newPage();
  watchConsole(vp, 'village');
  await vp.goto(base);
  await vp.fill('#search-input', '38312');
  await vp.waitForSelector('#suggestions li[role="option"]');
  expect(/Postcode area/.test(await vp.textContent('#suggestions')), 'suggestions say what each result is ("Postcode area")');
  await vp.keyboard.press('ArrowDown');
  await vp.keyboard.press('Enter');
  await vp.waitForFunction((d) => { const s = window.__yourPlace.state(); return s.center && Math.abs(s.center.lat - d.lat) < 1e-4; }, DORSTADT, { timeout: 30000 }).catch(() => undefined);
  await waitStage(vp, ['ready', 'error']);
  const vs = await vp.evaluate(() => window.__yourPlace.state());
  expect(Math.abs(vs.center.lat - DORSTADT.lat) < 1e-4 && Math.abs(vs.center.lon - DORSTADT.lon) < 1e-4, 'a postcode search builds the model around its village, not the postcode area’s middle');
  expect(/Dorstadt/.test(await vp.textContent('#place-title')) && /Postcode 38312/.test(await vp.textContent('#place-meta')), 'title names the village and keeps the postcode as context');
  expect((await vp.evaluate(() => window.__yourPlace.notice())) === null, 'no empty-square notice when there are buildings');
  await vp.close();

  const rp = await vctx.newPage();
  watchConsole(rp, 'rural');
  await rp.goto(`${base}#lat=${RURAL.lat}&lon=${RURAL.lon}&km=1&ex=2`);
  await waitStage(rp, ['ready', 'error']);
  await rp.waitForFunction(() => window.__yourPlace.notice(), null, { timeout: 20000 }).catch(() => undefined);
  const offer = await rp.evaluate(() => window.__yourPlace.notice());
  expect(/^No buildings are mapped here\. Dorstadt \(village\) is \d\.\d km north-east\.$/.test(offer ?? ''), `an empty square offers the nearest village outside it (“${offer}”)`);
  expect(/No buildings are mapped in this square/.test(await rp.textContent('#describe')), 'the description says the square has no buildings');
  expect(/^Near /.test(await rp.textContent('#place-title')), `a link to open country is titled after the nearest village (“${await rp.textContent('#place-title')}”)`);
  await settle(rp, 1500);
  await shot(rp, '12-empty-square-offer');
  await rp.click('#notice-actions .btn-primary');
  await rp.waitForFunction((d) => { const yp = window.__yourPlace; const s = yp.state(); return s.center && Math.abs(s.center.lat - d.lat) < 1e-4 && yp.stage === 'ready'; }, DORSTADT, { timeout: 60000 }).catch(() => undefined);
  const jumped = await rp.evaluate(() => ({ s: window.__yourPlace.state(), stats: window.__yourPlace.stats(), notice: window.__yourPlace.notice() }));
  expect(Math.abs(jumped.s.center.lat - DORSTADT.lat) < 1e-4 && jumped.stats.buildings > 100 && jumped.notice === null, '“Go to Dorstadt” moves the model to the village');
  expect(/Dorstadt/.test(await rp.textContent('#place-title')), 'title follows the jump');
  await vctx.close();

  // ---------------- phone
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await routeAll(phone);
  const mp = await phone.newPage();
  watchConsole(mp, 'phone');
  await mp.goto(base);
  await shot(mp, '08-landing-phone');
  await mp.click('.preset >> text=Heidelberg');
  const t4 = await waitStage(mp, ['ready', 'error']);
  expect(t4.stage === 'ready', 'phone: preset builds');
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(!overflow, 'phone: no horizontal overflow');
  await settle(mp, 2000);
  await shot(mp, '09-model-phone');
  // two fingers slide the model (no turning); one tap pins a building
  const cdp = await phone.newCDPSession(mp);
  const camA = await mp.evaluate(() => window.__yourPlace.camera());
  const fingers = (dy) => [{ x: 150, y: 400 + dy, id: 0 }, { x: 240, y: 400 + dy, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(0) });
  for (let k = 1; k <= 8; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(k * 12) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await settle(mp, 1500);
  const camB = await mp.evaluate(() => window.__yourPlace.camera());
  expect(
    Math.hypot(camB.targetE - camA.targetE, camB.targetN - camA.targetN) > 20 && Math.abs(camB.azimuth - camA.azimuth) < 2 && Math.abs(camB.tilt - camA.tilt) < 2,
    `phone: two fingers slide the model without turning it (moved ${Math.round(Math.hypot(camB.targetE - camA.targetE, camB.targetN - camA.targetN))} m)`,
  );
  const tapAt = await findBuilding(mp);
  if (tapAt) await mp.touchscreen.tap(tapAt.x, tapAt.y);
  await mp.waitForFunction(() => window.__yourPlace.pin()?.marked, null, { timeout: 5000 }).catch(() => undefined);
  expect(!!tapAt && (await mp.evaluate(() => window.__yourPlace.pin()?.marked)), 'phone: tapping a building pins it');
  await settle(mp, 1000);
  await shot(mp, '09b-pinned-phone');
  await mp.click('#sheet-toggle');
  await settle(mp, 400);
  await shot(mp, '10-sheet-phone');
  await phone.close();

  // ---------------- dark mode, reduced motion
  const dark = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  await routeAll(dark);
  const dp = await dark.newPage();
  watchConsole(dp, 'dark');
  await dp.goto(`${base}#lat=38.7139&lon=-9.1365&km=2&ex=2`);
  const t5 = await waitStage(dp, ['ready', 'error']);
  expect(t5.stage === 'ready', 'dark mode: model builds');
  expect(t5.stats.seaShare > 0.03 && t5.stats.seaShare < 0.2, `coastline fills the sea (${(t5.stats.seaShare * 100).toFixed(1)}% of the square)`);
  expect(t5.stats.minElev > -5, `no sea-floor pits left (min ${t5.stats.minElev.toFixed(1)} m)`);
  await settle(dp, 2000);
  await shot(dp, '11-dark-lisbon');
  await dark.close();
} catch (err) {
  failures.push(`exception: ${err.stack ?? err}`);
} finally {
  await browser.close();
  server.close();
}

writeFileSync(join(out, 'counters.json'), JSON.stringify(counters));
if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`\nAll e2e checks passed. Screenshots in ${out}`);
