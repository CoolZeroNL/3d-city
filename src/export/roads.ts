/**
 * Raised roads for 3D prints: every road a thin strip standing a little above the terrain, with
 * sharp edges to paint along.
 *
 * The terrain grid is too coarse to carve roads into (its points are 4–10 m apart, many roads
 * are narrower), so roads are their own pieces on top, as the buildings are. Each road segment
 * is cut into short convex pieces wherever the ground under it bends; each piece is a closed
 * shell whose top follows the printed terrain and whose floor is buried in the block. Pieces
 * overlap a little and slicers merge them, so no two shells share a face. Corners up to 90° are
 * mitred by running both segments on to the mitre point; sharper ones get an octagon.
 */

import type { Pt } from '../geo/polygon';
import type { HeightGrid } from '../geo/terrain';
import type { Triangles } from './stl';

/** How far roads stand above the ground under them (mm): two layers at 0.2 mm. */
export const ROAD_RAISE_MM = 0.4;
/** Roads are printed at least this wide (mm), about one line of a 0.4 mm nozzle and a bit. */
export const ROAD_MIN_MM = 0.5;
/** Roads narrower than this at true scale (mm) are left out: at small scales only the main roads. */
export const ROAD_SKIP_MM = 0.3;

/** A road for print: centreline (m from the centre), real width (m), and whether it's a bridge. */
export interface PrintRoad {
  pts: Pt[];
  widthM: number;
  bridge: boolean;
}

type V = [number, number, number];

/** How deep the pieces reach into the terrain block (mm). */
const BURY_MM = 0.6;
/** How far neighbouring pieces overlap (mm), so they never share a face. */
const OVERLAP_MM = 0.05;
/** The most the ground may bend under one piece before it is cut (mm). */
const BEND_MM = 0.04;

/**
 * The printed terrain's top at (x, y) metres, in mm above the block's zero: the same two triangles
 * per grid cell as the terrain block (a b d and a d c), so a road sits exactly on what is printed.
 */
export function surfaceMm(grid: HeightGrid, x: number, y: number, ex: number, s: number): number {
  const { n, sizeM, elev, min } = grid;
  const step = sizeM / (n - 1);
  const fx = Math.max(0, Math.min(n - 1 - 1e-9, (x + sizeM / 2) / step));
  const fy = Math.max(0, Math.min(n - 1 - 1e-9, (y + sizeM / 2) / step));
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const tx = fx - i;
  const ty = fy - j;
  const a = elev[j * n + i];
  const b = elev[j * n + i + 1];
  const c = elev[(j + 1) * n + i];
  const d = elev[(j + 1) * n + i + 1];
  const z = tx >= ty ? a + tx * (b - a) + ty * (d - b) : a + ty * (c - a) + tx * (d - c);
  return (z - min) * ex * s;
}

/** Keep the part of a convex polygon inside the rectangle (Sutherland–Hodgman). */
function clipConvex(poly: Pt[], x0: number, y0: number, x1: number, y1: number): Pt[] {
  let out = poly;
  const edges: Array<[(p: Pt) => number, number, number]> = [
    [(p) => p[0] - x0, 0, x0],
    [(p) => x1 - p[0], 0, x1],
    [(p) => p[1] - y0, 1, y0],
    [(p) => y1 - p[1], 1, y1],
  ];
  for (const [inside, axis, at] of edges) {
    if (out.length < 3) return [];
    const next: Pt[] = [];
    for (let k = 0; k < out.length; k++) {
      const p = out[k];
      const q = out[(k + 1) % out.length];
      const dp = inside(p);
      const dq = inside(q);
      if (dp >= 0) next.push(p);
      if ((dp >= 0) !== (dq >= 0)) {
        const t = dp / (dp - dq);
        const cut: Pt = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        cut[axis] = at; // exactly on the edge
        next.push(cut);
      }
    }
    out = next;
  }
  return out;
}

/** Twice the signed area of a polygon (anticlockwise positive). */
function area2(p: Pt[]): number {
  let a = 0;
  for (let k = 0; k < p.length; k++) {
    const [x0, y0] = p[k];
    const [x1, y1] = p[(k + 1) % p.length];
    a += x0 * y1 - x1 * y0;
  }
  return a;
}

/**
 * One closed piece: a convex outline (mm, anticlockwise), its top at `top(p)` for each corner and
 * a flat floor at `floor`. Fans for top and floor, a quad (two triangles) per wall.
 */
function emitPiece(t: Triangles, outline: Pt[], tops: number[], floor: number): void {
  const m = outline.length;
  const up = (k: number): V => [outline[k][0], outline[k][1], tops[k]];
  const down = (k: number): V => [outline[k][0], outline[k][1], floor];
  for (let k = 1; k < m - 1; k++) {
    t.add(up(0), up(k), up(k + 1), [0, 0, 1]);
    t.add(down(0), down(k + 1), down(k), [0, 0, -1]);
  }
  for (let k = 0; k < m; k++) {
    const k1 = (k + 1) % m;
    const out: V = [outline[k1][1] - outline[k][1], outline[k][0] - outline[k1][0], 0];
    t.add(down(k), down(k1), up(k1), out);
    t.add(down(k), up(k1), up(k), out);
  }
}

export interface RoadOptions {
  /** mm per metre */
  s: number;
  exaggeration: number;
  /** how far roads stand up (mm) */
  raiseMm?: number;
}

/**
 * Add the roads to the print, cut to the grid's square. Coordinates are metres from the grid's
 * centre (as the buildings'); the output is in mm. Returns how many roads were added.
 */
export function addRoads(t: Triangles, grid: HeightGrid, roads: PrintRoad[], opts: RoadOptions): number {
  const { s, exaggeration: ex } = opts;
  const raise = opts.raiseMm ?? ROAD_RAISE_MM;
  const half = grid.sizeM / 2;
  // keep a hair inside the block's sides, so a road's end never lies in the side wall's plane
  const edge = half - 0.01 / s;
  const step = grid.sizeM / (grid.n - 1);
  const ground = (p: Pt) => surfaceMm(grid, p[0], p[1], ex, s);
  const overlap = OVERLAP_MM / s;
  let added = 0;

  roads.forEach((road, ri) => {
    if (road.widthM * s < ROAD_SKIP_MM || road.pts.length < 2) return;
    const pts = road.pts.filter((p, k) => k === 0 || p[0] !== road.pts[k - 1][0] || p[1] !== road.pts[k - 1][1]);
    if (pts.length < 2) return;
    // skip roads wholly outside the square
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const [x, y] of pts) {
      bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y);
    }
    const hw = Math.max(road.widthM, ROAD_MIN_MM / s) / 2;
    if (bx1 < -half - hw || bx0 > half + hw || by1 < -half - hw || by0 > half + hw) return;
    // vary the inset and depth a little per road, so duplicate roads don't make identical shells
    const shrink = (0.01 / s) * (1 + 0.4 * (ri % 5));
    const w = hw - shrink;
    const bury = BURY_MM + 0.003 * (ri % 97);

    // a bridge keeps a straight deck between its ends, over whatever is under it
    const deckFrom = ground(pts[0]);
    const deckTo = ground(pts[pts.length - 1]);
    const lengths = [0];
    for (let k = 1; k < pts.length; k++) lengths.push(lengths[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    const total = lengths[lengths.length - 1];
    const topAt = (p: Pt, along: number) => {
      const g = ground(p) + raise;
      return road.bridge && total > 0 ? Math.max(g, deckFrom + ((deckTo - deckFrom) * along) / total + raise) : g;
    };

    const piece = (corners: Pt[], along: number[]) => {
      const cut = clipConvex(corners, -edge, -edge, edge, edge);
      if (cut.length < 3) return;
      const mm = cut.map(([x, y]) => [x * s, y * s] as Pt);
      if (Math.abs(area2(mm)) < 1e-6) return;
      if (area2(mm) < 0) {
        mm.reverse();
        cut.reverse();
      }
      // where along the road each corner is, for a bridge deck: nearest of the corners given
      const tops = cut.map((p) => {
        let best = 0;
        let bd = Infinity;
        corners.forEach((c, k) => {
          const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
          if (d < bd) {
            bd = d;
            best = along[k];
          }
        });
        return topAt(p, best);
      });
      const floor = Math.min(...cut.map(ground)) - bury;
      emitPiece(t, mm, tops, floor);
    };

    // turn angle at each inner point (0 straight on, π a U-turn)
    const turn = (k: number) => {
      const [ax, ay] = [pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]];
      const [bx, by] = [pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]];
      return Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
    };
    const mitre = (k: number) => {
      if (k <= 0 || k >= pts.length - 1) return overlap;
      const a = turn(k);
      return a <= Math.PI / 2 ? w * Math.tan(a / 2) + overlap : overlap;
    };

    for (let k = 0; k < pts.length - 1; k++) {
      const p = pts[k];
      const q = pts[k + 1];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const ux = (q[0] - p[0]) / len;
      const uy = (q[1] - p[1]) / len;
      const nx = -uy;
      const ny = ux;
      const from = -mitre(k);
      const to = len + mitre(k + 1);
      const at = (d: number, side: number): Pt => [p[0] + ux * d + nx * side * w, p[1] + uy * d + ny * side * w];
      // sample the ground along both edges and the middle; cut where it bends
      const count = Math.max(1, Math.ceil((to - from) / (step / 2)));
      const ds = Array.from({ length: count + 1 }, (_, i) => from + ((to - from) * i) / count);
      const z = ds.map((d) => [-1, 0, 1].map((side) => ground(at(d, side))));
      const cuts = [0];
      let start = 0;
      for (let e = 2; e <= count; e++) {
        // can one piece run from `start` to `e`? every sample between must lie near the straight line
        let fits = true;
        for (let m = start + 1; m < e && fits; m++) {
          const f = (ds[m] - ds[start]) / (ds[e] - ds[start]);
          for (let side = 0; side < 3; side++) {
            if (Math.abs(z[m][side] - (z[start][side] + (z[e][side] - z[start][side]) * f)) > BEND_MM) fits = false;
          }
        }
        if (!fits) {
          cuts.push(e - 1);
          start = e - 1;
        }
      }
      cuts.push(count);
      for (let c = 0; c < cuts.length - 1; c++) {
        // each piece runs on a little into the next, so they overlap instead of touching
        const d0 = ds[cuts[c]] - (c > 0 ? overlap : 0);
        const d1 = ds[cuts[c + 1]] + (c < cuts.length - 2 ? overlap : 0);
        const a0 = lengths[k] + Math.max(0, Math.min(len, d0));
        const a1 = lengths[k] + Math.max(0, Math.min(len, d1));
        piece([at(d0, -1), at(d1, -1), at(d1, 1), at(d0, 1)], [a0, a1, a1, a0]);
      }
      // a sharp corner: an octagon round the point, as wide as the road
      if (k + 1 < pts.length - 1 && turn(k + 1) > Math.PI / 2) {
        const r = w / Math.cos(Math.PI / 8);
        const oct: Pt[] = Array.from({ length: 8 }, (_, i) => [q[0] + r * Math.cos(((i + 0.5) * Math.PI) / 4), q[1] + r * Math.sin(((i + 0.5) * Math.PI) / 4)] as Pt);
        piece(oct, oct.map(() => lengths[k + 1]));
      }
    }
    added++;
  });
  return added;
}
