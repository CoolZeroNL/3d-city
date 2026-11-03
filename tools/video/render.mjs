// Renders the promo video from live map data: each place turns slowly for a few seconds with a caption,
// then an end card with the address. Frames are captured one by one (exact timing even with software
// rendering) and encoded with ffmpeg. Runs on GitHub Actions, where the map services are reachable:
// see .github/workflows/video.yml. Output: video-out/your-place-9x16.mp4 and your-place-16x9.mp4.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = join(import.meta.dirname, '..', '..');
const dist = join(root, 'dist');
const out = join(root, 'video-out');
mkdirSync(out, { recursive: true });

const SITE = 'yourplace3d.github.io/3d-city';
const FPS = 30;
const SCENE_S = 4.6; // seconds per place
const DIP_S = 0.35; // fade through the background between places
const END_S = 3.2;

const SCENES = [
  { place: 'Hong Kong', hash: 'lat=22.2795&lon=114.1605&km=2&ex=1', lines: ['Any address', 'as a 3D model'] },
  { place: 'Porto', hash: 'lat=41.1405&lon=-8.6110&km=2&ex=1.5', lines: ['Real terrain.', 'Every building.'] },
  // 1 km side-on: the cut side wall shows the drop from the village on the rim into the canyon
  { place: 'Grand Canyon Village', hash: 'lat=36.0590&lon=-112.1385&km=1&ex=1', lines: ['Cliffs and canyons,', 'to scale'], az: [115, 70] },
  { place: 'Salzburg', hash: 'lat=47.7985&lon=13.0455&km=2&ex=1.5', lines: ['Save a poster,', 'or 3D print it'] },
];

const FORMATS = [
  { key: 'vertical', file: 'your-place-9x16.mp4', width: 1080, height: 1920 },
  { key: 'wide', file: 'your-place-16x9.mp4', width: 1920, height: 1080 },
];

const DEFAULT_AZ = [-28, 24]; // camera sweep in degrees: 0 looks north, 180 looks south

// ------------------------------------------------------------------ static server for dist/

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = createServer((req, res) => {
  let f = join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(4321, '127.0.0.1', r));
const base = 'http://127.0.0.1:4321/';

// ------------------------------------------------------------------ the text layer drawn over the model

const icon = readFileSync(join(root, 'public', 'icon.svg'), 'utf8');
const OVERLAY_CSS = `
  .topbar, .fabs, .sheet, .attribution, .toast, .notice, .status, .welcome { display: none !important; }
  #promo { position: fixed; inset: 0; z-index: 100; pointer-events: none; color: #1e1c19;
    --paper: radial-gradient(120% 90% at 50% 30%, #f4f1ec 0%, #d9d3c8 100%); }
  #promo .scrim-top, #promo .scrim-bottom { position: absolute; left: 0; right: 0; }
  #promo .scrim-left { display: none; }
  #promo .scrim-top { top: 0; background: linear-gradient(#f2efe9 30%, rgba(242,239,233,0)); }
  #promo .scrim-bottom { bottom: 0; background: linear-gradient(rgba(222,216,206,0), #ded8ce 70%); }
  #promo .brand { position: absolute; font: 650 26px/1 Inter, sans-serif; letter-spacing: 0.18em; text-transform: uppercase; color: #b13a15; }
  #promo .caption { position: absolute; opacity: var(--cap, 0); transform: translateY(calc((1 - var(--cap, 0)) * 18px)); }
  #promo .caption div { font: 500 var(--cap-size)/1.04 Fraunces, Georgia, serif; letter-spacing: -0.015em; }
  #promo .place { position: absolute; opacity: var(--cap, 0); font: 600 28px/1 Inter, sans-serif; letter-spacing: 0.16em; text-transform: uppercase; color: #5c564d; }
  #promo .credit { position: absolute; font: 400 18px/1 Inter, sans-serif; color: #8a8378; }
  #promo .dip { position: absolute; inset: 0; background: var(--paper); opacity: var(--dip, 1); }
  #promo .end { position: absolute; inset: 0; background: var(--paper); opacity: var(--end, 0);
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; text-align: center; }
  #promo .end svg { width: 150px; height: 150px; }
  #promo .end h1 { margin: 0; font: 500 132px/1 Fraunces, Georgia, serif; letter-spacing: -0.02em; }
  #promo .end .what { font: 400 44px/1.2 Fraunces, Georgia, serif; color: #3a352f; }
  #promo .end .free { font: 500 30px/1.3 Inter, sans-serif; color: #5c564d; }
  #promo .end .url { margin-top: 18px; font: 600 36px/1 Inter, sans-serif; color: #b13a15; }
  #promo .end .osm { position: absolute; bottom: 60px; font: 400 20px/1 Inter, sans-serif; color: #8a8378; }
  /* vertical 9:16: caption above the model, place name below */
  #promo.vertical { --cap-size: 96px; }
  #promo.vertical .scrim-top { height: 640px; }
  #promo.vertical .scrim-bottom { height: 420px; }
  #promo.vertical .brand { top: 120px; left: 0; right: 0; text-align: center; }
  #promo.vertical .caption { top: 220px; left: 60px; right: 60px; text-align: center; }
  #promo.vertical .place { bottom: 230px; left: 0; right: 0; text-align: center; }
  #promo.vertical .credit { bottom: 70px; left: 0; right: 0; text-align: center; }
  /* wide 16:9: caption on the left, the model sits right of centre */
  #promo.wide { --cap-size: 84px; }
  #promo.wide .scrim-top, #promo.wide .scrim-bottom { display: none; }
  #promo.wide .scrim-left { display: block; position: absolute; top: 0; bottom: 0; left: 0; width: 980px;
    background: linear-gradient(90deg, rgba(240,237,231,0.97) 0%, rgba(240,237,231,0.9) 50%, rgba(240,237,231,0) 100%); }
  #promo.wide .brand { top: 110px; left: 120px; }
  #promo.wide .caption { top: 50%; left: 120px; width: 640px; margin-top: -100px; }
  #promo.wide .place { bottom: 120px; left: 120px; }
  #promo.wide .credit { bottom: 50px; right: 60px; }
`;
const OVERLAY_HTML = (fmt) => `
  <div id="promo" class="${fmt}">
    <div class="scrim-top"></div><div class="scrim-bottom"></div><div class="scrim-left"></div>
    <div class="brand">Your Place</div>
    <div class="caption"><div class="l1"></div><div class="l2"></div></div>
    <div class="place"></div>
    <div class="credit">Map data © OpenStreetMap contributors</div>
    <div class="dip"></div>
    <div class="end">
      ${icon}
      <h1>Your Place</h1>
      <div class="what">Any address as a 3D model</div>
      <div class="free">Free · No sign-up · Works on your phone<br>Poster and STL for 3D printing</div>
      <div class="url">${SITE}</div>
      <div class="osm">Map data © OpenStreetMap contributors</div>
    </div>
  </div>`;

// ------------------------------------------------------------------ rendering

const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

for (const fmt of FORMATS) {
  const frames = join(out, `frames-${fmt.key}`);
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  let n = 0;
  const framePath = (i) => join(frames, `${String(i).padStart(5, '0')}.jpg`);

  // reduced motion turns off camera damping, so each frame shows exactly the camera that was set
  const ctx = await browser.newContext({ viewport: { width: fmt.width, height: fmt.height }, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: 'light' });
  await ctx.addInitScript(() => { try { localStorage.setItem('yp:tip-pin', '1'); } catch {} });

  for (const [si, scene] of SCENES.entries()) {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`  [${scene.place}] page error: ${e.message}`));
    await page.goto(`${base}#${scene.hash}`);
    await page.waitForFunction(() => ['ready', 'error'].includes(window.__yourPlace?.stage), null, { timeout: 180000 }).catch(() => {});
    const info = await page.evaluate(() => ({ stage: window.__yourPlace.stage, stats: window.__yourPlace.stats(), cam: window.__yourPlace.camera() }));
    console.log(`${fmt.key} ${scene.place}: ${info.stage}, ${info.stats?.buildings} buildings, relief ${Math.round(info.stats?.minElev)}–${Math.round(info.stats?.maxElev)} m`);
    await page.addStyleTag({ url: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&family=Inter:wght@400;500;600;650&display=block' }).catch(() => console.log('  fonts unavailable, using fallbacks'));
    await page.addStyleTag({ content: OVERLAY_CSS });
    await page.evaluate(({ html, lines, place }) => {
      document.body.insertAdjacentHTML('beforeend', html);
      const p = document.getElementById('promo');
      p.querySelector('.l1').textContent = lines[0];
      p.querySelector('.l2').textContent = lines[1];
      p.querySelector('.place').textContent = place;
    }, { html: OVERLAY_HTML(fmt.key), lines: scene.lines, place: scene.place });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1500); // let the map layers settle

    const d0 = info.cam.distance;
    const total = Math.round(SCENE_S * FPS);
    for (let i = 0; i < total; i++) {
      const s = i / FPS;
      const t = ease(i / (total - 1));
      const [az0, az1] = scene.az ?? DEFAULT_AZ;
      const az = az0 + (az1 - az0) * t;
      const tilt = 36 + 16 * t;
      const distance = d0 * (fmt.key === 'wide' ? 1.0 - 0.14 * t : 0.88 - 0.2 * t);
      // wide: keep the model right of centre, clear of the caption (move the target to the screen's left)
      const shift = fmt.key === 'wide' ? distance * 0.2 : 0;
      const r = (az * Math.PI) / 180;
      const cam = { azimuth: az, tilt, distance, targetE: -shift * Math.cos(r), targetN: -shift * Math.sin(r) };
      const dipIn = si === 0 ? 1 - s / (DIP_S * 1.6) : 1 - s / DIP_S;
      const dipOut = (s - (SCENE_S - DIP_S)) / DIP_S;
      const dip = Math.max(0, Math.min(1, Math.max(dipIn, dipOut)));
      const cap = Math.max(0, Math.min(1, Math.min((s - 0.35) / 0.45, (SCENE_S - 0.25 - s) / 0.4)));
      await page.evaluate(({ cam, dip, cap }) => {
        window.__yourPlace.setCamera(cam);
        const p = document.getElementById('promo');
        p.style.setProperty('--dip', dip);
        p.style.setProperty('--cap', cap);
        return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }, { cam, dip, cap });
      await page.screenshot({ path: framePath(n++), type: 'jpeg', quality: 93 });
    }

    if (si === SCENES.length - 1) {
      // end card: fade it in, then hold
      const fade = Math.round(0.4 * FPS);
      for (let i = 1; i <= fade; i++) {
        await page.evaluate((v) => document.getElementById('promo').style.setProperty('--end', v), i / fade);
        await page.screenshot({ path: framePath(n++), type: 'jpeg', quality: 93 });
      }
      const hold = framePath(n - 1);
      for (let i = 0; i < Math.round(END_S * FPS); i++) copyFileSync(hold, framePath(n++));
    }
    await page.close();
  }
  await ctx.close();

  const video = join(out, fmt.file);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, '%05d.jpg'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video]);
  // a contact sheet (one frame per second) to check the cut without playing it
  const cols = fmt.key === 'vertical' ? 8 : 6;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-vf', `fps=1,scale=${fmt.key === 'vertical' ? 270 : 480}:-1,tile=${cols}x3`, '-frames:v', '1', '-q:v', '3', join(out, fmt.file.replace('.mp4', '-sheet.jpg'))]);
  console.log(`${fmt.file}: ${n} frames, ${(n / FPS).toFixed(1)} s, ${(statSync(video).size / 1048576).toFixed(1)} MB`);
  rmSync(frames, { recursive: true, force: true });
}

await browser.close();
server.close();
