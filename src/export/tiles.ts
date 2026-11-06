/**
 * A print in tiles: the square split into n × n pieces that each fit a print bed and fit
 * together edge to edge.
 *
 * Each tile is built exactly like a whole print (a terrain block with buildings sunk into it),
 * from its own height grid resampled at the same coordinates along every shared border, and
 * measured from the lowest point of the whole square. So neighbouring edges match to the
 * vertex and every tile has the same base. Buildings across a border are cut exactly on it.
 */

import { clipBuildingToRect } from '../geo/clip';
import type { Polygon } from '../geo/polygon';
import { sampleGrid, type HeightGrid } from '../geo/terrain';
import type { PrintRoad } from './roads';
import { buildPrint, type PrintBuilding, type PrintOptions, type Triangles } from './stl';

/** Up to 8 × 8 tiles: 20 cm tiles make a 1.6 m model for a wall. */
export const MAX_TILES = 8;

export interface PrintTile {
  /** "A1": row letter from the north (back) edge, column number from the west (left) */
  name: string;
  row: number;
  col: number;
  tris: Triangles;
}

/** "A1" for the north-west tile, rows going south, columns going east. */
export const tileName = (row: number, col: number) => `${String.fromCharCode(65 + row)}${col + 1}`;

/** The square cut at k / n of its width, the same number for both tiles on a border. */
function border(sizeM: number, n: number, k: number): number {
  return -sizeM / 2 + (sizeM * k) / n;
}

/** The part of the height grid under one tile, sampled at least as finely as the whole. */
export function tileGrid(grid: HeightGrid, x0: number, y0: number, x1: number, y1: number, n: number): HeightGrid {
  const k = Math.ceil((grid.n - 1) / n) + 1;
  const elev = new Float32Array(k * k);
  const at = (a: number, b: number, i: number) => (i === 0 ? a : i === k - 1 ? b : a + ((b - a) * i) / (k - 1));
  for (let j = 0; j < k; j++) {
    const y = at(y0, y1, j);
    for (let i = 0; i < k; i++) elev[j * k + i] = sampleGrid(grid, at(x0, x1, i), y);
  }
  // heights stay measured from the lowest point of the whole square: every tile shares one base
  return { n: k, sizeM: x1 - x0, elev, min: grid.min, max: grid.max, zoom: grid.zoom };
}

const shift = (poly: Polygon, dx: number, dy: number): Polygon => ({
  outer: poly.outer.map(([x, y]) => [x - dx, y - dy]),
  holes: poly.holes.map((r) => r.map(([x, y]) => [x - dx, y - dy])),
});

/**
 * Build the print as n × n tiles, each `opts.sideMm` wide. Tiles come row by row from the
 * north-west; each is centred on its own origin, as a single print is.
 */
export function buildTiledPrint(grid: HeightGrid, buildings: PrintBuilding[], opts: PrintOptions & { tiles: number }, roads: PrintRoad[] = []): PrintTile[] {
  const n = Math.max(1, Math.round(opts.tiles));
  const out: PrintTile[] = [];
  for (let row = 0; row < n; row++) {
    // row 0 is the north edge: the top of the square
    const y0 = border(grid.sizeM, n, n - row - 1);
    const y1 = border(grid.sizeM, n, n - row);
    for (let col = 0; col < n; col++) {
      const x0 = border(grid.sizeM, n, col);
      const x1 = border(grid.sizeM, n, col + 1);
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const pieces: PrintBuilding[] = [];
      for (const b of buildings) {
        for (const poly of clipBuildingToRect(b.poly, x0, y0, x1, y1)) pieces.push({ poly: shift(poly, cx, cy), top: b.top });
      }
      // roads near the tile, moved to its centre; buildPrint cuts them at the tile's edges
      const margin = 50; // m: wider than any road, even at its smallest printed width
      const near = roads
        .filter((r) => r.pts.some(([x, y], k) => {
          const [px, py] = r.pts[Math.max(0, k - 1)];
          return Math.max(x, px) >= x0 - margin && Math.min(x, px) <= x1 + margin && Math.max(y, py) >= y0 - margin && Math.min(y, py) <= y1 + margin;
        }))
        .map((r) => ({ ...r, pts: r.pts.map(([x, y]) => [x - cx, y - cy] as [number, number]) }));
      const tris = buildPrint(tileGrid(grid, x0, y0, x1, y1, n), pieces, opts, near);
      out.push({ name: tileName(row, col), row, col, tris });
    }
  }
  return out;
}
