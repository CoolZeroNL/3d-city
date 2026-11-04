/**
 * Roof bumps: in some regions the free elevation data is a surface model (radar from satellites
 * sees roofs, not the ground beneath them), so large buildings show up as smooth hills about as
 * tall as the building — the real building then stands on top of its own ghost. Singapore's
 * centre has bumps of up to 47 m; Germany and the US have bare-ground data and none at all.
 *
 * The fix only acts where the data is clearly a surface model, judged from the buildings
 * themselves: when many large buildings sit on a bump, the ground under them is lowered to the
 * street level around them. A bump much higher than its building is a real hill (a castle on its
 * rock) and is left alone, as is everything in areas where only the odd building sits higher.
 */

import { pointInRing, signedArea, type Polygon, type Pt } from './polygon';
import { sampleGrid, type HeightGrid } from './terrain';

/** Buildings big enough for 10–30 m elevation data to see (m²). */
export const ROOF_MIN_AREA = 800;
/** A bump this high under a large building counts as a roof in the data (m). */
export const ROOF_BUMP_M = 3;
/** The data is a surface model when at least this share of large buildings has a roof bump… */
export const ROOF_SHARE = 0.15;
/** …and at least this many of them do. */
export const ROOF_MIN_COUNT = 5;

export interface Footprint {
  poly: Polygon;
  /** building height above ground (m) */
  height: number;
}

export interface RoofBumpResult {
  /** large buildings looked at */
  large: number;
  /** of those, buildings standing on a roof bump */
  bumped: number;
  /** whether the area was judged a surface model and corrected */
  applied: boolean;
  /** grid points lowered */
  lowered: number;
  /** largest lowering (m) */
  maxDrop: number;
}

/** The highest bump a building of this height can leave in a surface model; anything higher is a real hill. */
export const roofCap = (height: number) => Math.max(height * 1.5, height + 15);

interface Measured {
  ring: Pt[];
  bbox: [number, number, number, number];
  ref: number;
  bump: number;
  height: number;
  /** the ground keeps falling beyond the building: a real hill, not a roof */
  hill: boolean;
}

/**
 * Ground level around a point between two distances: the mean of opposite points cancels a
 * slope; a low percentile skips neighbouring roofs.
 */
function groundAround(grid: HeightGrid, cx: number, cy: number, d0: number, d1: number): number {
  const pairs: number[] = [];
  for (const d of [d0, (d0 + d1) / 2, d1]) {
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI) / 12;
      const dx = Math.cos(a) * d;
      const dy = Math.sin(a) * d;
      pairs.push((sampleGrid(grid, cx + dx, cy + dy) + sampleGrid(grid, cx - dx, cy - dy)) / 2);
    }
  }
  pairs.sort((a, c) => a - c);
  return pairs[Math.floor(pairs.length * 0.25)];
}

const isRoof = (m: Measured, minBump: number) => m.bump > minBump && m.bump <= roofCap(m.height) && !m.hill;

function distanceToRing(p: Pt, ring: Pt[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j];
    const [bx, by] = ring[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
  }
  return best;
}

/** Changes `grid.elev` in place (and its max); returns what it found and did. */
export function removeRoofBumps(grid: HeightGrid, buildings: Footprint[]): RoofBumpResult {
  const { n, sizeM, elev } = grid;
  const step = sizeM / (n - 1);
  const h = sizeM / 2;
  const measured: Measured[] = [];

  for (const b of buildings) {
    const ring = b.poly.outer;
    const area = Math.abs(signedArea(ring)) - b.poly.holes.reduce((a, r) => a + Math.abs(signedArea(r)), 0);
    if (area < ROOF_MIN_AREA || ring.length < 3) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of ring) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    if (x1 < -h || x0 > h || y1 < -h || y0 > h) continue;
    // the ground under the building: grid points inside it, or its middle for small ones
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, Math.ceil((y0 + h) / step)); j <= Math.min(n - 1, Math.floor((y1 + h) / step)); j++) {
      for (let i = Math.max(0, Math.ceil((x0 + h) / step)); i <= Math.min(n - 1, Math.floor((x1 + h) / step)); i++) {
        if (pointInRing([-h + i * step, -h + j * step], ring)) {
          sum += elev[j * n + i];
          count++;
        }
      }
    }
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const inside = count ? sum / count : sampleGrid(grid, cx, cy);
    // street level just around it, and further out: a roof bump is level again just beyond the
    // building, a real hill keeps falling
    const r = Math.sqrt(area / Math.PI);
    const near = groundAround(grid, cx, cy, r + 25, r + 45);
    const far = groundAround(grid, cx, cy, r + 90, r + 130);
    const bump = inside - near;
    measured.push({ ring, bbox: [x0, y0, x1, y1], ref: near, bump, height: b.height, hill: near - far > Math.max(3, 0.3 * bump) });
  }

  const bumped = measured.filter((m) => isRoof(m, ROOF_BUMP_M)).length;
  const result: RoofBumpResult = { large: measured.length, bumped, applied: false, lowered: 0, maxDrop: 0 };
  if (bumped < ROOF_MIN_COUNT || bumped < measured.length * ROOF_SHARE) return result;
  result.applied = true;

  // lower the ground under each bumped building to street level, blending out over a margin
  const margin = Math.max(step * 1.5, 20);
  for (const m of measured) {
    if (!isRoof(m, 1)) continue;
    const [x0, y0, x1, y1] = m.bbox;
    for (let j = Math.max(0, Math.ceil((y0 - margin + h) / step)); j <= Math.min(n - 1, Math.floor((y1 + margin + h) / step)); j++) {
      for (let i = Math.max(0, Math.ceil((x0 - margin + h) / step)); i <= Math.min(n - 1, Math.floor((x1 + margin + h) / step)); i++) {
        const p: Pt = [-h + i * step, -h + j * step];
        const k = j * n + i;
        const v = elev[k];
        if (v <= m.ref) continue;
        const d = pointInRing(p, m.ring) ? 0 : distanceToRing(p, m.ring);
        if (d >= margin) continue;
        const target = m.ref + (v - m.ref) * (d / margin);
        if (target < v) {
          result.maxDrop = Math.max(result.maxDrop, v - target);
          elev[k] = target;
          result.lowered++;
        }
      }
    }
  }
  let max = -Infinity;
  for (const v of elev) max = Math.max(max, v);
  grid.max = max;
  return result;
}
