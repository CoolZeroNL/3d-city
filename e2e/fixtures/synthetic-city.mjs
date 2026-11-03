/**
 * Deterministic synthetic OpenStreetMap data in Overpass JSON format, generated
 * for whatever bbox the app asks for. Used by the e2e test so it runs without
 * Overpass access. It exercises every parser path: plain ways, multipolygon
 * relations split across member ways, courtyards, building:part towers inside
 * an outline, height / levels / untagged buildings, roads of every class,
 * a river (area + line), a park, a forest and a railway.
 */

export function parseBBox(query) {
  const m = /\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)/.exec(query);
  if (!m) throw new Error('no bbox in query');
  const [s, w, n, e] = m.slice(1).map(Number);
  return { south: s, west: w, north: n, east: e };
}

function projector(b) {
  const lat0 = (b.south + b.north) / 2;
  const lon0 = (b.west + b.east) / 2;
  const phi = (lat0 * Math.PI) / 180;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * phi);
  const mLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  const half = ((b.north - b.south) * mLat) / 2;
  return { half, ll: (e, n) => ({ lat: +(lat0 + n / mLat).toFixed(7), lon: +(lon0 + e / mLon).toFixed(7) }) };
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A spot in open country between villages (the middle of postcode area 38312) and its villages. */
export const RURAL = { lat: 52.0835, lon: 10.5531 };
export const DORSTADT = { lat: 52.0967, lon: 10.5719 };
const SETTLEMENTS = [
  { type: 'node', id: 1, lat: DORSTADT.lat, lon: DORSTADT.lon, tags: { place: 'village', name: 'Dorstadt' } },
  { type: 'node', id: 2, lat: 52.085, lon: 10.556, tags: { place: 'hamlet', name: 'Gut Nord' } },
  { type: 'node', id: 3, lat: 52.162, lon: 10.537, tags: { place: 'town', name: 'Wolfenbüttel' } },
];

export function synthesize(query) {
  if (/\["place"~/.test(query)) return { elements: SETTLEMENTS };
  const b = parseBBox(query);
  const mid = { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
  const rural = Math.abs(mid.lat - RURAL.lat) < 0.003 && Math.abs(mid.lon - RURAL.lon) < 0.004;
  if (rural && /building/.test(query)) return { elements: [] };
  const { half, ll } = projector(b);
  const closed = (pts) => [...pts, pts[0]].map(([e, n]) => ll(e, n));
  const line = (pts) => pts.map(([e, n]) => ll(e, n));
  const rand = rng(42);
  let id = 1000;
  const elements = [];
  const block = 120;
  const river = (e) => 0.35 * e - 260; // river centreline north coordinate
  const inRiver = (e, n, pad = 0) => Math.abs(n - river(e)) < 45 + pad;
  const inPark = (e, n) => e > 150 && e < 450 && n > 120 && n < 380;

  if (/building/.test(query)) {
    for (let gx = -Math.ceil(half / block); gx < Math.ceil(half / block); gx++) {
      for (let gy = -Math.ceil(half / block); gy < Math.ceil(half / block); gy++) {
        const x0 = gx * block + 12;
        const y0 = gy * block + 12;
        const w = block - 24;
        const cx = x0 + w / 2;
        const cy = y0 + w / 2;
        if (inRiver(cx, cy, 60) || inPark(cx, cy)) continue;
        const dist = Math.hypot(cx, cy);
        if (dist < 520 && rand() < 0.75) {
          // perimeter block with a courtyard, split across two outer member ways
          const t = 14;
          const levels = 3 + Math.floor(rand() * 5);
          const tags = { type: 'multipolygon', building: 'apartments' };
          if (rand() < 0.5) tags.height = String(levels * 3.2);
          else tags['building:levels'] = String(levels);
          elements.push({
            type: 'relation', id: id++, tags,
            members: [
              { type: 'way', ref: id++, role: 'outer', geometry: line([[x0, y0], [x0 + w, y0], [x0 + w, y0 + w]]) },
              { type: 'way', ref: id++, role: 'outer', geometry: line([[x0 + w, y0 + w], [x0, y0 + w], [x0, y0]]) },
              { type: 'way', ref: id++, role: 'inner', geometry: closed([[x0 + t, y0 + t], [x0 + w - t, y0 + t], [x0 + w - t, y0 + w - t], [x0 + t, y0 + w - t]]) },
            ],
          });
        } else {
          // detached buildings
          const n = dist < 1200 ? 4 : 3;
          for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
              if (rand() < 0.2) continue;
              const cell = w / n;
              const bw = cell * (0.45 + rand() * 0.3);
              const bd = cell * (0.45 + rand() * 0.3);
              const ex = x0 + i * cell + (cell - bw) / 2;
              const ey = y0 + j * cell + (cell - bd) / 2;
              const r = rand();
              const tags = { building: dist < 1200 ? 'yes' : 'house' };
              if (r < 0.3) tags.height = (6 + rand() * (dist < 900 ? 30 : 6)).toFixed(1);
              else if (r < 0.55) tags['building:levels'] = String(1 + Math.floor(rand() * (dist < 900 ? 8 : 2)));
              if (rand() < 0.08) tags.building = 'garage';
              elements.push({ type: 'way', id: id++, tags, geometry: closed([[ex, ey], [ex + bw, ey], [ex + bw, ey + bd], [ex, ey + bd]]) });
            }
          }
        }
      }
    }
    // a landmark: church outline with a tall tower part
    elements.push({ type: 'way', id: id++, tags: { building: 'church', height: '22' }, geometry: closed([[-60, 140], [-10, 140], [-10, 170], [-60, 170]]) });
    elements.push({ type: 'way', id: id++, tags: { 'building:part': 'yes', height: '22' }, geometry: closed([[-60, 140], [-22, 140], [-22, 170], [-60, 170]]) });
    elements.push({ type: 'way', id: id++, tags: { 'building:part': 'yes', height: '78' }, geometry: closed([[-22, 145], [-10, 145], [-10, 165], [-22, 165]]) });
    // a skyscraper
    elements.push({ type: 'way', id: id++, tags: { building: 'office', height: '120' }, geometry: closed([[260, -60], [300, -60], [300, -20], [260, -20]]) });
    return { elements };
  }

  // ---- features
  const H = half + 50;
  for (let k = -Math.ceil(half / block); k <= Math.ceil(half / block); k++) {
    const c = k * block;
    const cls = k % 6 === 0 ? 'primary' : k % 3 === 0 ? 'secondary' : k % 2 === 0 ? 'tertiary' : 'residential';
    elements.push({ type: 'way', id: id++, tags: { highway: cls }, geometry: line([[c, -H], [c, H]]) });
    elements.push({ type: 'way', id: id++, tags: { highway: cls }, geometry: line([[-H, c], [H, c]]) });
  }
  elements.push({ type: 'way', id: id++, tags: { highway: 'motorway' }, geometry: line([[-H, -H * 0.7], [H, H * 0.2]]) });
  elements.push({ type: 'way', id: id++, tags: { highway: 'primary', tunnel: 'yes' }, geometry: line([[-H, 0], [H, 30]]) });
  for (let k = 0; k < 40; k++) {
    const e = (rand() - 0.5) * 2 * half;
    const n = (rand() - 0.5) * 2 * half;
    elements.push({ type: 'way', id: id++, tags: { highway: 'footway' }, geometry: line([[e, n], [e + 60, n + 25], [e + 90, n + 70]]) });
  }
  elements.push({ type: 'way', id: id++, tags: { railway: 'rail' }, geometry: line([[-H, H * 0.55], [0, H * 0.4], [H, H * 0.62]]) });
  // river: area split into two outer ways + centreline
  const xs = [];
  for (let e = -H; e <= H; e += 100) xs.push(e);
  const north = xs.map((e) => [e, river(e) + 45]);
  const south = xs.map((e) => [e, river(e) - 45]).reverse();
  elements.push({
    type: 'relation', id: id++, tags: { type: 'multipolygon', natural: 'water', water: 'river' },
    members: [
      { type: 'way', ref: id++, role: 'outer', geometry: line([...north, south[0]]) },
      { type: 'way', ref: id++, role: 'outer', geometry: line([...south, north[0]]) },
    ],
  });
  elements.push({ type: 'way', id: id++, tags: { waterway: 'river' }, geometry: line(xs.map((e) => [e, river(e)])) });
  elements.push({ type: 'way', id: id++, tags: { leisure: 'park' }, geometry: closed([[150, 120], [450, 120], [450, 380], [150, 380]]) });
  elements.push({ type: 'way', id: id++, tags: { landuse: 'forest' }, geometry: closed([[-H, H * 0.65], [-H * 0.3, H * 0.75], [-H * 0.1, H], [-H, H]]) });
  elements.push({ type: 'way', id: id++, tags: { landuse: 'grass' }, geometry: closed([[-400, -500], [-250, -500], [-250, -420], [-400, -420]]) });
  // Coastal test places (south of 40°N, e.g. Lisbon): a coastline heading east along the
  // southern edge, so the sea lies to its right (south) — at the real waterfront's latitude.
  if ((b.south + b.north) / 2 < 40) {
    const y = -half * 0.86;
    elements.push({ type: 'way', id: id++, tags: { natural: 'coastline' }, geometry: line([[-H, y], [-half * 0.3, y + 25], [half * 0.4, y - 10], [H, y + 15]]) });
  }
  return { elements };
}

// ---------------------------------------------------------------- vector-tile world

/**
 * The same synthetic data as GeoJSON layers in the OpenMapTiles schema, for a
 * fake OpenFreeMap tile server. One "world" per test place, built once:
 * cities around the city presets, a lone village at Dorstadt with fields around it.
 */
export const WORLD_CENTERS = [
  { lat: 48.7765, lon: 9.1772, sizeM: 5000 }, // Stuttgart
  { lat: 49.4106, lon: 8.7065, sizeM: 3000 }, // Heidelberg
  { lat: 38.7139, lon: -9.1365, sizeM: 2000, coast: true }, // Lisbon: coastline 860 m south, inside the 2 km test square
];

function bboxQuery(c, sizeM, kind) {
  const dLat = sizeM / 2 / 111200;
  const dLon = sizeM / 2 / (111320 * Math.cos((c.lat * Math.PI) / 180));
  return `${kind} (${c.lat - dLat},${c.lon - dLon},${c.lat + dLat},${c.lon + dLon})`;
}

const coords = (geom) => geom.map((g) => [g.lon, g.lat]);
const ROAD_CLASS = { motorway: 'motorway', primary: 'primary', secondary: 'secondary', tertiary: 'tertiary', residential: 'minor', footway: 'path' };

function joinOuter(members) {
  let ring = [];
  for (const m of members.filter((x) => x.role === 'outer')) ring = ring.length ? ring.concat(coords(m.geometry).slice(1)) : coords(m.geometry);
  return ring;
}

function toLayers(elements, layers, keep = () => true) {
  for (const el of elements) {
    const t = el.tags ?? {};
    if (el.type === 'relation') {
      const outer = joinOuter(el.members);
      const inners = el.members.filter((m) => m.role === 'inner').map((m) => coords(m.geometry));
      if (!keep(outer[0])) continue;
      if (t.building) layers.building.push({ type: 'Feature', properties: { render_height: Number(t.height ?? (t['building:levels'] ?? 3) * 3), render_min_height: 0 }, geometry: { type: 'Polygon', coordinates: [outer, ...inners] } });
      else if (t.natural === 'water') layers.water.push({ type: 'Feature', properties: { class: 'river' }, geometry: { type: 'Polygon', coordinates: [outer] } });
      continue;
    }
    if (el.type !== 'way') continue;
    const c = coords(el.geometry);
    if (!keep(c[0])) continue;
    if (t.building || t['building:part']) {
      const h = Number(t.height ?? (t['building:levels'] ? t['building:levels'] * 3 : 9));
      layers.building.push({ type: 'Feature', properties: { render_height: h, render_min_height: 0, ...(t.building === 'church' ? { hide_3d: true } : {}) }, geometry: { type: 'Polygon', coordinates: [c] } });
    } else if (t.highway && !t.tunnel) layers.transportation.push({ type: 'Feature', properties: { class: ROAD_CLASS[t.highway] ?? 'minor' }, geometry: { type: 'LineString', coordinates: c } });
    else if (t.railway) layers.transportation.push({ type: 'Feature', properties: { class: 'rail', subclass: 'rail' }, geometry: { type: 'LineString', coordinates: c } });
    else if (t.waterway) layers.waterway.push({ type: 'Feature', properties: { class: 'river' }, geometry: { type: 'LineString', coordinates: c } });
    else if (t.leisure === 'park' || t.landuse === 'grass') layers.landcover.push({ type: 'Feature', properties: { class: 'grass', subclass: 'park' }, geometry: { type: 'Polygon', coordinates: [c] } });
    else if (t.landuse === 'forest') layers.landcover.push({ type: 'Feature', properties: { class: 'wood', subclass: 'forest' }, geometry: { type: 'Polygon', coordinates: [c] } });
    else if (t.natural === 'coastline') {
      // the coastline heads east, sea to the south: close it into an ocean polygon
      const south = Math.min(...c.map((p) => p[1])) - 0.02;
      const ring = [...c, [c[c.length - 1][0], south], [c[0][0], south], c[0]];
      layers.water.push({ type: 'Feature', properties: { class: 'ocean' }, geometry: { type: 'Polygon', coordinates: [ring] } });
    }
  }
}

export function buildWorld() {
  const layers = { building: [], transportation: [], water: [], waterway: [], landcover: [], place: [] };
  for (const w of WORLD_CENTERS) {
    toLayers(synthesize(bboxQuery(w, w.sizeM, 'building')).elements, layers);
    toLayers(synthesize(bboxQuery(w, w.sizeM, 'features')).elements, layers);
  }
  // Dorstadt: a village of ~600 m radius; open fields between it and the postcode middle (RURAL)
  const near = (p, c, m) => Math.hypot((p[0] - c.lon) * 111320 * Math.cos((c.lat * Math.PI) / 180), (p[1] - c.lat) * 111200) < m;
  toLayers(synthesize(bboxQuery(DORSTADT, 1400, 'building')).elements, layers, (p) => near(p, DORSTADT, 600));
  layers.transportation.push({ type: 'Feature', properties: { class: 'tertiary' }, geometry: { type: 'LineString', coordinates: [[RURAL.lon - 0.01, RURAL.lat], [DORSTADT.lon, DORSTADT.lat]] } });
  for (const s of SETTLEMENTS) layers.place.push({ type: 'Feature', properties: { class: s.tags.place, name: s.tags.name }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } });
  layers.place.push({ type: 'Feature', properties: { class: 'city', name: 'Stuttgart' }, geometry: { type: 'Point', coordinates: [9.1772, 48.7765] } });
  return Object.fromEntries(Object.entries(layers).map(([k, v]) => [k, { type: 'FeatureCollection', features: v }]));
}
