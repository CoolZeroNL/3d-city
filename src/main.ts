import './styles.css';
import { KIND_LABEL, resolveToSettlement, reverse, type Place } from './geo/geocode';
import { buildingsQuery, compassWord, featuresQuery, formatDistance, overpass, parseBuildings, parseFeatures, parseSettlements, pickSettlement, settlementsQuery, type Settlement } from './geo/osm';
import { formatLatLon, squareBBox, type LngLat } from './geo/projection';
import { loadHeightGrid } from './geo/terrain';
import { CityModel } from './scene/cityModel';
import { HEIGHT_RAMP } from './scene/buildingsMesh';
import { isWebGL2Available, Viewer } from './scene/viewer';
import { AREA_SIZES, decodeState, encodeState, type AreaSize, type BuildingStyle, type Layers, type ViewState } from './state';
import { makePoster, posterFileName } from './ui/poster';
import { setupSearch } from './ui/search';
import { NoticeView } from './ui/notice';
import { StatusView } from './ui/status';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const PRESETS: Array<{ name: string; detail: string; center: LngLat; size: AreaSize; ex: number }> = [
  { name: 'Stuttgart', detail: 'City in a valley basin', center: { lat: 48.7765, lon: 9.1772 }, size: 4000, ex: 2 },
  { name: 'Heidelberg', detail: 'Old town on the Neckar', center: { lat: 49.4106, lon: 8.7065 }, size: 2000, ex: 1.5 },
  { name: 'Edinburgh', detail: 'Castle Rock & Arthur’s Seat', center: { lat: 55.9496, lon: -3.1835 }, size: 4000, ex: 1.5 },
  { name: 'Lisbon', detail: 'Seven hills on the Tagus', center: { lat: 38.7139, lon: -9.1365 }, size: 2000, ex: 2 },
  { name: 'San Francisco', detail: 'Nob Hill to the Bay', center: { lat: 37.7935, lon: -122.4075 }, size: 2000, ex: 1.5 },
  { name: 'Hong Kong', detail: 'Central under the Peak', center: { lat: 22.2795, lon: 114.1605 }, size: 2000, ex: 1 },
];

// ------------------------------------------------------------------ state

const app = $('app');
let state: ViewState = decodeState(location.hash);
let model: CityModel | null = null;
let placeLabel = '';
let loadToken = 0;
let abort: AbortController | null = null;
const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#c8431a';

const status = new StatusView($('status'));
const notice = new NoticeView($('notice'), $('notice-text'), $('notice-actions'), $('notice-close'));
const debug = {
  state: () => state,
  stage: 'idle' as 'idle' | 'loading' | 'terrain' | 'ready' | 'error',
  timings: {} as Record<string, number>,
  stats: () => model?.stats() ?? null,
  camera: () => (model ? viewer.getCameraState() : null),
  notice: () => (notice.visible ? $('notice-text').textContent : null),
};
(window as unknown as { __yourPlace: typeof debug }).__yourPlace = debug;

// ------------------------------------------------------------------ boot

if (!isWebGL2Available()) {
  $('unsupported').hidden = false;
  throw new Error('WebGL 2 is not available');
}

const viewer = new Viewer($<HTMLCanvasElement>('scene'));
viewer.onCameraChange(() => {
  updateCompass();
  scheduleHashWrite();
});

renderPresets();
renderLegend();
syncControls();
bindControls();
setupSearch({
  form: $<HTMLFormElement>('search-form'),
  input: $<HTMLInputElement>('search-input'),
  list: $<HTMLUListElement>('suggestions'),
  locate: $<HTMLButtonElement>('locate-btn'),
  bias: () => state.center,
  onPick: (p) => openPlace(p),
  onLocate: locate,
  onError: (m) => status.say(m),
});

const wide = window.matchMedia('(min-width: 880px)');
if (wide.matches) setSheetOpen(true);
const updateInsets = () => {
  const sheet = $('sheet');
  const visible = wide.matches && app.dataset.mode === 'model';
  viewer.setInsetLeft(visible ? sheet.getBoundingClientRect().right + 8 : 0);
};
new ResizeObserver(updateInsets).observe($('sheet'));
wide.addEventListener('change', updateInsets);

if (state.center) {
  void loadPlace(state.center, { camera: state.camera });
} else {
  setMode('landing');
}

window.addEventListener('hashchange', () => {
  const next = decodeState(location.hash, state);
  if (!next.center) return;
  if (!state.center || next.center.lat !== state.center.lat || next.center.lon !== state.center.lon || next.size !== state.size) {
    state = next;
    syncControls();
    void loadPlace(next.center, { camera: next.camera });
  }
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => undefined);
}

// ------------------------------------------------------------------ loading pipeline

function overlayPixels(size: number): number {
  const gl = viewer.renderer.getContext();
  const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const want = viewer.small || size <= 1000 ? 2048 : 4096;
  return Math.min(want, max);
}

function gridResolution(size: number): number {
  return size >= 4000 && !viewer.small ? 385 : 257;
}

/** Villages within this radius are offered when a square has (almost) no buildings. */
const RESCUE_RADIUS_M = 8000;
const FEW_BUILDINGS = 10;
let pickToken = 0;

async function settlementsNear(center: LngLat, radiusM: number): Promise<Settlement[]> {
  return parseSettlements(await overpass(settlementsQuery(center, radiusM)), center);
}

/**
 * Postcode and area results point at the middle of their area — for rural
 * postcodes that is fields between villages. Build the model around the
 * settlement instead: the one the geocoder names, else the nearest one.
 */
async function resolvePick(p: Place): Promise<Place> {
  if (p.kind !== 'postcode' && p.kind !== 'area') return p;
  const named = await resolveToSettlement(p).catch(() => null);
  if (named) return named;
  if (p.kind !== 'postcode') return p;
  const near = await settlementsNear(p.center, 6000).then((l) => pickSettlement(l), () => null);
  return near ? { label: near.name, detail: `Postcode ${p.label} · ${KIND_LABEL[near.kind]}`, center: near.center, kind: near.kind } : p;
}

async function openPlace(p: Place, opts: { size?: AreaSize; ex?: number } = {}): Promise<void> {
  if (opts.size) state.size = opts.size;
  if (opts.ex) state.exaggeration = opts.ex;
  syncControls();
  notice.hide();
  const token = ++pickToken;
  if (p.kind === 'postcode' || p.kind === 'area') status.say(`Finding the centre of ${p.label}…`);
  const target = await resolvePick(p);
  if (token !== pickToken) return;
  await loadPlace(target.center, { label: target.label, detail: target.detail });
}

/** When a square comes back (nearly) empty, offer the nearest village or town instead of a bare plain. */
async function offerNearby(center: LngLat, size: AreaSize, count: number, stale: () => boolean): Promise<void> {
  let list: Settlement[];
  try {
    list = await settlementsNear(center, RESCUE_RADIUS_M);
  } catch {
    return;
  }
  if (stale()) return;
  const here = count === 0 ? 'No buildings are mapped here' : `Only ${count} building${count === 1 ? ' is' : 's are'} mapped here`;
  // places inside the square are what is empty: suggest the best one outside it
  const best = pickSettlement(list, size * 0.6);
  if (!best) {
    const inside = pickSettlement(list);
    notice.show(
      inside
        ? `${here} — OpenStreetMap has few buildings mapped around ${inside.name} so far.`
        : `${here}, and there’s no village or town within ${RESCUE_RADIUS_M / 1000} km.`,
      size < 4000 ? [{ label: 'Show 4 × 4 km', onClick: () => setSize(4000) }] : [],
    );
    return;
  }
  const kind = KIND_LABEL[best.kind].toLowerCase();
  notice.show(`${here}. ${best.name} (${kind}) is ${formatDistance(best.distanceM)} ${compassWord(best.bearingDeg)}.`, [
    { label: `Go to ${best.name}`, primary: true, onClick: () => void openPlace({ label: best.name, detail: KIND_LABEL[best.kind], center: best.center, kind: best.kind }) },
  ]);
}

function setSize(size: AreaSize): void {
  if (!AREA_SIZES.includes(size) || size === state.size) return;
  state.size = size;
  syncControls();
  if (state.center) void loadPlace(state.center, { label: placeLabel || undefined, detail: placeMetaDetail });
}

async function loadPlace(center: LngLat, opts: { label?: string; detail?: string; camera?: ViewState['camera'] } = {}): Promise<void> {
  const token = ++loadToken;
  abort?.abort();
  abort = new AbortController();
  const signal = abort.signal;
  const stale = () => token !== loadToken;
  const size = state.size;

  state.center = center;
  state.camera = opts.camera ?? null;
  setMode('model');
  placeLabel = opts.label ?? '';
  setPlaceTitle(opts.label || formatLatLon(center), opts.detail ?? '');
  if (!opts.label) {
    reverse(center, signal).then((p) => {
      if (!stale() && p) {
        placeLabel = p.label;
        setPlaceTitle(p.label, p.detail);
        describe();
      }
    });
  }
  notice.hide();
  status.reset();
  debug.stage = 'loading';
  const t0 = performance.now();
  debug.timings = {};

  const bbox = squareBBox(center, size);
  const terrainP = loadHeightGrid(center, size, gridResolution(size), signal);
  const buildingsP = overpass(buildingsQuery(bbox), signal);
  const featuresP = overpass(featuresQuery(bbox), signal);
  // avoid unhandled-rejection noise; errors are handled below
  buildingsP.catch(() => undefined);
  featuresP.catch(() => undefined);

  let grid;
  try {
    grid = await terrainP;
  } catch (err) {
    if (stale()) return;
    console.error(err);
    status.set('terrain', 'error', () => loadPlace(center, opts));
    debug.stage = 'error';
    return;
  }
  if (stale()) return;

  const next = new CityModel(grid, overlayPixels(size), accent);
  next.setExaggeration(state.exaggeration);
  next.setContours(state.contours);
  next.setStyle(state.style);
  next.setLayers(state.layers);
  const old = model;
  model = next;
  viewer.setModel(next);
  old?.dispose();
  viewer.setCameraState(state.camera ?? viewer.defaultCamera());
  updateContourNote();
  status.set('terrain', 'done');
  debug.stage = 'terrain';
  debug.timings.terrain = performance.now() - t0;
  describe();
  writeHash();

  const buildingsTask = buildingsP.then(
    (res) => {
      if (stale()) return;
      next.setBuildings(parseBuildings(res, center, size));
      viewer.requestRender();
      status.set('buildings', 'done');
      debug.timings.buildings = performance.now() - t0;
      describe();
      const count = next.stats().buildings;
      if (count < FEW_BUILDINGS) void offerNearby(center, size, count, stale);
    },
    (err) => {
      if (stale()) return;
      console.error(err);
      status.set('buildings', 'error', () => loadPlace(center, { ...opts, label: placeLabel || opts.label, camera: viewer.getCameraState() }));
    },
  );
  const featuresTask = featuresP.then(
    (res) => {
      if (stale()) return;
      next.setFeatures(parseFeatures(res, center));
      updateContourNote();
      describe();
      viewer.retarget();
      status.set('layers', 'done');
      debug.timings.layers = performance.now() - t0;
    },
    (err) => {
      if (stale()) return;
      console.error(err);
      status.set('layers', 'error', () => loadPlace(center, { ...opts, label: placeLabel || opts.label, camera: viewer.getCameraState() }));
    },
  );
  await Promise.all([buildingsTask, featuresTask]);
  if (stale()) return;
  debug.timings.total = performance.now() - t0;
  debug.stage = status.get('buildings') === 'error' || status.get('layers') === 'error' ? 'error' : 'ready';
}

function locate(): void {
  if (!('geolocation' in navigator)) return status.say('Location is not available in this browser.');
  status.say('Finding your location…');
  navigator.geolocation.getCurrentPosition(
    (pos) => void openPlace({ label: 'Your location', detail: '', center: { lat: pos.coords.latitude, lon: pos.coords.longitude } }),
    (err) => status.say(err.code === err.PERMISSION_DENIED ? 'Location permission was denied.' : 'Couldn’t get your location.'),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
  );
}

// ------------------------------------------------------------------ UI: controls

function setMode(mode: 'landing' | 'model'): void {
  app.dataset.mode = mode;
  updateInsets();
}

function setPlaceTitle(title: string, detail: string): void {
  $('place-title').textContent = title;
  placeMetaDetail = detail;
  updateMeta();
}

let placeMetaDetail = '';
function updateMeta(): void {
  const km = state.size / 1000;
  const parts = [placeMetaDetail, `${km} × ${km} km`, `terrain ×${state.exaggeration.toFixed(1)}`].filter(Boolean);
  $('place-meta').textContent = parts.join(' · ');
}

function setSheetOpen(open: boolean): void {
  $('sheet').dataset.open = String(open);
  $('sheet-toggle').setAttribute('aria-expanded', String(open));
}

function bindControls(): void {
  $('sheet-toggle').addEventListener('click', () => setSheetOpen($('sheet').dataset.open !== 'true'));

  const ex = $<HTMLInputElement>('ex-range');
  let exFrame = 0;
  ex.addEventListener('input', () => {
    state.exaggeration = Number(ex.value);
    $('ex-out').textContent = `×${state.exaggeration.toFixed(1)}`;
    updateMeta();
    cancelAnimationFrame(exFrame);
    exFrame = requestAnimationFrame(() => {
      model?.setExaggeration(state.exaggeration);
      viewer.retarget();
      viewer.requestRender();
      scheduleHashWrite();
    });
  });

  const sw = $('contour-switch');
  sw.addEventListener('click', () => {
    state.contours = !state.contours;
    sw.setAttribute('aria-checked', String(state.contours));
    model?.setContours(state.contours);
    viewer.requestRender();
    scheduleHashWrite();
  });

  radioGroup('style-group', (v) => {
    state.style = v as BuildingStyle;
    $('legend').hidden = state.style !== 'ramp';
    model?.setStyle(state.style);
    viewer.requestRender();
    scheduleHashWrite();
  });

  radioGroup('size-group', (v) => setSize(Number(v) as AreaSize));

  for (const chip of $('layers-group').querySelectorAll<HTMLButtonElement>('[data-layer]')) {
    chip.addEventListener('click', () => {
      const key = chip.dataset.layer as keyof Layers;
      state.layers = { ...state.layers, [key]: !state.layers[key] };
      chip.setAttribute('aria-pressed', String(state.layers[key]));
      model?.setLayers(state.layers);
      viewer.requestRender();
      scheduleHashWrite();
    });
  }

  $('compass-btn').addEventListener('click', () => viewer.resetNorth());
  $('reset-btn').addEventListener('click', () => viewer.resetView());
  bindShare();
}

function radioGroup(id: string, onChange: (value: string) => void): void {
  const group = $(id);
  const buttons = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const select = (b: HTMLButtonElement, focus = false) => {
    for (const x of buttons) {
      x.setAttribute('aria-checked', String(x === b));
      x.tabIndex = x === b ? 0 : -1;
    }
    if (focus) b.focus();
    onChange(b.dataset.value!);
  };
  buttons.forEach((b, i) => {
    b.addEventListener('click', () => select(b));
    b.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      select(buttons[(i + dir + buttons.length) % buttons.length], true);
    });
  });
}

function syncControls(): void {
  const ex = $<HTMLInputElement>('ex-range');
  ex.value = String(state.exaggeration);
  $('ex-out').textContent = `×${state.exaggeration.toFixed(1)}`;
  $('contour-switch').setAttribute('aria-checked', String(state.contours));
  for (const [id, value] of [
    ['style-group', state.style],
    ['size-group', String(state.size)],
  ] as const) {
    for (const b of $(id).querySelectorAll<HTMLButtonElement>('[role="radio"]')) {
      const on = b.dataset.value === value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }
  $('legend').hidden = state.style !== 'ramp';
  for (const chip of $('layers-group').querySelectorAll<HTMLButtonElement>('[data-layer]')) {
    chip.setAttribute('aria-pressed', String(state.layers[chip.dataset.layer as keyof Layers]));
  }
  updateMeta();
}

function updateContourNote(): void {
  if (model) $('contour-note').textContent = `every ${model.stats().contourInterval} m`;
}

function updateCompass(): void {
  const az = viewer.getCameraState().azimuth;
  $('compass-needle').style.transform = `rotate(${az}deg)`;
}

function renderPresets(): void {
  const host = $('presets');
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset';
    const name = document.createElement('strong');
    name.textContent = p.name;
    const detail = document.createElement('span');
    detail.textContent = p.detail;
    b.append(name, detail);
    b.addEventListener('click', () => {
      $<HTMLInputElement>('search-input').value = p.name;
      openPlace({ label: p.name, detail: p.detail, center: p.center }, { size: p.size, ex: p.ex });
    });
    host.append(b);
  }
}

function renderLegend(): void {
  const max = HEIGHT_RAMP[HEIGHT_RAMP.length - 1][0];
  const pos = (h: number) => (Math.sqrt(h) / Math.sqrt(max)) * 100;
  $('legend-bar').style.background = `linear-gradient(to right, ${HEIGHT_RAMP.map(([h, c]) => `${c} ${pos(h).toFixed(1)}%`).join(', ')})`;
  const labels = $('legend-labels');
  for (const [h] of HEIGHT_RAMP) {
    const s = document.createElement('span');
    s.style.left = `${pos(h)}%`;
    s.textContent = h === max ? `${h}+ m` : `${h}`;
    labels.append(s);
  }
}

/** Plain-language summary of the area (spec: accessibility). */
function describe(): void {
  if (!model) return;
  const s = model.stats();
  const nf = new Intl.NumberFormat();
  const km = state.size / 1000;
  const relief = Math.round(s.maxElev - s.minElev);
  const lines = [
    `${km} × ${km} km around ${placeLabel || 'this point'}.`,
    `Ground from ${Math.round(s.minElev)} m to ${Math.round(s.maxElev)} m above sea level (${relief} m of relief).`,
  ];
  if (model.hasBuildings) {
    lines.push(s.buildings ? `${nf.format(s.buildings)} buildings; the tallest is about ${Math.round(s.tallest)} m.` : 'No buildings are mapped in this square.');
  }
  $('describe').textContent = lines.join(' ');
  const note = $('estimate-note');
  if (model.hasBuildings && s.estimatedShare >= 0.05) {
    note.hidden = false;
    note.textContent = `Heights estimated for ${Math.round(s.estimatedShare * 100)}% of buildings — OpenStreetMap has no height or floor count for them.`;
  } else {
    note.hidden = true;
  }
  $<HTMLCanvasElement>('scene').setAttribute('aria-label', `3D model. ${lines.join(' ')} Arrow keys orbit and tilt, plus and minus zoom, N faces north, 0 resets the view.`);
}

// ------------------------------------------------------------------ URL + share

let hashTimer = 0;
function scheduleHashWrite(): void {
  window.clearTimeout(hashTimer);
  hashTimer = window.setTimeout(writeHash, 350);
}

function writeHash(): void {
  if (!state.center || !model) return;
  state.camera = viewer.getCameraState();
  const h = encodeState(state);
  if (`#${h}` !== location.hash) history.replaceState(null, '', `#${h}`);
}

function toast(message: string): void {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  window.setTimeout(() => (t.hidden = true), 2200);
}

function bindShare(): void {
  const dialog = $<HTMLDialogElement>('share-dialog');
  const url = $<HTMLInputElement>('share-url');
  const msg = $('share-msg');
  const nativeBtn = $<HTMLButtonElement>('native-share-btn');
  nativeBtn.hidden = typeof navigator.share !== 'function';

  $('share-btn').addEventListener('click', () => {
    writeHash();
    url.value = location.href;
    msg.textContent = '';
    dialog.showModal();
  });

  $('copy-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url.value);
      msg.textContent = 'Link copied.';
    } catch {
      url.select();
      msg.textContent = 'Select the link above and copy it.';
    }
  });

  nativeBtn.addEventListener('click', async () => {
    try {
      await navigator.share({ title: `${placeLabel || 'Your Place'} in 3D`, url: url.value });
    } catch {
      /* dismissed */
    }
  });

  const posterBtn = $<HTMLButtonElement>('poster-btn');
  posterBtn.addEventListener('click', async () => {
    if (!model || !state.center) return;
    posterBtn.disabled = true;
    msg.textContent = 'Rendering poster…';
    try {
      const title = placeLabel || formatLatLon(state.center);
      const blob = await makePoster(viewer, { title, center: state.center, sizeM: state.size, exaggeration: state.exaggeration });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = posterFileName(title, state.size);
      document.body.append(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      msg.textContent = '';
      dialog.close();
      toast('Poster saved');
    } catch (err) {
      console.error(err);
      msg.textContent = 'Couldn’t render the poster on this device.';
    } finally {
      posterBtn.disabled = false;
    }
  });
}

