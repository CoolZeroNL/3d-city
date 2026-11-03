/**
 * Map data from OpenFreeMap vector tiles (OpenMapTiles schema, built from
 * OpenStreetMap and served from a CDN). One fast, cacheable request per tile
 * replaces the Overpass queries, which are slow and rate-limited under load.
 *
 * Tiles hold buildings (with render heights), roads, water (including the sea),
 * land cover and place names. Geometry is projected into the local metre frame
 * and clipped to each tile's own bounds, so features repeated in neighbouring
 * tiles' buffers are not drawn twice.
 */

import { VectorTile, classifyRings, type VectorTileFeature, type VectorTileLayer } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { cacheGet, cacheSet } from './cache';
import type { AreaFeature, AreaKind, FeatureSet, LineFeature, LineKind, Settlement, SettlementKind } from './osm';
import { clipBuildingToRect, joinPieces } from './clip';
import { clipPolygonToRect, ringBounds, signedArea, withOrientation, type Polygon, type Pt, type Ring } from './polygon';
import { lngLatToTile, makeProjector, type LngLat, type Projector } from './projection';

export const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
export const DATA_ZOOM = 14;

export interface TileRef {
  z: number;
  x: number;
  y: number;
}

export interface LoadedTile extends TileRef {
  tile: VectorTile;
}

/** A building ready to extrude: OpenMapTiles has already applied height → levels → default. */
export interface TileBuilding {
  poly: Polygon;
  height: number;
  minHeight: number;
}

export interface TileData {
  buildings: TileBuilding[];
  features: FeatureSet;
  settlements: Settlement[];
}

// ---------------------------------------------------------------- fetching

let templatePromise: Promise<string> | null = null;

/** The tile URL template is versioned (it changes with each planet build); read it from the TileJSON. */
export function tileTemplate(signal?: AbortSignal): Promise<string> {
  templatePromise ??= (async () => {
    const cached = await cacheGet<string>('ofm:template', 12 * 3600 * 1000);
    if (cached) return cached;
    const res = await fetch(TILEJSON_URL, { signal });
    if (!res.ok) throw new Error(`Map tiles: HTTP ${res.status}`);
    const json = (await res.json()) as { tiles?: string[] };
    const t = json.tiles?.[0];
    if (!t) throw new Error('Map tiles: no tile URL');
    void cacheSet('ofm:template', t);
    return t;
  })().catch((err) => {
    templatePromise = null;
    throw err;
  });
  return templatePromise;
}

/** Tiles at zoom z covering the square of `sizeM` around `center` (plus `marginM`). */
export function tilesForSquare(center: LngLat, sizeM: number, z: number, marginM = 0): TileRef[] {
  const p = makeProjector(center);
  const h = sizeM / 2 + marginM;
  const nw = p.toLngLat(-h, h);
  const se = p.toLngLat(h, -h);
  const [x0, y0] = lngLatToTile(nw.lon, nw.lat, z);
  const [x1, y1] = lngLatToTile(se.lon, se.lat, z);
  const out: TileRef[] = [];
  for (let y = Math.floor(y0); y <= Math.floor(y1); y++) for (let x = Math.floor(x0); x <= Math.floor(x1); x++) out.push({ z, x, y });
  return out;
}

export function decodeTile(buf: ArrayBuffer | Uint8Array): VectorTile {
  return new VectorTile(new Pbf(buf instanceof Uint8Array ? buf : new Uint8Array(buf)));
}

export async function fetchTiles(refs: TileRef[], signal?: AbortSignal): Promise<LoadedTile[]> {
  const template = await tileTemplate(signal);
  return Promise.all(
    refs.map(async (r) => {
      const url = template.replace('{z}', String(r.z)).replace('{x}', String(r.x)).replace('{y}', String(r.y));
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(url, { signal });
          // the CDN answers 204/404 for tiles with no data (open sea): that is an empty tile, not an error
          if (res.status === 204 || res.status === 404) return { ...r, tile: decodeTile(new Uint8Array(0)) };
          if (!res.ok) throw new Error(`Map tile ${r.z}/${r.x}/${r.y}: HTTP ${res.status}`);
          return { ...r, tile: decodeTile(await res.arrayBuffer()) };
        } catch (err) {
          if (signal?.aborted) throw err;
          lastErr = err;
        }
      }
      throw lastErr;
    }),
  );
}

// ---------------------------------------------------------------- geometry

/** Converts tile-local coordinates of one tile into the model's metre frame. */
function tileProjector(t: TileRef, extent: number, proj: Projector): (px: number, py: number) => Pt {
  const n = 2 ** t.z;
  return (px, py) => {
    const X = (t.x + px / extent) / n;
    const Y = (t.y + py / extent) / n;
    const lon = X * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * Y))) * 180) / Math.PI;
    return proj.toLocal(lon, lat);
  };
}

/** The tile's own square (without the buffer) in metres: west, south, east, north. */
export function tileBounds(t: TileRef, proj: Projector): [number, number, number, number] {
  const toLocal = tileProjector(t, 1, proj);
  const [w, n] = toLocal(0, 0);
  const [e, s] = toLocal(1, 1);
  return [w, s, e, n];
}

function polygonsOf(f: VectorTileFeature, toLocal: (x: number, y: number) => Pt): Polygon[] {
  const out: Polygon[] = [];
  for (const rings of classifyRings(f.loadGeometry())) {
    const local: Ring[] = rings.map((r) => r.map((p) => toLocal(p.x, p.y)));
    // drop the closing duplicate vertex
    for (const r of local) {
      const a = r[0];
      const b = r[r.length - 1];
      if (r.length > 1 && a[0] === b[0] && a[1] === b[1]) r.pop();
    }
    const [outer, ...holes] = local;
    if (!outer || outer.length < 3) continue;
    out.push({ outer: withOrientation(outer, true), holes: holes.filter((h) => h.length >= 3).map((h) => withOrientation(h, false)) });
  }
  return out;
}

function linesOf(f: VectorTileFeature, toLocal: (x: number, y: number) => Pt): Pt[][] {
  return f.loadGeometry().map((line) => line.map((p) => toLocal(p.x, p.y)));
}

function eachFeature(layer: VectorTileLayer | undefined, fn: (f: VectorTileFeature) => void): void {
  if (!layer) return;
  for (let i = 0; i < layer.length; i++) fn(layer.feature(i));
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// ---------------------------------------------------------------- classification (OpenMapTiles schema)

const LANDCOVER_KIND: Record<string, AreaKind> = {
  wood: 'forest',
  grass: 'green',
  wetland: 'green',
  farmland: 'farmland',
  sand: 'sand',
};

const LANDUSE_KIND: Record<string, AreaKind> = {
  cemetery: 'green',
  pitch: 'green',
  playground: 'green',
  stadium: 'green',
};

const ROAD_KIND: Record<string, [LineKind, number]> = {
  motorway: ['motorway', 15],
  trunk: ['motorway', 13],
  primary: ['primary', 11],
  secondary: ['secondary', 9.5],
  tertiary: ['tertiary', 8],
  minor: ['minor', 6],
  busway: ['minor', 6],
  service: ['service', 3.5],
  track: ['service', 3],
  raceway: ['service', 6],
  path: ['path', 1.8],
};

const WATERWAY_KIND: Record<string, [LineKind, number]> = {
  river: ['river', 22],
  canal: ['canal', 14],
  stream: ['stream', 3],
  ditch: ['stream', 1.5],
  drain: ['stream', 1.5],
};

const PLACE_KINDS: Record<string, SettlementKind> = {
  city: 'city',
  town: 'town',
  village: 'village',
  hamlet: 'hamlet',
  suburb: 'suburb',
  quarter: 'suburb',
  neighbourhood: 'suburb',
};

// ---------------------------------------------------------------- parsing

/**
 * Turn loaded tiles into model data for the square. Every geometry is clipped to
 * its own tile (removing the overlap buffers) and buildings also to the square.
 */
export function parseTiles(tiles: LoadedTile[], center: LngLat, sizeM: number): TileData {
  const proj = makeProjector(center);
  const h = sizeM / 2;
  const buildings: TileBuilding[] = [];
  const areas: AreaFeature[] = [];
  const lines: LineFeature[] = [];
  const sea: Polygon[] = [];
  const settlements = new Map<string, Settlement>();
  // pieces cut off by an edge between two tiles, by height: joined again at the end
  const seamPieces = new Map<string, Polygon[]>();

  for (const t of tiles) {
    const [w, s, e, n] = tileBounds(t, proj);
    // square ∩ tile, for buildings
    const bw = Math.max(w, -h);
    const bs = Math.max(s, -h);
    const be = Math.min(e, h);
    const bn = Math.min(n, h);
    const layers = t.tile.layers;
    const extentOf = (name: string) => layers[name]?.extent ?? 4096;

    if (be > bw && bn > bs) {
      const toLocal = tileProjector(t, extentOf('building'), proj);
      eachFeature(layers.building, (f) => {
        if (f.type !== 3 || f.properties.hide_3d) return; // hide_3d: outline drawn by its building:parts
        const height = Math.max(num(f.properties.render_height, 5), 1);
        const minHeight = Math.max(0, Math.min(num(f.properties.render_min_height, 0), height - 0.5));
        for (const p of polygonsOf(f, toLocal)) {
          for (const c of clipBuildingToRect(p, bw, bs, be, bn, 2)) {
            const [x0, y0, x1, y1] = ringBounds(c.outer);
            const eps = 1e-6;
            const onSeam = (bw > -h && x0 <= bw + eps) || (be < h && x1 >= be - eps) || (bs > -h && y0 <= bs + eps) || (bn < h && y1 >= bn - eps);
            if (!onSeam) {
              buildings.push({ poly: c, height, minHeight });
              continue;
            }
            const key = `${height}|${minHeight}`;
            const list = seamPieces.get(key);
            if (list) list.push(c);
            else seamPieces.set(key, [c]);
          }
        }
      });
    }

    const clipArea = (kind: AreaKind, polys: Polygon[]) => {
      const clipped = polys.map((p) => clipPolygonToRect(p, w, s, e, n, 1)).filter((p): p is Polygon => !!p);
      if (clipped.length) areas.push({ kind, polys: clipped });
      return clipped;
    };

    {
      const toLocal = tileProjector(t, extentOf('water'), proj);
      eachFeature(layers.water, (f) => {
        if (f.type !== 3 || str(f.properties.brunnel) === 'tunnel') return;
        const clipped = clipArea('water', polygonsOf(f, toLocal));
        if (str(f.properties.class) === 'ocean') sea.push(...clipped);
      });
    }
    {
      const toLocal = tileProjector(t, extentOf('landcover'), proj);
      eachFeature(layers.landcover, (f) => {
        const kind = LANDCOVER_KIND[str(f.properties.class)];
        if (kind && f.type === 3) clipArea(kind, polygonsOf(f, toLocal));
      });
    }
    {
      const toLocal = tileProjector(t, extentOf('landuse'), proj);
      eachFeature(layers.landuse, (f) => {
        const kind = LANDUSE_KIND[str(f.properties.class)];
        if (kind && f.type === 3) clipArea(kind, polygonsOf(f, toLocal));
      });
    }
    {
      const toLocal = tileProjector(t, extentOf('transportation'), proj);
      eachFeature(layers.transportation, (f) => {
        const cls = str(f.properties.class);
        const brunnel = str(f.properties.brunnel);
        if (brunnel === 'tunnel') return;
        if (f.type === 3) {
          // pedestrian squares and platforms come as areas
          if (cls === 'path' && str(f.properties.subclass) === 'pedestrian') clipArea('plaza', polygonsOf(f, toLocal));
          return;
        }
        if (f.type !== 2) return;
        const isRail = cls === 'rail' || cls === 'transit';
        const road = ROAD_KIND[cls];
        if (!road && !isRail) return;
        const [kind, width] = isRail ? (['rail', str(f.properties.subclass) === 'tram' ? 1.6 : 3] as [LineKind, number]) : road;
        for (const pts of linesOf(f, toLocal)) if (pts.length >= 2) lines.push({ kind, widthM: width, pts, bridge: brunnel === 'bridge' });
      });
    }
    {
      const toLocal = tileProjector(t, extentOf('waterway'), proj);
      eachFeature(layers.waterway, (f) => {
        if (f.type !== 2 || str(f.properties.brunnel) === 'tunnel') return;
        const k = WATERWAY_KIND[str(f.properties.class)];
        if (!k) return;
        for (const pts of linesOf(f, toLocal)) if (pts.length >= 2) lines.push({ kind: k[0], widthM: k[1], pts, bridge: false });
      });
    }
    collectPlaces(t, proj, settlements);
  }
  for (const [key, pieces] of seamPieces) {
    const [height, minHeight] = key.split('|').map(Number);
    for (const poly of joinPieces(pieces)) buildings.push({ poly, height, minHeight });
  }

  return { buildings, features: { areas, lines, coastlines: [], sea }, settlements: [...settlements.values()] };
}

function collectPlaces(t: LoadedTile, proj: Projector, into: Map<string, Settlement>): void {
  const layer = t.tile.layers.place;
  if (!layer) return;
  const toLocal = tileProjector(t, layer.extent, proj);
  eachFeature(layer, (f) => {
    const kind = PLACE_KINDS[str(f.properties.class)];
    const name = str(f.properties.name);
    if (!kind || !name || f.type !== 1) return;
    const pt = f.loadGeometry()[0]?.[0];
    if (!pt) return;
    // places near tile edges are repeated in the neighbours' buffers
    if (pt.x < 0 || pt.y < 0 || pt.x >= layer.extent || pt.y >= layer.extent) return;
    const [e, n] = toLocal(pt.x, pt.y);
    const key = `${name}|${kind}`;
    const distanceM = Math.hypot(e, n);
    const prev = into.get(key);
    if (prev && prev.distanceM <= distanceM) return;
    into.set(key, {
      name,
      kind,
      center: proj.toLngLat(e, n),
      distanceM,
      bearingDeg: ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360,
    });
  });
}

/** Settlements within roughly `radiusM` of a point, from lower-zoom tiles (one request for a few km). */
export async function settlementsFromTiles(center: LngLat, radiusM: number, zoom: number, signal?: AbortSignal): Promise<Settlement[]> {
  const refs = tilesForSquare(center, radiusM * 2, zoom);
  const tiles = await fetchTiles(refs, signal);
  const proj = makeProjector(center);
  const found = new Map<string, Settlement>();
  for (const t of tiles) collectPlaces(t, proj, found);
  return [...found.values()].filter((s) => s.distanceM <= radiusM * 1.05);
}

export function polygonArea(p: Polygon): number {
  return Math.abs(signedArea(p.outer)) - p.holes.reduce((a, r) => a + Math.abs(signedArea(r)), 0);
}
