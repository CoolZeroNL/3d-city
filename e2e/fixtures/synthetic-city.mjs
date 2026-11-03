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
