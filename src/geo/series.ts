/**
 * A bigger map made of squares side by side, for 3D prints that fit together at the edges.
 *
 * Every square in a series shares what decides its print: the area, the print size, the terrain
 * exaggeration, the terrain grid (points per side and the elevation tiles' zoom) and one base
 * height. Without a shared base, each square would start at its own lowest point and the seams
 * wouldn't meet. Squares sit on a grid around the first one: i squares east, j squares north,
 * all measured from the first square's centre, so no error builds up across a big map.
 */

import type { HeightGrid } from './terrain';
import { makeProjector, round, type LngLat } from './projection';

export interface Series {
  /** centre of the first square */
  origin: LngLat;
  /** this square's place: squares east (i) and north (j) of the first */
  i: number;
  j: number;
  /** the height every square's print measures from (m above sea level) */
  ref: number;
  /** terrain grid points per side, and the zoom of the elevation tiles */
  n: number;
  z: number;
  /** print size of one square (mm) */
  mm: number;
  /** terrain exaggeration */
  ex: number;
}

/** How far a series may reach from its first square, in squares. */
export const SERIES_REACH = 50;

/** Centre of the series' current square. */
export function seriesCenter(s: Series, sizeM: number): LngLat {
  return makeProjector(s.origin).toLngLat(s.i * sizeM, s.j * sizeM);
}

/** "E1 N0", "W2 S1": where a square sits, counted from the first one. */
export function squareLabel(i: number, j: number): string {
  return `${i < 0 ? 'W' : 'E'}${Math.abs(i)} ${j < 0 ? 'S' : 'N'}${Math.abs(j)}`;
}

/** The base height for a new series: a little below the lowest ground found around it, in whole 10 m. */
export function referenceHeight(lowestM: number): number {
  return Math.floor((lowestM - 20) / 10) * 10;
}

/** The grid measured from the series' base: ground that dips below the base is flattened onto it. */
export function withReference(grid: HeightGrid, ref: number): HeightGrid {
  const elev = Float32Array.from(grid.elev, (v) => Math.max(v, ref));
  return { ...grid, elev, min: ref, max: Math.max(grid.max, ref) };
}

/** "48.77650,9.17720,1,0,230,385,15,200,1.5" */
export function encodeSeries(s: Series): string {
  return [
    round(s.origin.lat, 5).toFixed(5),
    round(s.origin.lon, 5).toFixed(5),
    s.i,
    s.j,
    round(s.ref, 1),
    s.n,
    s.z,
    s.mm,
    round(s.ex, 1),
  ].join(',');
}

export function decodeSeries(raw: string | null | undefined): Series | null {
  if (!raw) return null;
  const v = raw.split(',').map(Number);
  if (v.length !== 9 || !v.every(Number.isFinite)) return null;
  const [lat, lon, i, j, ref, n, z, mm, ex] = v;
  const whole = (x: number) => Number.isInteger(x);
  if (Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
  if (!whole(i) || !whole(j) || Math.abs(i) > SERIES_REACH || Math.abs(j) > SERIES_REACH) return null;
  if (ref < -500 || ref > 9000) return null;
  if (!whole(n) || n < 33 || n > 1025 || !whole(z) || z < 1 || z > 15) return null;
  if (![100, 150, 200].includes(mm) || ex < 1 || ex > 5) return null;
  return { origin: { lat, lon }, i, j, ref, n, z, mm, ex };
}
