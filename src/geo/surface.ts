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
 *
 * Where OpenStreetMap has no height for a building, its bump is the best measure there is: the
 * ground goes back down, and the building takes the bump's height (Anchorage's unmapped towers
 * otherwise stood 5 m tall inside hills of their own roofs).
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
  /** false where the height is a fallback (no height or floor count in OpenStreetMap) */
  heightKnown?: boolean;
}

/** For buildings without a known height only the shape tells a roof from a hill; above this it's a hill (m). */
export const UNKNOWN_ROOF_CAP = 250;

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
  /** of the large buildings, those still on a roof bump afterwards (same measure as `bumped`) */
  remaining: number;
  /** new heights (by index into the buildings) for buildings without a known height, from their roof bumps */
  heights: Map<number, number>;
}

/** The highest bump a building of this height can leave in a surface model; anything higher is a real hill. */
export const roofCap = (height: number) => Math.max(height * 1.5, height + 15);

interface Measured {
  index: number;
  known: boolean;
  ring: Pt[];
  poly: Polygon;
  bbox: [number, number, number, number];
  ref: number;
  bump: number;
  /** the tallest of this building and its close neighbours: a podium's bump can be its tower's roof */
  height: number;
  /** the ground keeps falling beyond the building: a real hill, not a roof */
  hill: boolean;
}

/**
 * Ground level around a point between two distances: the mean of opposite points cancels a
 * slope; a low percentile skips neighbouring roofs.
 */
function groundAround(grid: HeightGrid, cx: number, cy: number, d0: number, d1: number): number {
  // near the model's edge only points inside it count; with too few opposite pairs left,
  // single points stand in (less slope-proof, but better than reading the edge again and again)
  const h = grid.sizeM / 2;
  const within = (x: number, y: number) => Math.abs(x) <= h && Math.abs(y) <= h;
  const pairs: number[] = [];
  const singles: number[] = [];
  for (const d of [d0, (d0 + d1) / 2, d1]) {
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI) / 12;
      const dx = Math.cos(a) * d;
      const dy = Math.sin(a) * d;
      const inA = within(cx + dx, cy + dy);
      const inB = within(cx - dx, cy - dy);
      if (inA && inB) pairs.push((sampleGrid(grid, cx + dx, cy + dy) + sampleGrid(grid, cx - dx, cy - dy)) / 2);
      if (inA) singles.push(sampleGrid(grid, cx + dx, cy + dy));
      if (inB) singles.push(sampleGrid(grid, cx - dx, cy - dy));
    }
  }
  const use = pairs.length >= 8 ? pairs : singles;
  if (use.length < 6) return NaN;
  use.sort((a, c) => a - c);
  return use[Math.floor(use.length * 0.25)];
}

/**
 * Whether the ground keeps falling beyond `near` out to `far` in nearly every direction: a real
 * hill does, a roof bump is level again, and so is a building near a bluff (the ground drops on
 * one side only). Per direction the lowest of a few samples counts, which skips roofs on the way.
 * Null where too few directions stay inside the model.
 */
function fallsAway(grid: HeightGrid, cx: number, cy: number, near: [number, number], far: [number, number], drop: number): boolean | null {
  const h = grid.sizeM / 2;
  const within = (x: number, y: number) => Math.abs(x) <= h && Math.abs(y) <= h;
  const lowest = (dx: number, dy: number, [d0, d1]: [number, number]) => {
    let m = Infinity;
    for (let s = 0; s <= 4; s++) {
      const d = d0 + ((d1 - d0) * s) / 4;
      const x = cx + dx * d;
      const y = cy + dy * d;
      if (!within(x, y)) return NaN;
      m = Math.min(m, sampleGrid(grid, x, y));
    }
    return m;
  };
  let valid = 0;
  let falling = 0;
  for (let k = 0; k < 24; k++) {
    const a = (k * Math.PI) / 12;
    const n = lowest(Math.cos(a), Math.sin(a), near);
    const f = lowest(Math.cos(a), Math.sin(a), far);
    if (Number.isNaN(n) || Number.isNaN(f)) continue;
    valid++;
    if (n - f > drop) falling++;
  }
  return valid < 8 ? null : falling >= valid * 0.75;
}

/**
 * How far the ground under a building rises above street level around it (`bump`), and whether
 * the ground keeps falling further out (`hill`: a real hill rather than a roof in the data).
 * Exported for tools/inspect, so the inspection measures exactly what the fix uses.
 */
export function measureGround(grid: HeightGrid, poly: Polygon): { bump: number; near: number; hill: boolean; area: number } | null {
  const ring = poly.outer;
  const area = Math.abs(signedArea(ring)) - poly.holes.reduce((a, r) => a + Math.abs(signedArea(r)), 0);
  if (ring.length < 3) return null;
  const { n, sizeM, elev } = grid;
  const step = sizeM / (n - 1);
  const h = sizeM / 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  if (x1 < -h || x0 > h || y1 < -h || y0 > h) return null;
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
  // street level just around it; a roof bump is level again just beyond the building, a real
  // hill keeps falling further out
  const r = Math.sqrt(Math.max(area, 1) / Math.PI);
  const near = groundAround(grid, cx, cy, r + 25, r + 45);
  if (Number.isNaN(near)) return null;
  const bump = inside - near;
  // without ground further out (deep in a corner) a hill can't be ruled out: count it as one
  const hill = fallsAway(grid, cx, cy, [r + 25, r + 45], [r + 90, r + 130], Math.max(3, 0.3 * bump)) ?? true;
  return { bump, near, hill, area };
}

const isRoof = (m: Measured, minBump: number) => m.bump > minBump && m.bump <= (m.known ? roofCap(m.height) : UNKNOWN_ROOF_CAP) && !m.hill;

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

  // the tallest building near each large one (a spatial hash of footprint middles, 100 m cells)
  const CELL = 100;
  const cells = new Map<string, { x: number; y: number; height: number }[]>();
  const middle = (poly: Polygon): Pt => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly.outer) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  };
  for (const b of buildings) {
    const [x, y] = middle(b.poly);
    const key = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
    const list = cells.get(key) ?? [];
    list.push({ x, y, height: b.height });
    cells.set(key, list);
  }
  const tallestNear = (x: number, y: number, radius: number) => {
    let best = 0;
    for (let gx = Math.floor((x - radius) / CELL); gx <= Math.floor((x + radius) / CELL); gx++) {
      for (let gy = Math.floor((y - radius) / CELL); gy <= Math.floor((y + radius) / CELL); gy++) {
        for (const o of cells.get(`${gx},${gy}`) ?? []) if (Math.hypot(o.x - x, o.y - y) <= radius) best = Math.max(best, o.height);
      }
    }
    return best;
  };

  for (const [index, b] of buildings.entries()) {
    const m = measureGround(grid, b.poly);
    if (!m || m.area < ROOF_MIN_AREA) continue;
    const ring = b.poly.outer;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of ring) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    const r = Math.sqrt(m.area / Math.PI);
    const height = Math.max(b.height, tallestNear((x0 + x1) / 2, (y0 + y1) / 2, r + 60));
    measured.push({ index, known: b.heightKnown !== false, ring, poly: b.poly, bbox: [x0, y0, x1, y1], ref: m.near, bump: m.bump, height, hill: m.hill });
  }

  const bumped = measured.filter((m) => isRoof(m, ROOF_BUMP_M)).length;
  const result: RoofBumpResult = { large: measured.length, bumped, applied: false, lowered: 0, maxDrop: 0, remaining: bumped, heights: new Map() };
  if (bumped < ROOF_MIN_COUNT || bumped < measured.length * ROOF_SHARE) return result;
  result.applied = true;

  // lower the ground under each bumped building to street level, blending out over a margin
  const margin = Math.max(step * 1.5, 20);
  for (const m of measured) {
    if (!isRoof(m, 1)) continue;
    // the data measured this building's roof: better than a fallback height
    const own = buildings[m.index].height;
    if (!m.known && m.bump >= ROOF_BUMP_M && m.bump > own) result.heights.set(m.index, Math.round(m.bump * 10) / 10);
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
  // measure again, the same way, to report what is left
  result.remaining = measured.filter((m) => {
    const again = measureGround(grid, m.poly);
    return !!again && isRoof({ ...m, bump: again.bump, hill: again.hill }, ROOF_BUMP_M);
  }).length;
  return result;
}
