/**
 * Sunken water for 3D prints: lakes, rivers drawn as areas, and the sea sit a little lower
 * than the land around them, so they stand out and have an edge to paint along.
 *
 * Only the print changes: a copy of the height grid with the water lowered, still measured
 * from the same lowest point, so buildings keep their heights. The bank follows the terrain
 * grid, so it is a short slope one grid step wide rather than a sharp wall.
 */

import { pointInRing, type Polygon } from '../geo/polygon';
import type { HeightGrid } from '../geo/terrain';

/** How far water sits below the land in the print (mm), whatever the scale and exaggeration. */
export const WATER_DEPTH_MM = 1;

/** Grid points under water (1) or not (0): inside a water area but not on an island in it, or at sea. */
export function waterMask(grid: HeightGrid, areas: Polygon[], seaAt?: (e: number, n: number) => boolean): Uint8Array {
  const { n, sizeM } = grid;
  const step = sizeM / (n - 1);
  const h = sizeM / 2;
  const mask = new Uint8Array(n * n);
  if (seaAt) {
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (seaAt(-h + i * step, -h + j * step)) mask[j * n + i] = 1;
  }
  for (const poly of areas) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly.outer) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    for (let j = Math.max(0, Math.ceil((y0 + h) / step)); j <= Math.min(n - 1, Math.floor((y1 + h) / step)); j++) {
      for (let i = Math.max(0, Math.ceil((x0 + h) / step)); i <= Math.min(n - 1, Math.floor((x1 + h) / step)); i++) {
        const p: [number, number] = [-h + i * step, -h + j * step];
        if (pointInRing(p, poly.outer) && !poly.holes.some((r) => pointInRing(p, r))) mask[j * n + i] = 1;
      }
    }
  }
  return mask;
}

/** The grid with water lowered by `depthM` (m); `min` stays, so every height keeps its reference. */
export function sinkWater(grid: HeightGrid, mask: Uint8Array, depthM: number): HeightGrid {
  const elev = Float32Array.from(grid.elev);
  for (let k = 0; k < elev.length; k++) if (mask[k]) elev[k] -= depthM;
  return { ...grid, elev };
}

/** Metres of terrain that make `depthMm` in a print `printMm` wide of a square `sizeM` wide, at this exaggeration. */
export const depthInMetres = (depthMm: number, printMm: number, sizeM: number, exaggeration: number) => depthMm / ((printMm / sizeM) * exaggeration);
