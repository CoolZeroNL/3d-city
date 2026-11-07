/**
 * Elevation: Terrarium-encoded terrain tiles (Mapzen / AWS Open Data "Terrain Tiles").
 * Worldwide, CORS-enabled, no key. Sources vary by region (SRTM, EU-DEM, GMTED,
 * USGS 3DEP, ETOPO1 bathymetry, ...), roughly 10–30 m ground resolution.
 *
 * The tiles are resampled into a regular N×N grid covering the model square.
 */

import { decodePng } from './png';
import { lngLatToTile, makeProjector, metresPerPixel, type LngLat } from './projection';

export const TERRAIN_TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const TILE = 256;
const MAX_ZOOM = 14;
const MIN_ZOOM = 9;
/**
 * The source data includes bathymetry, so the sea floor can show up as deep pits.
 * Real sea areas are flattened to sea level once OSM coastlines arrive (see sea.ts);
 * until then, and where no coastline is mapped, values are clamped here. -30 m keeps
 * polders and most land depressions intact.
 */
export const SEA_FLOOR = -30;

export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

export interface HeightGrid {
  /** vertices per side */
  n: number;
  sizeM: number;
  /** elevations in metres, row-major, row 0 = south edge, column 0 = west edge */
  elev: Float32Array;
  min: number;
  max: number;
  /** zoom level of the source tiles */
  zoom: number;
}

export function chooseZoom(lat: number, sizeM: number, n: number): number {
  const spacing = sizeM / (n - 1);
  const z = Math.ceil(Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180)) / spacing));
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

/** Bilinear sample of a height grid at local (E, N) metres, clamped to the grid. */
export function sampleGrid(g: HeightGrid, e: number, nm: number): number {
  const h = g.sizeM / 2;
  const step = g.sizeM / (g.n - 1);
  let fx = (e + h) / step;
  let fy = (nm + h) / step;
  fx = Math.max(0, Math.min(g.n - 1.000001, fx));
  fy = Math.max(0, Math.min(g.n - 1.000001, fy));
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const tx = fx - i;
  const ty = fy - j;
  const n = g.n;
  const a = g.elev[j * n + i];
  const b = g.elev[j * n + i + 1];
  const c = g.elev[(j + 1) * n + i];
  const d = g.elev[(j + 1) * n + i + 1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** A mosaic of decoded tiles: tile (tx0, ty0) at its top-left. */
export interface Mosaic {
  z: number;
  tx0: number;
  ty0: number;
  cols: number;
  rows: number;
  /** (cols*256) × (rows*256) elevations */
  data: Float32Array;
}

/** Holes: pixels this far below sea level (deeper than the -30 m sea floor the model keeps), in a patch ringed by land or shallow water, are data errors. */
export const HOLE_BELOW_M = -40;
/** Holes: patches up to this many pixels (about 400 m across at zoom 14); open water is far larger. */
export const HOLE_MAX_PX = 4096;

/**
 * Fill the holes the elevation tiles have in a few places: waterfronts in Hong Kong and New York
 * drop thousands of metres in patches of a few pixels, which shows as deep needles at any
 * exaggeration. A patch of pixels below HOLE_BELOW_M that is small (HOLE_MAX_PX) and ringed by
 * ground near or above sea level is filled with the median height of that ring. Real terrain
 * (cliffs, gorges, lakes) and open sea are left as they are. Returns the number of pixels filled;
 * changes `data` in place.
 */
export function fillHoles(data: Float32Array, w: number, h: number): number {
  const seen = new Uint8Array(data.length);
  const stack: number[] = [];
  const members: number[] = [];
  const ring: number[] = [];
  let filled = 0;
  for (let start = 0; start < data.length; start++) {
    if (seen[start] || !(data[start] < HOLE_BELOW_M)) continue;
    members.length = 0;
    ring.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      members.push(i);
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (data[j] < HOLE_BELOW_M) {
            if (!seen[j]) {
              seen[j] = 1;
              stack.push(j);
            }
          } else {
            ring.push(data[j]);
          }
        }
      }
    }
    if (members.length > HOLE_MAX_PX || !ring.length) continue;
    ring.sort((a, b) => a - b);
    const level = ring[ring.length >> 1];
    if (level < HOLE_BELOW_M / 2) continue; // ringed by deep water: real bathymetry
    for (const i of members) data[i] = level;
    filled += members.length;
  }
  return filled;
}

/** Resample a mosaic into the model grid (pure; unit-tested). */
export function gridFromMosaic(m: Mosaic, center: LngLat, sizeM: number, n: number): HeightGrid {
  const proj = makeProjector(center);
  const width = m.cols * TILE;
  const height = m.rows * TILE;
  const elev = new Float32Array(n * n);
  const h = sizeM / 2;
  const step = sizeM / (n - 1);
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j < n; j++) {
    const nm = -h + j * step;
    for (let i = 0; i < n; i++) {
      const e = -h + i * step;
      const ll = proj.toLngLat(e, nm);
      const [tx, ty] = lngLatToTile(ll.lon, ll.lat, m.z);
      // pixel centres sit at +0.5
      let px = (tx - m.tx0) * TILE - 0.5;
      let py = (ty - m.ty0) * TILE - 0.5;
      px = Math.max(0, Math.min(width - 1.000001, px));
      py = Math.max(0, Math.min(height - 1.000001, py));
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const fx = px - x0;
      const fy = py - y0;
      const d = m.data;
      const v00 = d[y0 * width + x0];
      const v10 = d[y0 * width + x0 + 1];
      const v01 = d[(y0 + 1) * width + x0];
      const v11 = d[(y0 + 1) * width + x0 + 1];
      let v = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
      if (v < SEA_FLOOR) v = SEA_FLOOR;
      elev[j * n + i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { n, sizeM, elev, min, max, zoom: m.z };
}

async function decodeTile(blob: Blob): Promise<Float32Array> {
  // Decode the PNG bytes directly: reading pixels back from a canvas gets noise added in browsers
  // with fingerprinting protection, and one unit of red is 256 m (see png.ts). The canvas stays
  // as a fallback for browsers without DecompressionStream.
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const png = await decodePng(new Uint8Array(await blob.arrayBuffer()));
      if (png.width === TILE && png.height === TILE) return heightsFromPixels(png.data, png.channels);
    } catch (err) {
      console.warn('terrain tile: falling back to canvas decoding', err);
    }
  }
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(TILE, TILE) : Object.assign(document.createElement('canvas'), { width: TILE, height: TILE });
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return heightsFromPixels(ctx.getImageData(0, 0, TILE, TILE).data, 4);
}

/** Terrarium heights from RGB(A) bytes. */
export function heightsFromPixels(px: ArrayLike<number>, channels: number): Float32Array {
  const out = new Float32Array(TILE * TILE);
  for (let k = 0, p = 0; k < out.length; k++, p += channels) out[k] = decodeTerrarium(px[p], px[p + 1], px[p + 2]);
  return out;
}

async function fetchTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Float32Array> {
  const n = 2 ** z;
  const wx = ((x % n) + n) % n;
  const url = TERRAIN_TILE_URL.replace('{z}', String(z)).replace('{x}', String(wx)).replace('{y}', String(y));
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal, mode: 'cors' });
      if (!res.ok) throw new Error(`terrain tile ${z}/${wx}/${y}: HTTP ${res.status}`);
      return await decodeTile(await res.blob());
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Fetch the tiles covering the square and resample them into an n×n grid. */
/** `zoom` overrides the elevation tiles' zoom, so the squares of a bigger map are sampled alike. */
export async function loadHeightGrid(center: LngLat, sizeM: number, n: number, signal?: AbortSignal, zoom?: number): Promise<HeightGrid> {
  const z = zoom ?? chooseZoom(center.lat, sizeM, n);
  const proj = makeProjector(center);
  // one pixel of margin so bilinear sampling at the edge has neighbours
  const margin = metresPerPixel(center.lat, z) * 2;
  const h = sizeM / 2 + margin;
  const nw = proj.toLngLat(-h, h);
  const se = proj.toLngLat(h, -h);
  const [ax, ay] = lngLatToTile(nw.lon, nw.lat, z);
  const [bx, by] = lngLatToTile(se.lon, se.lat, z);
  const tx0 = Math.floor(ax);
  const ty0 = Math.floor(ay);
  const cols = Math.floor(bx) - tx0 + 1;
  const rows = Math.floor(by) - ty0 + 1;
  const width = cols * TILE;
  const data = new Float32Array(width * rows * TILE);
  const jobs: Promise<void>[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      jobs.push(
        fetchTile(z, tx0 + c, ty0 + r, signal).then((tile) => {
          for (let y = 0; y < TILE; y++) {
            data.set(tile.subarray(y * TILE, (y + 1) * TILE), (r * TILE + y) * width + c * TILE);
          }
        }),
      );
    }
  }
  await Promise.all(jobs);
  fillHoles(data, width, rows * TILE);
  return gridFromMosaic({ z, tx0, ty0, cols, rows, data }, center, sizeM, n);
}

/** Contour interval auto-scaled to the relief (spec: 5, 10 or 20 m). */
export function contourInterval(reliefM: number): number {
  if (reliefM <= 60) return 5;
  if (reliefM <= 250) return 10;
  return 20;
}
