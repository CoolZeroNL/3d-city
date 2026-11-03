/**
 * OpenStreetMap data via the Overpass API, parsed into model features in the
 * local metre frame. Two queries run in parallel so buildings can be drawn
 * before roads, water and vegetation arrive (spec: progressive loading).
 *
 * Data © OpenStreetMap contributors, ODbL.
 */

import { cacheGet, cacheSet } from './cache';
import { clipBuildingToRect } from './clip';
import { assembleRings, centroid, groupPolygons, openRing, pointInRing, withOrientation, type Polygon, type Pt, type Ring } from './polygon';
import { makeProjector, round, type BBox, type LngLat, type Projector } from './projection';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// ---------------------------------------------------------------- raw types

interface LatLon {
  lat: number;
  lon: number;
}

export interface OsmWay {
  type: 'way';
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<LatLon | null>;
}

export interface OsmRelation {
  type: 'relation';
  id: number;
  tags?: Record<string, string>;
  members?: Array<{ type: string; ref: number; role: string; geometry?: Array<LatLon | null> }>;
}

export type OsmElement = OsmWay | OsmRelation | { type: 'node'; id: number; tags?: Record<string, string> };

export interface OverpassResponse {
  elements: OsmElement[];
  remark?: string;
}

// ---------------------------------------------------------------- features

export interface BuildingFeature {
  id: string;
  poly: Polygon;
  tags: Record<string, string>;
  isPart: boolean;
}

export type AreaKind = 'water' | 'green' | 'forest' | 'farmland' | 'sand' | 'plaza';

export interface AreaFeature {
  kind: AreaKind;
  polys: Polygon[];
}

export type LineKind =
  | 'motorway'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'minor'
  | 'service'
  | 'path'
  | 'rail'
  | 'river'
  | 'canal'
  | 'stream';

export interface LineFeature {
  kind: LineKind;
  pts: Pt[];
  widthM: number;
  bridge: boolean;
}

export interface FeatureSet {
  areas: AreaFeature[];
  lines: LineFeature[];
  /** natural=coastline ways (land on the left, sea on the right) */
  coastlines: Pt[][];
  /** sea areas as polygons, when the source has them (vector tiles) */
  sea?: Polygon[];
}

// ---------------------------------------------------------------- queries

export function bboxString(b: BBox): string {
  return [b.south, b.west, b.north, b.east].map((v) => round(v, 6)).join(',');
}

export function buildingsQuery(b: BBox): string {
  const bb = bboxString(b);
  return `[out:json][timeout:60];
(
  way["building"](${bb});
  relation["building"]["type"="multipolygon"](${bb});
  way["building:part"](${bb});
  relation["building:part"]["type"="multipolygon"](${bb});
);
out geom qt;`;
}

export function featuresQuery(b: BBox): string {
  const bb = bboxString(b);
  const green = 'grass|meadow|forest|recreation_ground|village_green|cemetery|allotments|orchard|vineyard|greenfield|farmland|reservoir|basin';
  return `[out:json][timeout:60];
(
  way["natural"="coastline"](${bb});
  way["highway"](${bb});
  way["railway"~"^(rail|light_rail|tram|subway|narrow_gauge|monorail)$"](${bb});
  way["waterway"~"^(river|stream|canal|riverbank|dock|ditch|drain)$"](${bb});
  way["natural"~"^(water|wood|scrub|grassland|heath|wetland|beach|sand)$"](${bb});
  relation["natural"~"^(water|wood|scrub|grassland|heath|wetland|beach|sand)$"](${bb});
  way["landuse"~"^(${green})$"](${bb});
  relation["landuse"~"^(${green})$"](${bb});
  way["leisure"~"^(park|garden|pitch|playground|golf_course|common|dog_park|swimming_pool)$"](${bb});
  relation["leisure"~"^(park|garden|golf_course|common)$"](${bb});
);
out geom qt;`;
}

// ---------------------------------------------------------------- fetching

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  if (!signal) return t;
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (anyFn) return anyFn([signal, t]);
  return signal;
}

/**
 * Run an Overpass query, trying mirrors in turn. Responses are cached for a week.
 * `timeoutMs` is per mirror: large data queries need long, quick lookups should not.
 */
export async function overpass(query: string, signal?: AbortSignal, timeoutMs = 70_000): Promise<OverpassResponse> {
  const key = `ovp:${query}`;
  const cached = await cacheGet<OverpassResponse>(key);
  if (cached) return cached;
  let lastErr: unknown = new Error('No Overpass endpoint available');
  for (const endpoint of OVERPASS_ENDPOINTS) {
    if (signal?.aborted) break;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        signal: withTimeout(signal, timeoutMs),
      });
      if (!res.ok) throw new Error(`Overpass ${new URL(endpoint).host}: HTTP ${res.status}`);
      const json = (await res.json()) as OverpassResponse;
      if (json.remark && /error|timed out|out of memory/i.test(json.remark)) throw new Error(`Overpass: ${json.remark}`);
      void cacheSet(key, json);
      return json;
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- parsing

function toRing(geom: Array<LatLon | null> | undefined, proj: Projector): Ring {
  if (!geom) return [];
  const pts: Ring = [];
  for (const g of geom) if (g) pts.push(proj.toLocal(g.lon, g.lat));
  return pts;
}

function isClosed(geom: Array<LatLon | null> | undefined): boolean {
  if (!geom || geom.length < 4) return false;
  const a = geom[0];
  const b = geom[geom.length - 1];
  return !!a && !!b && a.lat === b.lat && a.lon === b.lon;
}

function relationPolygons(rel: OsmRelation, proj: Projector): Polygon[] {
  const outerSegs: Pt[][] = [];
  const innerSegs: Pt[][] = [];
  for (const m of rel.members ?? []) {
    if (m.type !== 'way' || !m.geometry) continue;
    // assemble in lon/lat (exact node matches), project afterwards
    const seg: Pt[] = m.geometry.filter((g): g is LatLon => !!g).map((g) => [g.lon, g.lat]);
    (m.role === 'inner' ? innerSegs : outerSegs).push(seg);
  }
  const project = (r: Ring): Ring => r.map(([lon, lat]) => proj.toLocal(lon, lat));
  const outers = assembleRings(outerSegs).map(project);
  const inners = assembleRings(innerSegs).map(project);
  return groupPolygons(outers, inners);
}

function elementPolygons(el: OsmElement, proj: Projector): Polygon[] {
  if (el.type === 'way') {
    if (!isClosed(el.geometry)) return [];
    const ring = openRing(toRing(el.geometry, proj));
    return ring.length >= 3 ? [{ outer: withOrientation(ring, true), holes: [] }] : [];
  }
  if (el.type === 'relation') return relationPolygons(el, proj);
  return [];
}

/** Parse the buildings query into clipped footprints. Outlines that contain building:parts are dropped (Simple 3D Buildings). */
export function parseBuildings(res: OverpassResponse, center: LngLat, sizeM: number): BuildingFeature[] {
  const proj = makeProjector(center);
  const h = sizeM / 2;
  const outlines: BuildingFeature[] = [];
  const parts: BuildingFeature[] = [];
  for (const el of res.elements) {
    if (el.type === 'node') continue;
    const tags = el.tags ?? {};
    const isPart = !!tags['building:part'] && tags['building:part'] !== 'no';
    const isBuilding = !!tags.building && tags.building !== 'no';
    if (!isPart && !isBuilding) continue;
    const polys = elementPolygons(el, proj);
    let k = 0;
    for (const p of polys) {
      for (const clipped of clipBuildingToRect(p, -h, -h, h, h, 2)) {
        const f: BuildingFeature = { id: `${el.type[0]}${el.id}${k ? `.${k}` : ''}`, poly: clipped, tags, isPart };
        (isPart ? parts : outlines).push(f);
        k++;
      }
    }
  }
  if (parts.length === 0) return outlines;
  // Drop outlines that host parts. Grid index of outline bounds keeps this fast.
  const cell = 100;
  const grid = new Map<string, number[]>();
  const bounds = outlines.map((o) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of o.poly.outer) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    return [x0, y0, x1, y1] as const;
  });
  bounds.forEach(([x0, y0, x1, y1], i) => {
    for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++)
      for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
        const k = `${gx},${gy}`;
        const a = grid.get(k);
        if (a) a.push(i);
        else grid.set(k, [i]);
      }
  });
  const hosting = new Set<number>();
  for (const p of parts) {
    const c = centroid(p.poly.outer);
    for (const i of grid.get(`${Math.floor(c[0] / cell)},${Math.floor(c[1] / cell)}`) ?? []) {
      const [x0, y0, x1, y1] = bounds[i];
      if (c[0] < x0 || c[0] > x1 || c[1] < y0 || c[1] > y1) continue;
      if (pointInPoly(c, outlines[i].poly)) hosting.add(i);
    }
  }
  return outlines.filter((_, i) => !hosting.has(i)).concat(parts);
}

function pointInPoly(pt: Pt, poly: Polygon): boolean {
  if (!pointInRing(pt, poly.outer)) return false;
  return !poly.holes.some((hole) => pointInRing(pt, hole));
}

export function areaKind(tags: Record<string, string>): AreaKind | null {
  const { natural, landuse, leisure, waterway } = tags;
  if (natural === 'water' || waterway === 'riverbank' || waterway === 'dock' || landuse === 'reservoir' || landuse === 'basin' || leisure === 'swimming_pool') return 'water';
  if (natural === 'wood' || natural === 'scrub' || landuse === 'forest' || landuse === 'orchard' || landuse === 'vineyard') return 'forest';
  if (
    natural === 'grassland' || natural === 'heath' || natural === 'wetland' ||
    ['grass', 'meadow', 'recreation_ground', 'village_green', 'cemetery', 'allotments', 'greenfield'].includes(landuse) ||
    ['park', 'garden', 'pitch', 'playground', 'golf_course', 'common', 'dog_park'].includes(leisure)
  ) return 'green';
  if (landuse === 'farmland') return 'farmland';
  if (natural === 'beach' || natural === 'sand') return 'sand';
  if (tags.highway === 'pedestrian' && tags.area === 'yes') return 'plaza';
  return null;
}

const ROAD_CLASSES: Record<string, [LineKind, number]> = {
  motorway: ['motorway', 15], trunk: ['motorway', 13], motorway_link: ['primary', 8], trunk_link: ['primary', 8],
  primary: ['primary', 11], primary_link: ['secondary', 7], secondary: ['secondary', 9.5], secondary_link: ['tertiary', 6],
  tertiary: ['tertiary', 8], tertiary_link: ['minor', 5], unclassified: ['minor', 6], residential: ['minor', 6],
  living_street: ['minor', 5], road: ['minor', 6], pedestrian: ['minor', 5], busway: ['minor', 6],
  service: ['service', 3.5], track: ['service', 3],
  footway: ['path', 1.8], path: ['path', 1.6], cycleway: ['path', 2], steps: ['path', 2], bridleway: ['path', 2], corridor: ['path', 1.5],
};

export function lineClass(tags: Record<string, string>): [LineKind, number] | null {
  if (tags.tunnel && tags.tunnel !== 'no') return null;
  if (tags.highway && ROAD_CLASSES[tags.highway]) {
    const [k, w] = ROAD_CLASSES[tags.highway];
    return [k, w];
  }
  if (tags.railway) return ['rail', tags.railway === 'tram' ? 1.6 : 3];
  const width = Number.parseFloat(tags.width ?? '');
  const wOr = (d: number) => (Number.isFinite(width) && width > 0 && width < 300 ? width : d);
  if (tags.waterway === 'river') return ['river', wOr(22)];
  if (tags.waterway === 'canal') return ['canal', wOr(14)];
  if (tags.waterway === 'stream') return ['stream', wOr(3)];
  if (tags.waterway === 'ditch' || tags.waterway === 'drain') return ['stream', wOr(1.5)];
  return null;
}

export function parseFeatures(res: OverpassResponse, center: LngLat): FeatureSet {
  const proj = makeProjector(center);
  const areas: AreaFeature[] = [];
  const lines: LineFeature[] = [];
  const coastlines: Pt[][] = [];
  for (const el of res.elements) {
    if (el.type === 'node') continue;
    const tags = el.tags ?? {};
    if (tags.natural === 'coastline') {
      if (el.type === 'way') coastlines.push(toRing(el.geometry, proj));
      continue;
    }
    const ak = areaKind(tags);
    if (ak) {
      const polys = elementPolygons(el, proj);
      if (polys.length) {
        areas.push({ kind: ak, polys });
        continue;
      }
    }
    if (el.type !== 'way' || (tags.area === 'yes' && !tags.waterway)) continue;
    const lc = lineClass(tags);
    if (!lc) continue;
    const pts = toRing(el.geometry, proj);
    if (pts.length < 2) continue;
    lines.push({ kind: lc[0], widthM: lc[1], pts, bridge: !!tags.bridge && tags.bridge !== 'no' });
  }
  return { areas, lines, coastlines };
}

// ---------------------------------------------------------------- nearby settlements

export type SettlementKind = 'city' | 'town' | 'village' | 'hamlet' | 'suburb';

export interface Settlement {
  name: string;
  kind: SettlementKind;
  center: LngLat;
  /** from the model centre */
  distanceM: number;
  /** compass bearing from the model centre, degrees clockwise from north */
  bearingDeg: number;
}

/** Bigger places win over slightly nearer hamlets: distance is divided by this weight. */
const SETTLEMENT_WEIGHT: Record<SettlementKind, number> = { city: 8, town: 5, suburb: 3, village: 3, hamlet: 1 };

export function settlementsQuery(c: LngLat, radiusM: number): string {
  return `[out:json][timeout:25];
node["place"~"^(city|town|village|hamlet|suburb)$"]["name"](around:${Math.round(radiusM)},${round(c.lat, 6)},${round(c.lon, 6)});
out qt;`;
}

export function parseSettlements(res: OverpassResponse, center: LngLat): Settlement[] {
  const proj = makeProjector(center);
  const out: Settlement[] = [];
  for (const el of res.elements) {
    if (el.type !== 'node') continue;
    const n = el as { lat?: number; lon?: number; tags?: Record<string, string> };
    const kind = n.tags?.place as SettlementKind | undefined;
    const name = n.tags?.name;
    if (!kind || !(kind in SETTLEMENT_WEIGHT) || !name || n.lat == null || n.lon == null) continue;
    const [e, nn] = proj.toLocal(n.lon, n.lat);
    out.push({
      name,
      kind,
      center: { lat: n.lat, lon: n.lon },
      distanceM: Math.hypot(e, nn),
      bearingDeg: ((Math.atan2(e, nn) * 180) / Math.PI + 360) % 360,
    });
  }
  return out;
}

/**
 * The settlement most worth suggesting: near, and preferably a village or town over
 * a farmstead. `minDistanceM` skips places already in view (they are what's empty).
 */
export function pickSettlement(list: Settlement[], minDistanceM = 0): Settlement | null {
  let best: Settlement | null = null;
  let bestScore = Infinity;
  for (const s of list) {
    if (s.distanceM < minDistanceM) continue;
    const score = Math.max(s.distanceM, 150) / SETTLEMENT_WEIGHT[s.kind];
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

export function compassWord(bearingDeg: number): string {
  return COMPASS[Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8];
}

export function formatDistance(m: number): string {
  return m < 950 ? `${Math.round(m / 50) * 50} m` : `${(m / 1000).toFixed(m < 9950 ? 1 : 0)} km`;
}
