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
import { buildWorld, VILLAGE, RURAL, synthesize } from './fixtures/synthetic-city.mjs';

const require = createRequire(import.meta.url);
let chromium;
let devices;
try {
  ({ chromium, devices } = require('playwright'));
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

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain' };
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

// a rural postcode: Photon returns the postcode area (its middle is open country) naming Kleinfelde
const postcodeFixture = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [RURAL.lon, RURAL.lat] }, properties: { name: '84999', city: 'Kleinfelde', country: 'Germany', osm_key: 'boundary', osm_value: 'postal_code' } }] };
const villageFixture = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [VILLAGE.lon, VILLAGE.lat] }, properties: { name: 'Kleinfelde', osm_key: 'place', osm_value: 'village', state: 'Bavaria', country: 'Germany' } }] };

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
    const body = lat > 48.4 && lat < 48.6 ? { type: 'FeatureCollection', features: [] } : reverseFixture;
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  await context.route(/photon\.komoot\.io\/api/, (route) => {
    counters.photon = (counters.photon ?? 0) + 1;
    const url = new URL(route.request().url());
    const q = url.searchParams.get('q') ?? '';
    let body = photon;
    if (url.searchParams.get('osm_tag') === 'place') body = villageFixture;
    else if (/84999/.test(q)) body = postcodeFixture;
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  await context.route(/nominatim\.openstreetmap\.org/, (route) =>
    (counters.nominatim = (counters.nominatim ?? 0) + 1) &&
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
async function findBuilding(page) {
  await still(page);
  return page.evaluate(() => {
    const yp = window.__yourPlace;
    for (let d = 0; d <= 320; d += 16)
      for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const x = innerWidth * 0.6 + sx * d;
        const y = innerHeight * 0.5 + sy * d;
        // only where the 3D view itself is on top (not under the tip, a card or the sheet)
        if (document.elementFromPoint(x, y)?.id !== 'scene') continue;
        const h = yp.pick(x, y);
        if (!h?.building || Math.hypot(h.e, h.n) <= 60) continue;
        // the building covers the pixels around too, so rounding of touch coordinates still hits it
        if ([[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => yp.pick(x + dx, y + dy)?.building)) return { x, y, e: h.e, n: h.n };
      }
    return null;
  });
}
const settle = (page, ms = 600) => page.waitForTimeout(ms);
/** Wait until the camera stops gliding: damping decays per frame, and software rendering draws few frames. */
async function still(page, ms = 20000) {
  await page.waitForFunction(() => !window.__yourPlace.moving(), null, { timeout: ms, polling: 100 }).catch(() => undefined);
  await page.waitForTimeout(200);
}

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
  const head = await page.evaluate(() => {
    const meta = (sel) => document.querySelector(sel)?.getAttribute('content') ?? '';
    let ld = null;
    try { ld = JSON.parse(document.querySelector('script[type="application/ld+json"]')?.textContent ?? ''); } catch {}
    return {
      title: document.title,
      description: meta('meta[name="description"]'),
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? '',
      ogImage: meta('meta[property="og:image"]'),
      twitterCard: meta('meta[name="twitter:card"]'),
      ld,
    };
  });
  expect(head.title.length > 20 && head.title.length <= 60, `page title fits search results (${head.title.length} characters)`);
  expect(head.description.length >= 100 && head.description.length <= 160, `meta description fits search results (${head.description.length} characters)`);
  expect(/^https:\/\/.+\/$/.test(head.canonical) && !head.canonical.includes('%'), `canonical link is an absolute URL (${head.canonical})`);
  expect(head.ogImage === `${head.canonical}og.jpg` && head.twitterCard === 'summary_large_image', 'link previews point at the preview image');
  expect(head.ld?.['@type'] === 'WebApplication' && head.ld.url === head.canonical, 'structured data describes the app');
  for (const f of ['og.jpg', 'sitemap.xml', 'robots.txt', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'screenshot.jpg']) {
    expect(existsSync(join(dist, f)), `build includes ${f}`);
  }
  const sitemap = readFileSync(join(dist, 'sitemap.xml'), 'utf8');
  expect(sitemap.includes(`<loc>${head.canonical}</loc>`) && sitemap.includes(`<loc>${head.canonical}about/</loc>`), 'sitemap lists the app and the about page');

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
  const insp = await page.evaluate(() => window.__yourPlace.inspect());
  expect(insp.count === t.stats.buildings && insp.strayBuildings === 0 && insp.tallest[0].height >= 100, `the inspection hook reports every building, none with stray geometry (${insp.count}, ${insp.strayBuildings} stray)`);
  const hash = await page.evaluate(() => location.hash);
  expect(/lat=48\.7765/.test(hash) && /cam=/.test(hash), 'URL hash holds coordinates and camera');
  expect(!/stuttgart/i.test(hash), 'URL hash holds no address text');
  expect(/Stuttgart/.test(await page.textContent('#place-title')), 'sheet shows the place name');
  expect(/^Stuttgart.* in 3D · Your Place$/.test(await page.title()), `browser tab names the place (“${await page.title()}”)`);
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
  // the area in 100 m steps, from the slider: 1.5 km, then back to 2 km
  const setArea = async (m) => {
    await page.$eval('#size-range', (el, v) => {
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, m);
    await page.waitForFunction(() => window.__yourPlace.stage !== 'ready', null, { timeout: 5000 }).catch(() => undefined);
    await waitStage(page, ['ready', 'error']);
    await still(page); // the camera's fly-in after a load would override keys pressed during it
  };
  await setArea(1500);
  expect(
    /km=1\.5(&|$)/.test(await page.evaluate(() => location.hash)) && (await page.textContent('#size-out')) === '1.5 × 1.5 km' && /^1\.5 × 1\.5 km around/.test(await page.textContent('#describe')),
    'the area can be any size in 100 m steps (1.5 km: share link, readout and description)',
  );
  await settle(page, 600);
  await shot(page, '03c-area-1500m');
  await setArea(2000);
  // one colour for all buildings: no legend, and the choice is kept
  for (const colour of ['grey', 'sand', 'dark']) {
    await page.click(`#style-group [data-value="${colour}"]`);
    await settle(page, 400);
    await shot(page, `04a-buildings-${colour}`);
  }
  expect((await page.evaluate(() => window.__yourPlace.state().style)) === 'dark' && !(await page.isVisible('#legend')), 'buildings can be one colour (grey, sand, dark), without the height legend');
  await page.click('#style-group [data-value="ramp"]');
  expect(await page.isVisible('#legend'), 'height legend appears with height colours');
  await page.focus('#scene');
  for (let k = 0; k < 7; k++) await page.keyboard.press('ArrowDown');
  for (let k = 0; k < 3; k++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('+');
  // headless software GL can pause drawing for a second or two here; as for the compass below,
  // wait for the movement's last frame rather than a fixed delay (moving() is still false right
  // after the key press, before the first frame)
  await page.waitForFunction(() => (window.__yourPlace.camera()?.tilt ?? 0) > 40 && !window.__yourPlace.moving(), null, { timeout: 15000 }).catch(() => undefined);
  await settle(page, 500);
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

  // 3D print file: a binary STL of the chosen size in millimetres
  await page.click('#share-btn');
  await page.waitForSelector('#share-dialog[open]');
  await page.click('#print-size-group [data-value="100"]');
  expect(/^1:20,000 · terrain ×3\.0$/.test(await page.textContent('#print-note')), 'print size shows its scale and exaggeration');
  // a print file, and its size: x, y, z extents in mm
  const stlBounds = (data) => {
    const count = data.readUInt32LE(80);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < count; k++)
      for (let q = 0; q < 9; q++) {
        const v = data.readFloatLE(84 + k * 50 + 12 + q * 4);
        lo[q % 3] = Math.min(lo[q % 3], v);
        hi[q % 3] = Math.max(hi[q % 3], v);
      }
    return { count, lo, hi, size: [0, 1, 2].map((a) => hi[a] - lo[a]), whole: data.length === 84 + 50 * count };
  };
  const printFile = async (name) => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#stl-btn')]);
    const path = join(out, name);
    await dl.saveAs(path);
    const data = readFileSync(path);
    const count = data.readUInt32LE(80);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < count; k++)
      for (let q = 0; q < 9; q++) {
        const v = data.readFloatLE(84 + k * 50 + 12 + q * 4);
        lo[q % 3] = Math.min(lo[q % 3], v);
        hi[q % 3] = Math.max(hi[q % 3], v);
      }
    return { dl, data, count, lo, hi, size: [0, 1, 2].map((a) => hi[a] - lo[a]) };
  };
  expect((await page.inputValue('#print-title')).length > 0, 'the title field starts with the place name');
  const plain = await printFile('06b-model.stl');
  expect(plain.data.length === 84 + 50 * plain.count && plain.count > 50000, `STL downloaded (${plain.dl.suggestedFilename()}, ${plain.count} triangles, ${(plain.data.length / 1048576).toFixed(1)} MB)`);
  expect(
    /-10cm\.stl$/.test(plain.dl.suggestedFilename()) && Math.abs(plain.size[0] - 100) < 0.01 && plain.size[1] > 105 && plain.size[1] < 120 && Math.abs(plain.lo[2] + 3) < 1e-4 && plain.hi[2] > 5,
    `STL is 100 mm wide on a 3 mm base, with the title ledge in front (${plain.size.map((v) => v.toFixed(2)).join(' × ')} mm)`,
  );
  expect(/^Saved: 10 × 1\d(\.\d)? cm with the title strip at 1:20,000/.test(await page.textContent('#share-msg')), 'the dialog confirms the print file and its ledge');
  expect(/Water sunk 1 mm\./.test(await page.textContent('#share-msg')), 'the river in the test city is sunk 1 mm in the print');
  // your own title and a second line make the ledge deeper and name the file
  await page.fill('#print-title', 'Our first home');
  await page.fill('#print-subtitle', 'Where we met · June 2019');
  const titled = await printFile('06c-titled.stl');
  expect(/^your-place-our-first-home-2km-10cm\.stl$/.test(titled.dl.suggestedFilename()) && titled.size[1] > plain.size[1] + 3, `your own title names the file and adds a second line (${titled.dl.suggestedFilename()}, ${titled.size[1].toFixed(1)} mm deep)`);
  // without the ledge: the plain square again
  await page.uncheck('#print-ledge');
  await page.uncheck('#print-water');
  const bare = await printFile('06d-no-ledge.stl');
  expect(!/Water sunk/.test(await page.textContent('#share-msg')), 'without the tick the water stays level');
  await page.check('#print-water');
  expect(Math.abs(bare.size[0] - 100) < 0.01 && Math.abs(bare.size[1] - 100) < 0.01, `without the title the print is the plain square (${bare.size.map((v) => v.toFixed(2)).join(' × ')} mm)`);
  // raised roads and parks: their own pieces on the terrain, and the dialog says so
  await page.check('#print-roads');
  await page.check('#print-green');
  const painted = await printFile('06h-roads-green.stl');
  const paintedMsg = await page.textContent('#share-msg');
  expect(
    /Roads raised 0\.4 mm\./.test(paintedMsg) && painted.count > bare.count + 1000 && Math.abs(painted.size[0] - 100) < 0.01 && Math.abs(painted.size[1] - 100) < 0.01,
    `raised roads add ${painted.count - bare.count} triangles and stay inside the square (${painted.size.map((v) => v.toFixed(2)).join(' × ')} mm)`,
  );
  expect(/Parks and woods raised 0\.6 mm\./.test(paintedMsg), 'the park and the forest in the test city are raised');
  await page.uncheck('#print-roads');
  await page.uncheck('#print-green');
  await page.check('#print-ledge');
  // tiles: 2 × 2 pieces of 10 cm in a ZIP, with the title ledge as its own piece
  const setTiles = (n) =>
    page.$eval('#tiles-range', (el, v) => {
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, n);
  await setTiles(8);
  expect((await page.textContent('#tiles-out')) === '8 × 8 tiles' && /^64 tiles, 80 × 80 cm in all · 1:2,500/.test(await page.textContent('#print-note')), `tiles go up to 8 × 8 (“${await page.textContent('#print-note')}”)`);
  await setTiles(2);
  expect(/^4 tiles, 20 × 20 cm in all · 1:10,000 · terrain ×3\.0$/.test(await page.textContent('#print-note')), `the tile choice shows the size in all and the scale (“${await page.textContent('#print-note')}”)`);
  const [zdl] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('#stl-btn')]);
  const zpath = join(out, '06f-tiles.zip');
  await zdl.saveAs(zpath);
  const zip = readFileSync(zpath);
  const files = {};
  {
    const end = zip.length - 22;
    let p = zip.readUInt32LE(end + 16);
    for (let k = 0; k < zip.readUInt16LE(end + 10); k++) {
      const nameLen = zip.readUInt16LE(p + 28);
      const size = zip.readUInt32LE(p + 24);
      const local = zip.readUInt32LE(p + 42);
      const start = local + 30 + zip.readUInt16LE(local + 26);
      files[zip.subarray(p + 46, p + 46 + nameLen).toString()] = zip.subarray(start, start + size);
      p += 46 + nameLen;
    }
  }
  const names = Object.keys(files).sort();
  expect(
    zdl.suggestedFilename() === 'your-place-our-first-home-2km-2x2-tiles-10cm.zip' && names.join() === 'README.txt,tile-A1.stl,tile-A2.stl,tile-B1.stl,tile-B2.stl,title.stl',
    `the tiles download as a ZIP: four tiles, the title ledge and a note (${zdl.suggestedFilename()}: ${names.join(', ')})`,
  );
  const tileSizes = ['A1', 'A2', 'B1', 'B2'].map((t) => stlBounds(files[`tile-${t}.stl`]));
  expect(
    tileSizes.every((b) => b.whole && b.count > 5000 && Math.abs(b.size[0] - 100) < 0.01 && Math.abs(b.size[1] - 100) < 0.01 && Math.abs(b.lo[2] + 3) < 1e-4),
    `each tile is 100 × 100 mm on the same 3 mm base (${tileSizes.map((b) => b.size.map((v) => v.toFixed(1)).join('×')).join(', ')})`,
  );
  expect(/A1 is the north-west corner/.test(files['README.txt'].toString()) && /sits 1 mm below the land/.test(files['README.txt'].toString()), 'the note in the ZIP explains how the tiles go together and that the water is sunk');
  expect(/^Saved: 4 tiles of 10 cm, 20 × 20 cm in all, and the title strip as its own piece, at 1:10,000/.test(await page.textContent('#share-msg')), 'the dialog confirms the tiles');
  // the largest split, in the browser: 64 tiles in one ZIP
  await setTiles(8);
  const t8 = Date.now();
  const [z8] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.click('#stl-btn')]);
  const z8path = join(out, '06g-tiles-8x8.zip');
  await z8.saveAs(z8path);
  const zip8 = readFileSync(z8path);
  const n8 = zip8.readUInt16LE(zip8.length - 22 + 10);
  expect(n8 === 66 && /-8x8-tiles-10cm\.zip$/.test(z8.suggestedFilename()), `8 × 8 tiles download in ${((Date.now() - t8) / 1000).toFixed(0)} s: ${n8} files, ${(zip8.length / 1048576).toFixed(1)} MB`);
  await setTiles(1);
  // the poster carries the title and the second line too
  const [titledPoster] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#poster-btn')]);
  expect(titledPoster.suggestedFilename() === 'your-place-our-first-home-2km.png', `the poster uses your own title (${titledPoster.suggestedFilename()})`);
  await titledPoster.saveAs(join(out, '06e-titled-poster.png'));
  await page.click('#share-btn');
  await page.keyboard.press('Escape');

  // reload from the link: same view
  const p2 = await desktop.newPage();
  watchConsole(p2, 'reload');
  await p2.goto(base + new URL(shareUrl).hash);
  const t2 = await waitStage(p2, ['ready', 'error']);
  const s2 = await p2.evaluate(() => window.__yourPlace.state());
  expect(t2.stage === 'ready', 'shared link rebuilds the model');
  await p2.waitForTimeout(2800);
  expect(!/shared with you/.test((await p2.evaluate(() => window.__yourPlace.notice())) ?? ''), 'your own link opens without the “make your own” invitation');
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
  // double-click: pin a spot and load the area around it in one go
  await settle(p2, 800);
  const spot3 = await findBuilding(p2);
  const before3 = await p2.evaluate(() => window.__yourPlace.state().center);
  if (spot3) await p2.mouse.dblclick(spot3.x, spot3.y);
  await p2
    .waitForFunction((b) => { const yp = window.__yourPlace; const c = yp.state().center; const pin = yp.state().pin; return c && pin && Math.abs(c.lat - pin.lat) < 1e-9 && Math.abs(c.lat - b.lat) + Math.abs(c.lon - b.lon) > 1e-6 && yp.stage === 'ready'; }, before3, { timeout: 120000 })
    .catch(() => undefined);
  const after3 = await p2.evaluate(() => ({ c: window.__yourPlace.state().center, pin: window.__yourPlace.state().pin }));
  expect(!!spot3 && !!after3.pin && Math.abs(after3.c.lat - after3.pin.lat) < 1e-9 && Math.abs(after3.c.lat - before3.lat) + Math.abs(after3.c.lon - before3.lon) > 1e-6, 'double-clicking a spot loads the area around it');
  // the mouse hint: shown on a computer until it's closed
  expect(await p2.isVisible('#mouse-hint'), 'a computer shows how to turn, slide and move the area');
  await p2.click('#mouse-hint-close');
  expect(!(await p2.isVisible('#mouse-hint')), 'the mouse hint closes');
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
  await vp.fill('#search-input', '84999');
  await vp.waitForSelector('#suggestions li[role="option"]');
  expect(/Postcode area/.test(await vp.textContent('#suggestions')), 'suggestions say what each result is ("Postcode area")');
  await vp.keyboard.press('ArrowDown');
  await vp.keyboard.press('Enter');
  await vp.waitForFunction((d) => { const s = window.__yourPlace.state(); return s.center && Math.abs(s.center.lat - d.lat) < 1e-4; }, VILLAGE, { timeout: 30000 }).catch(() => undefined);
  await waitStage(vp, ['ready', 'error']);
  const vs = await vp.evaluate(() => window.__yourPlace.state());
  expect(Math.abs(vs.center.lat - VILLAGE.lat) < 1e-4 && Math.abs(vs.center.lon - VILLAGE.lon) < 1e-4, 'a postcode search builds the model around its village, not the postcode area’s middle');
  expect(/Kleinfelde/.test(await vp.textContent('#place-title')) && /Postcode 84999/.test(await vp.textContent('#place-meta')), 'title names the village and keeps the postcode as context');
  expect((await vp.evaluate(() => window.__yourPlace.notice())) === null, 'no empty-square notice when there are buildings');
  await vp.close();

  const rp = await vctx.newPage();
  watchConsole(rp, 'rural');
  await rp.goto(`${base}#lat=${RURAL.lat}&lon=${RURAL.lon}&km=1&ex=2`);
  await waitStage(rp, ['ready', 'error']);
  await rp.waitForFunction(() => window.__yourPlace.notice(), null, { timeout: 20000 }).catch(() => undefined);
  const offer = await rp.evaluate(() => window.__yourPlace.notice());
  expect(/^No buildings are mapped here\. Kleinfelde \(village\) is \d\.\d km north-east\.$/.test(offer ?? ''), `an empty square offers the nearest village outside it (“${offer}”)`);
  expect(/No buildings are mapped in this square/.test(await rp.textContent('#describe')), 'the description says the square has no buildings');
  expect(/^Near /.test(await rp.textContent('#place-title')), `a link to open country is titled after the nearest village (“${await rp.textContent('#place-title')}”)`);
  await settle(rp, 1500);
  await shot(rp, '12-empty-square-offer');
  await rp.click('#notice-actions .btn-primary');
  await rp.waitForFunction((d) => { const yp = window.__yourPlace; const s = yp.state(); return s.center && Math.abs(s.center.lat - d.lat) < 1e-4 && yp.stage === 'ready'; }, VILLAGE, { timeout: 60000 }).catch(() => undefined);
  const jumped = await rp.evaluate(() => ({ s: window.__yourPlace.state(), stats: window.__yourPlace.stats(), notice: window.__yourPlace.notice() }));
  expect(Math.abs(jumped.s.center.lat - VILLAGE.lat) < 1e-4 && jumped.stats.buildings > 100 && jumped.notice === null, '“Go to Kleinfelde” moves the model to the village');
  expect(/Kleinfelde/.test(await rp.textContent('#place-title')), 'title follows the jump');
  await vctx.close();

  // ---------------- phone
  // reduced motion turns off the glide after a slide: it decays per frame, and software rendering
  // draws a phone-sized frame only a few times a second, so the model would still be gliding when tapped
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
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
  expect(!(await mp.isVisible('#mouse-hint')), 'phone: no mouse hint');
  await settle(mp, 1000);
  await shot(mp, '09b-pinned-phone');
  await mp.click('#sheet-toggle');
  await settle(mp, 400);
  await shot(mp, '10-sheet-phone');
  // double-tap (iOS Safari sends no dblclick for it, so the app detects two taps itself)
  await mp.click('#sheet-toggle');
  await settle(mp, 800);
  const dtap = await findBuilding(mp);
  const beforeD = await mp.evaluate(() => window.__yourPlace.state().center);
  if (dtap) {
    await mp.touchscreen.tap(dtap.x, dtap.y);
    await mp.waitForTimeout(120);
    await mp.touchscreen.tap(dtap.x, dtap.y);
  }
  await mp
    .waitForFunction((b) => { const yp = window.__yourPlace; const c = yp.state().center; const pin = yp.state().pin; return c && pin && Math.abs(c.lat - pin.lat) < 1e-9 && Math.abs(c.lat - b.lat) + Math.abs(c.lon - b.lon) > 1e-6 && yp.stage === 'ready'; }, beforeD, { timeout: 120000 })
    .catch(() => undefined);
  const afterD = await mp.evaluate(() => ({ c: window.__yourPlace.state().center, pin: window.__yourPlace.state().pin }));
  expect(!!dtap && !!afterD.pin && Math.abs(afterD.c.lat - afterD.pin.lat) < 1e-9 && Math.abs(afterD.c.lat - beforeD.lat) + Math.abs(afterD.c.lon - beforeD.lon) > 1e-6, `phone: double-tapping a spot loads the area around it (${dtap ? 'tapped' : 'no building found'})`);
  await phone.close();

  // ---------------- a browser that adds noise to canvas reads (Orion, Brave: fingerprinting protection)
  const nctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await routeAll(nctx);
  await nctx.addInitScript(() => {
    for (const C of [globalThis.CanvasRenderingContext2D, globalThis.OffscreenCanvasRenderingContext2D]) {
      if (!C) continue;
      const read = C.prototype.getImageData;
      C.prototype.getImageData = function (...args) {
        const img = read.apply(this, args);
        for (let i = 0; i < img.data.length; i++) if (Math.random() < 0.03) img.data[i] ^= 1;
        return img;
      };
    }
  });
  const np = await nctx.newPage();
  watchConsole(np, 'noisy canvas');
  await np.goto(`${base}#lat=${PLACE.lat}&lon=${PLACE.lon}&km=2&ex=1.5`);
  const tn = await waitStage(np, ['ready', 'error']);
  expect(
    tn.stage === 'ready' && Math.abs(tn.stats.minElev - t.stats.minElev) < 0.01 && Math.abs(tn.stats.maxElev - t.stats.maxElev) < 0.01,
    `terrain is exact even when the browser adds noise to canvas reads (${Math.round(tn.stats.minElev)}–${Math.round(tn.stats.maxElev)} m)`,
  );
  await nctx.close();

  // ---------------- search: house numbers, map links, and the invitation on shared links
  const sctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await routeAll(sctx);
  const sp = await sctx.newPage();
  watchConsole(sp, 'search');
  await sp.goto(base);
  await sp.waitForSelector('#welcome', { state: 'visible' });
  expect(/grew up/.test(await sp.textContent('#welcome-title')), 'the start screen leads with a place that matters to you');
  const nomBefore = counters.nominatim ?? 0;
  await sp.fill('#search-input', 'Königstraße 28, Stuttgart');
  await sp.waitForSelector('#suggestions li[role="option"]', { timeout: 5000 });
  const firstRow = await sp.textContent('#suggestions li[role="option"]');
  expect(/^Königstraße 28, Stuttgart.*Exact address/.test(firstRow ?? ''), `the typed address is offered first when the suggestions lack its house number (“${firstRow}”)`);
  await shot(sp, '11b-exact-address');
  await sp.keyboard.press('Enter');
  const ts = await waitStage(sp, ['ready', 'error']);
  expect((counters.nominatim ?? 0) > nomBefore && ts.stage === 'ready', 'Enter with a house number the suggestions lack asks Nominatim for the exact address');
  const photonBefore = counters.photon ?? 0;
  await sp.fill('#search-input', 'https://www.google.com/maps/place/Somewhere/@48.7790,9.1810,17z/data=!3m1!4b1!8m2!3d48.7800!4d9.1820');
  await sp.waitForTimeout(500);
  await sp.keyboard.press('Enter');
  await sp.waitForFunction(() => { const c = window.__yourPlace.state().center; return c && Math.abs(c.lat - 48.78) < 1e-6 && window.__yourPlace.stage === 'ready'; }, null, { timeout: 60000 }).catch(() => undefined);
  const linked = await sp.evaluate(() => window.__yourPlace.state().center);
  expect(Math.abs(linked.lat - 48.78) < 1e-6 && Math.abs(linked.lon - 9.182) < 1e-6, 'a pasted Google Maps link goes to the pinned place');
  expect((counters.photon ?? 0) === photonBefore, 'map links are not sent for suggestions');
  await sctx.close();

  const ictx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await routeAll(ictx);
  const ip = await ictx.newPage();
  watchConsole(ip, 'invite');
  await ip.goto(`${base}#lat=48.77650&lon=9.17720&km=1&ex=1.5`);
  await waitStage(ip, ['ready', 'error']);
  await ip.waitForFunction(() => /shared with you/.test(window.__yourPlace.notice() ?? ''), null, { timeout: 8000 }).catch(() => undefined);
  expect(/shared with you/.test((await ip.evaluate(() => window.__yourPlace.notice())) ?? ''), 'someone opening a shared link is invited to make their own place');
  await shot(ip, '13-shared-invite');
  await ip.click('#notice-actions .btn-primary');
  expect(await ip.evaluate(() => document.activeElement?.id === 'search-input' && document.activeElement.value === ''), '“Make my place” puts the cursor in an empty search box');
  await ictx.close();

  // ---------------- the "How it works" page, on a phone
  const aboutCtx = await browser.newContext({ ...devices['iPhone 13'] });
  await routeAll(aboutCtx);
  const ap = await aboutCtx.newPage();
  watchConsole(ap, 'about');
  const broken = [];
  ap.on('response', (r) => { if (r.url().startsWith(base) && r.status() >= 400) broken.push(`${r.status()} ${r.url()}`); });
  await ap.goto(`${base}about/`);
  await ap.waitForLoadState('load');
  expect(/How Your Place works/.test(await ap.title()), 'about page has its own title');
  expect((await ap.locator('h1').count()) === 1 && (await ap.locator('h2').count()) >= 5, 'about page has one h1 and its sections');
  expect(await ap.evaluate(() => document.querySelector('.shot img')?.naturalWidth > 0), 'about page screenshot loads');
  expect(broken.length === 0, `about page loads its own files (${broken.join(', ') || 'no 404s'})`);
  expect(await ap.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'about page: no horizontal overflow on a phone');
  expect(/OpenStreetMap contributors/.test(await ap.textContent('body')), 'about page credits OpenStreetMap');
  await shot(ap, '12-about-phone');
  await ap.click('.top .btn');
  await ap.waitForSelector('#welcome', { state: 'visible' });
  expect(new URL(ap.url()).pathname === '/', '“Open the app” goes back to the app');
  await aboutCtx.close();

  // ---------------- languages: Portuguese from the browser, German from the picker
  const ptCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'pt-BR', reducedMotion: 'reduce' });
  await routeAll(ptCtx);
  const lp = await ptCtx.newPage();
  watchConsole(lp, 'pt');
  await lp.goto(`${base}#lat=48.7765&lon=9.1772&km=1.5&ex=1.5`);
  const tPt = await waitStage(lp, ['ready', 'error']);
  await settle(lp, 800);
  const ptTexts = await lp.evaluate(() => ({
    lang: document.documentElement.lang,
    placeholder: document.getElementById('search-input').getAttribute('placeholder'),
    area: document.querySelector('label[for="size-range"]').textContent,
    size: document.getElementById('size-out').textContent,
    describe: document.getElementById('describe').textContent,
  }));
  expect(
    tPt.stage === 'ready' && ptTexts.lang === 'pt-BR' && ptTexts.placeholder === 'Busque um endereço ou lugar' && ptTexts.area === 'Área' && ptTexts.size === '1,5 × 1,5 km',
    `a Portuguese browser gets the app in Portuguese (“${ptTexts.placeholder}”, “${ptTexts.size}”)`,
  );
  expect(/em volta de|perto de/.test(ptTexts.describe) && /prédios/.test(ptTexts.describe), `the description is in Portuguese too (“${ptTexts.describe.slice(0, 80)}…”)`);
  // nothing marked for translation still shows its English text
  const leftover = await lp.evaluate(async () => {
    const html = await (await fetch('./')).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const english = new Map([...doc.querySelectorAll('[data-t]')].map((el) => [el.dataset.t, el.textContent.trim()]));
    return [...document.querySelectorAll('[data-t]')].filter((el) => el.textContent.trim() === english.get(el.dataset.t) && !/^(optional)$/.test(el.textContent.trim())).map((el) => el.dataset.t);
  });
  expect(leftover.length === 0, `no English left on the Portuguese page (${leftover.join(', ') || 'none'})`);
  await shot(lp, '12-portuguese');
  await lp.click('#share-btn');
  await settle(lp, 300);
  await shot(lp, '12a-portuguese-share');
  await lp.keyboard.press('Escape');
  // the picker switches to German and keeps the view
  await lp.selectOption('.about .lang-select', 'de');
  await lp.waitForLoadState('load');
  await waitStage(lp, ['ready', 'error']);
  const deTexts = await lp.evaluate(() => ({ lang: document.documentElement.lang, area: document.querySelector('label[for="size-range"]').textContent, hash: location.hash }));
  expect(deTexts.lang === 'de-DE' && deTexts.area === 'Gebiet' && /km=1\.5/.test(deTexts.hash), `the language picker switches to German and keeps the place (“${deTexts.area}”)`);
  await shot(lp, '12b-german');
  await lp.click('#share-btn');
  await settle(lp, 300);
  await shot(lp, '12c-german-share');
  await lp.keyboard.press('Escape');
  await lp.goto(base);
  await lp.waitForSelector('#welcome', { state: 'visible' });
  await shot(lp, '12d-german-welcome');
  await ptCtx.close();

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
