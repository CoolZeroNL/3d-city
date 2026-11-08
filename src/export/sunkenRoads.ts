/**
 * Sunken roads for 3D prints: roads, paths and railways cut a fixed depth into the ground, with
 * sharp walls to paint along or fill.
 *
 * Raised roads are their own pieces on top of the terrain (roads.ts), but a groove can't be a
 * piece of its own: slicers only add shells together. So here the terrain block itself is built
 * with the roads cut in.
 *
 * Where the roads are comes from a fine "distance to the nearest road edge" field, sampled k times
 * finer than the terrain grid (about 0.2 mm in the print): negative is road. Overlapping roads
 * merge on their own, ends and corners come out round. Its zero line, traced fine cell by fine
 * cell (marching squares), is the edge of the roads. Every point where that edge crosses a grid
 * line is computed once and shared by the cells on both sides, so the top stays one closed
 * surface without cracks.
 *
 * A terrain cell the edge runs through is split into road and land faces, by walking the edge's
 * pieces and the cell's own sides, and triangulated with earcut: land at the terrain's height,
 * road `depth` lower, vertical walls between. Cells the edge doesn't touch keep the terrain's two
 * triangles. A face across a cell's diagonal is flat between its points instead of bending along
 * the diagonal: a few hundredths of a millimetre at most.
 */

import earcut, { deviation } from 'earcut';
import type { HeightGrid } from '../geo/terrain';
import { ROAD_MIN_MM, ROAD_SKIP_MM, surfaceMm, type PrintRoad } from './roads';
import type { Triangles } from './stl';

/** How deep roads are cut into the ground (mm): three layers at 0.2 mm. */
export const ROAD_SINK_MM = 0.6;
/** The fine field's spacing in the print (mm), at most: a 0.5 mm road spans two and a half. */
const FINE_MM = 0.2;
/** At most this many fine steps per terrain step (large tiles of a small square). */
const MAX_K = 24;
/** Edge points closer than this to the straight line between their neighbours are dropped (mm). */
const SIMPLIFY_MM = 0.01;

type V = [number, number, number];
/** A point of the top in mm; z is the terrain's height there (the road's floor is lower). */
interface P {
  x: number;
  y: number;
  z: number;
}

/** A piece of road edge inside one terrain cell, road on its left, from one side of the cell to another. */
interface Chain {
  pts: P[];
  /** where it starts and ends on the cell's outline: 0–1 bottom, 1–2 right, 2–3 top, 3–4 left (anticlockwise) */
  u0: number;
  u1: number;
}

export interface CarveOptions {
  /** mm per metre */
  s: number;
  exaggeration: number;
  /** z of the block's flat bottom (mm, negative) */
  base: number;
  /** how deep roads are cut (mm) */
  depthMm: number;
}

const UP: V = [0, 0, 1];
const DOWN: V = [0, 0, -1];

/**
 * The terrain block, as one closed shell, with the roads cut into its top. Bridges are left out
 * (they cross water and valleys; add them raised). Returns how many roads were cut in.
 */
export function addCarvedTerrainBlock(t: Triangles, grid: HeightGrid, roads: PrintRoad[], opts: CarveOptions): number {
  const { n, sizeM, elev, min } = grid;
  const { s, exaggeration: ex, base, depthMm: depth } = opts;
  const h = sizeM / 2;
  const step = sizeM / (n - 1);
  const k = Math.max(1, Math.min(MAX_K, Math.ceil((step * s) / FINE_MM)));
  const nf = (n - 1) * k + 1;
  const fs = step / k;
  // one formula per line, so a fine line on a terrain line is exactly that line
  const at = (I: number) => (I % k === 0 ? -h + (I / k) * step : -h + I * fs);

  // --- the field: distance to the nearest road's edge (m), negative on the road
  const field = new Float64Array(nf * nf).fill(Infinity);
  let carved = 0;
  for (const road of roads) {
    if (road.bridge || road.widthM * s < ROAD_SKIP_MM || road.pts.length < 2) continue;
    const hw = Math.max(road.widthM, ROAD_MIN_MM / s) / 2;
    // far enough that every neighbour of a road point gets a value from the same road
    const reach = hw + 2 * fs;
    let touched = false;
    for (let q = 0; q < road.pts.length - 1; q++) {
      const [ax, ay] = road.pts[q];
      const [bx, by] = road.pts[q + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const j0 = Math.max(0, Math.ceil((Math.min(ay, by) - reach + h) / fs));
      const j1 = Math.min(nf - 1, Math.floor((Math.max(ay, by) + reach + h) / fs));
      for (let J = j0; J <= j1; J++) {
        const y = at(J);
        // the part of the segment within `reach` of this row, then its x range
        let u0 = 0;
        let u1 = 1;
        if (dy !== 0) {
          const a = (y - reach - ay) / dy;
          const b = (y + reach - ay) / dy;
          u0 = Math.max(0, Math.min(a, b));
          u1 = Math.min(1, Math.max(a, b));
          if (u0 > u1) continue;
        } else if (Math.abs(y - ay) > reach) continue;
        const xa = ax + u0 * dx;
        const xb = ax + u1 * dx;
        const i0 = Math.max(0, Math.ceil((Math.min(xa, xb) - reach + h) / fs));
        const i1 = Math.min(nf - 1, Math.floor((Math.max(xa, xb) + reach + h) / fs));
        if (i0 > i1) continue;
        touched = true;
        const row = J * nf;
        for (let I = i0; I <= i1; I++) {
          const x = at(I);
          let u = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          const d = Math.hypot(x - ax - u * dx, y - ay - u * dy) - hw;
          if (d < field[row + I]) field[row + I] = d;
        }
      }
    }
    if (touched) carved++;
  }
  const road = (I: number, J: number) => field[J * nf + I] < 0;

  // --- points, each computed once
  const corner = (i: number, j: number): P => ({ x: (-h + i * step) * s, y: (-h + j * step) * s, z: (elev[j * n + i] - min) * ex * s });
  const crossings = new Map<number, P>();
  /** Where the road edge crosses the fine edge from (I, J) to the right (or up, if `up`). */
  const crossing = (I: number, J: number, up: boolean): P => {
    const key = (J * nf + I) * 2 + (up ? 1 : 0);
    let p = crossings.get(key);
    if (p) return p;
    const a = field[J * nf + I];
    const b = up ? field[(J + 1) * nf + I] : field[J * nf + I + 1];
    // never on a fine point: keeps every edge piece a real length
    const f = Math.min(0.99, Math.max(0.01, a / (a - b)));
    const x = up ? at(I) : at(I) + (at(I + 1) - at(I)) * f;
    const y = up ? at(J) + (at(J + 1) - at(J)) * f : at(J);
    p = { x: x * s, y: y * s, z: surfaceMm(grid, x, y, ex, s) };
    crossings.set(key, p);
    return p;
  };

  const top = (p: P): V => [p.x, p.y, p.z];
  const low = (p: P): V => [p.x, p.y, p.z - depth];
  const wall = (p: P, q: P) => {
    const out: V = [p.y - q.y, q.x - p.x, 0]; // left of p → q: towards the road
    t.add(low(p), low(q), top(q), out);
    t.add(low(p), top(q), top(p), out);
  };

  // --- the top, cell by cell
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const I0 = i * k;
      const J0 = j * k;
      const first = road(I0, J0);
      let mixed = false;
      for (let J = J0; J <= J0 + k && !mixed; J++) for (let I = I0; I <= I0 + k; I++) if (road(I, J) !== first) { mixed = true; break; }
      const c = [corner(i, j), corner(i + 1, j), corner(i + 1, j + 1), corner(i, j + 1)]; // anticlockwise from bottom left
      if (!mixed) {
        const lift = first ? low : top;
        t.add(lift(c[0]), lift(c[1]), lift(c[2]), UP);
        t.add(lift(c[0]), lift(c[2]), lift(c[3]), UP);
        continue;
      }
      carveCell(t, cellEdges(I0, J0), c, first, top, low, wall);
    }
  }

  /**
   * The road edge inside the terrain cell whose bottom-left fine point is (I0, J0): chains from
   * side to side, and closed loops.
   */
  function cellEdges(I0: number, J0: number): { chains: Chain[]; loops: P[][] } {
    const I1 = I0 + k;
    const J1 = J0 + k;
    const x0 = at(I0) * s;
    const y0 = at(J0) * s;
    const x1 = at(I1) * s;
    const y1 = at(J1) * s;
    const len = x1 - x0;
    interface Seg {
      from: number;
      to: number;
      a: P;
      b: P;
    }
    const segs: Seg[] = [];
    const bySide = new Map<number, number>(); // key of a crossing on the cell's outline → its u
    const starts = new Map<number, number>(); // crossing key → segment starting there
    for (let J = J0; J < J1; J++) {
      for (let I = I0; I < I1; I++) {
        const r = [road(I, J), road(I + 1, J), road(I + 1, J + 1), road(I, J + 1)];
        if (r[0] === r[1] && r[1] === r[2] && r[2] === r[3]) continue;
        // the fine cell's sides anticlockwise (bottom, right, top leftwards, left downwards) where the
        // road edge crosses them: [crossing key, point, road after it, where on the cell's outline or null]
        const sides: Array<[number, P, boolean, number | null]> = [];
        if (r[0] !== r[1]) {
          const p = crossing(I, J, false);
          sides.push([(J * nf + I) * 2, p, r[1], J === J0 ? (p.x - x0) / len : null]);
        }
        if (r[1] !== r[2]) {
          const p = crossing(I + 1, J, true);
          sides.push([(J * nf + I + 1) * 2 + 1, p, r[2], I + 1 === I1 ? 1 + (p.y - y0) / len : null]);
        }
        if (r[2] !== r[3]) {
          const p = crossing(I, J + 1, false);
          sides.push([((J + 1) * nf + I) * 2, p, r[3], J + 1 === J1 ? 2 + (x1 - p.x) / len : null]);
        }
        if (r[3] !== r[0]) {
          const p = crossing(I, J, true);
          sides.push([(J * nf + I) * 2 + 1, p, r[0], I === I0 ? 3 + (y1 - p.y) / len : null]);
        }
        // a segment runs from where the walk leaves the road to where it enters it: road on its left
        const pair = (x: number, e: number) => {
          const [fk, fp, , fu] = sides[x];
          const [tk, tp, , tu] = sides[e];
          if (fu !== null) bySide.set(fk, fu);
          if (tu !== null) bySide.set(tk, tu);
          starts.set(fk, segs.length);
          segs.push({ from: fk, to: tk, a: fp, b: tp });
        };
        const m = sides.length;
        if (m === 2) {
          pair(sides[0][2] ? 1 : 0, sides[0][2] ? 0 : 1);
        } else {
          // a saddle: road across the middle joins the two road corners, else they stay apart
          const centre = (field[J * nf + I] + field[J * nf + I + 1] + field[(J + 1) * nf + I + 1] + field[(J + 1) * nf + I]) / 4;
          for (let x = 0; x < 4; x++) {
            if (sides[x][2]) continue; // an exit: road before it, land after
            pair(x, centre < 0 ? (x + 1) % 4 : (x + 3) % 4);
          }
        }
      }
    }
    const used = new Uint8Array(segs.length);
    const chains: Chain[] = [];
    for (const [key, u0] of bySide) {
      const first = starts.get(key);
      if (first === undefined) continue; // an end
      const pts = [segs[first].a];
      let sg = first;
      for (;;) {
        used[sg] = 1;
        pts.push(segs[sg].b);
        const u1 = bySide.get(segs[sg].to);
        if (u1 !== undefined) {
          chains.push({ pts, u0, u1 });
          break;
        }
        const next = starts.get(segs[sg].to);
        if (next === undefined || used[next]) throw new Error('road edge broken off inside a cell');
        sg = next;
      }
    }
    const loops: P[][] = [];
    for (let s0 = 0; s0 < segs.length; s0++) {
      if (used[s0]) continue;
      const pts: P[] = [];
      let sg = s0;
      do {
        used[sg] = 1;
        pts.push(segs[sg].a);
        const next = starts.get(segs[sg].to);
        if (next === undefined || (used[next] && next !== s0)) throw new Error('road edge loop not closed');
        sg = next;
      } while (sg !== s0);
      const ring = dropStraight(pts);
      if (ring.length >= 3) loops.push(ring);
    }
    // Fewer points on straight runs. A bulge out and back through one side keeps its tip, or it
    // would lie flat along that side. If thinning makes two runs cross (a hair-thin spike of land
    // between two roads), the cell keeps the exact edge, which never crosses itself.
    const thin = chains.map((ch) => ({ ...ch, pts: Math.floor(ch.u0) === Math.floor(ch.u1) ? simplifyBulge(ch.pts, SIMPLIFY_MM) : simplify(ch.pts, SIMPLIFY_MM) }));
    return { chains: anyCrossing(thin, loops) ? chains : thin, loops };
  }

  // --- the sides and the bottom: round the square anticlockwise, through every grid point and crossing
  interface Rim {
    p: P;
    crossing: boolean;
    /** road from here to the next point */
    road: boolean;
  }
  const rim: Rim[] = [];
  const last = nf - 1;
  const gridPoint = (I: number, J: number) => rim.push({ p: corner(I / k, J / k), crossing: false, road: road(I, J) });
  for (let I = 0; I < last; I++) {
    if (I % k === 0) gridPoint(I, 0);
    if (road(I, 0) !== road(I + 1, 0)) rim.push({ p: crossing(I, 0, false), crossing: true, road: road(I + 1, 0) });
  }
  for (let J = 0; J < last; J++) {
    if (J % k === 0) gridPoint(last, J);
    if (road(last, J) !== road(last, J + 1)) rim.push({ p: crossing(last, J, true), crossing: true, road: road(last, J + 1) });
  }
  for (let I = last; I > 0; I--) {
    if (I % k === 0) gridPoint(I, last);
    if (road(I, last) !== road(I - 1, last)) rim.push({ p: crossing(I - 1, last, false), crossing: true, road: road(I - 1, last) });
  }
  for (let J = last; J > 0; J--) {
    if (J % k === 0) gridPoint(0, J);
    if (road(0, J) !== road(0, J - 1)) rim.push({ p: crossing(0, J - 1, true), crossing: true, road: road(0, J - 1) });
  }
  const foot = (p: P): V => [p.x, p.y, base];
  const centre: V = [0, 0, base];
  for (let m = 0; m < rim.length; m++) {
    const a = rim[m];
    const b = rim[(m + 1) % rim.length];
    const lift = a.road ? low : top;
    // at a crossing the land side's wall also reaches down to the road's floor, where the road's wall ends
    const left = a.crossing && !a.road ? [foot(a.p), low(a.p), top(a.p)] : [foot(a.p), lift(a.p)];
    const right = b.crossing && !a.road ? [foot(b.p), low(b.p), top(b.p)] : [foot(b.p), lift(b.p)];
    const out: V = [b.p.y - a.p.y, a.p.x - b.p.x, 0];
    for (let q = 0; q < left.length - 1; q++) t.add(left[q], right[0], left[q + 1], out);
    for (let q = 0; q < right.length - 1; q++) t.add(right[q], right[q + 1], left[left.length - 1], out);
    t.add(centre, foot(a.p), foot(b.p), DOWN);
  }
  return carved;
}

/**
 * One terrain cell the road edge runs through: road and land faces, triangulated, and the walls
 * along the edge. `c` are the cell's corners anticlockwise from the bottom left; `first` whether
 * the bottom-left corner is road (for a cell with only loops inside).
 */
function carveCell(
  t: Triangles,
  edges: { chains: Chain[]; loops: P[][] },
  c: P[],
  first: boolean,
  top: (p: P) => V,
  low: (p: P) => V,
  wall: (p: P, q: P) => void,
): void {
  const { chains, loops } = edges;
  const roadFaces: Face[] = [];
  const landFaces: Face[] = [];
  if (chains.length) {
    for (const ring of walk(chains, c)) roadFaces.push({ outer: ring, holes: [] });
    const back = chains.map((ch) => ({ pts: ch.pts.slice().reverse(), u0: ch.u1, u1: ch.u0 }));
    for (const ring of walk(back, c)) landFaces.push({ outer: ring, holes: [] });
  } else {
    (first ? roadFaces : landFaces).push({ outer: c.slice(), holes: [] });
  }
  // loops: road islands (anticlockwise) and land islands (clockwise), each a hole in what's around it
  const islands: Array<{ ring: P[]; road: boolean }> = loops.map((ring) => (area(ring) > 0 ? { ring, road: true } : { ring: ring.slice().reverse(), road: false }));
  for (const isl of islands) (isl.road ? roadFaces : landFaces).push({ outer: isl.ring, holes: [] });
  for (const isl of islands) {
    const around = isl.road ? landFaces : roadFaces;
    let best: Face | null = null;
    for (const f of around) if (f.outer !== isl.ring && inside(isl.ring[0], f.outer) && (!best || Math.abs(area(f.outer)) < Math.abs(area(best.outer)))) best = f;
    if (!best) throw new Error('road island outside its cell');
    best.holes.push(isl.ring);
  }
  for (const f of roadFaces) fill(t, f, low);
  for (const f of landFaces) fill(t, f, top);
  for (const ch of chains) for (let q = 0; q < ch.pts.length - 1; q++) wall(ch.pts[q], ch.pts[q + 1]);
  for (const isl of loops) for (let q = 0; q < isl.length; q++) wall(isl[q], isl[(q + 1) % isl.length]);
}

interface Face {
  outer: P[];
  holes: P[][];
}

/**
 * Faces left of the chains: follow a chain to the cell's outline, go round the outline
 * anticlockwise (through any corners) to the next chain's start, and so on until back.
 */
function walk(chains: Chain[], corners: P[]): P[][] {
  const ends = chains.flatMap((ch, ci) => [{ u: ch.u0, ci, start: true }, { u: ch.u1, ci, start: false }]).sort((a, b) => a.u - b.u);
  const done = new Uint8Array(chains.length);
  const rings: P[][] = [];
  for (let c0 = 0; c0 < chains.length; c0++) {
    if (done[c0]) continue;
    const ring: P[] = [];
    let ci = c0;
    for (let guard = 0; ; guard++) {
      if (guard > chains.length) throw new Error('road faces do not close');
      done[ci] = 1;
      ring.push(...chains[ci].pts);
      const u = chains[ci].u1;
      const next = ends.find((e) => e.u > u) ?? ends[0];
      if (!next.start) throw new Error('road edges out of order');
      // the corners passed on the way: 1 bottom right, 2 top right, 3 top left, 4 (0) bottom left
      const v = next.u > u ? next.u : next.u + 4;
      for (let q = Math.floor(u) + 1; q < v; q++) ring.push(corners[q % 4]);
      ci = next.ci;
      if (ci === c0) break;
    }
    rings.push(ring);
  }
  return rings;
}

/** Triangulate a face and add it at the given height. */
function fill(t: Triangles, f: Face, lift: (p: P) => V): void {
  const pts: P[] = [];
  const flat: number[] = [];
  const holes: number[] = [];
  for (const ring of [f.outer, ...f.holes]) {
    if (pts.length) holes.push(pts.length);
    for (const p of ring) {
      pts.push(p);
      flat.push(p.x, p.y);
    }
  }
  const tris = earcut(flat, holes.length ? holes : undefined, 2);
  const used = new Uint8Array(pts.length);
  for (const q of tris) used[q] = 1;
  // every point must be in the triangles, or a wall would end at a gap
  if (!tris.length || !used.every((u) => u === 1) || deviation(flat, holes.length ? holes : null, 2, tris) > 1e-6) {
    throw new Error('a road face could not be triangulated');
  }
  // Where two straight road edges line up across a face, earcut joins them with slivers of next
  // to no area. They must stay (a dropped one leaves a gap), so add the triangles as they come,
  // all turned to face up together: earcut winds them all the same way.
  let sum = 0;
  for (let q = 0; q < tris.length; q += 3) {
    const [a, b, c] = [pts[tris[q]], pts[tris[q + 1]], pts[tris[q + 2]]];
    sum += (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }
  for (let q = 0; q < tris.length; q += 3) {
    const a = lift(pts[tris[q]]);
    const b = lift(pts[tris[q + 1]]);
    const c = lift(pts[tris[q + 2]]);
    if (sum > 0) t.push(a, b, c);
    else t.push(a, c, b);
  }
}

/** Twice the signed area (anticlockwise positive). */
function area(r: P[]): number {
  let a = 0;
  for (let q = 0; q < r.length; q++) {
    const p = r[q];
    const o = r[(q + 1) % r.length];
    a += p.x * o.y - o.x * p.y;
  }
  return a;
}

function inside(p: P, ring: P[]): boolean {
  let hit = false;
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    const A = ring[a];
    const B = ring[b];
    if (A.y > p.y !== B.y > p.y && p.x < ((B.x - A.x) * (p.y - A.y)) / (B.y - A.y) + A.x) hit = !hit;
  }
  return hit;
}

/** Douglas–Peucker, keeping both ends: drops points within `tol` (mm) of the line through their neighbours. */
export function simplify(pts: P[], tol: number): P[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = pts[a];
    const B = pts[b];
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const l2 = dx * dx + dy * dy;
    let worst = -1;
    let wd = tol;
    for (let m = a + 1; m < b; m++) {
      const p = pts[m];
      // distance to the segment, so a chain that doubles back keeps its turn
      const u = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - A.x) * dx + (p.y - A.y) * dy) / l2)) : 0;
      const d = Math.hypot(p.x - A.x - u * dx, p.y - A.y - u * dy);
      if (d > wd) {
        wd = d;
        worst = m;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, m) => keep[m] === 1);
}

/** Whether any two pieces of the chains and loops cross or touch (other than neighbours in one run). */
function anyCrossing(chains: Chain[], loops: P[][]): boolean {
  const segs: Array<[P, P]> = [];
  for (const ch of chains) for (let q = 0; q < ch.pts.length - 1; q++) segs.push([ch.pts[q], ch.pts[q + 1]]);
  for (const r of loops) for (let q = 0; q < r.length; q++) segs.push([r[q], r[(q + 1) % r.length]]);
  const side = (a: P, b: P, c: P) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  for (let a = 0; a < segs.length; a++) {
    const [p, q] = segs[a];
    for (let b = a + 1; b < segs.length; b++) {
      const [r, t] = segs[b];
      if (q === r || t === p || p === r || q === t) continue; // neighbours share a point
      if (Math.max(r.x, t.x) < Math.min(p.x, q.x) || Math.min(r.x, t.x) > Math.max(p.x, q.x)) continue;
      if (Math.max(r.y, t.y) < Math.min(p.y, q.y) || Math.min(r.y, t.y) > Math.max(p.y, q.y)) continue;
      const d1 = side(p, q, r);
      const d2 = side(p, q, t);
      const d3 = side(r, t, p);
      const d4 = side(r, t, q);
      if (d1 !== d2 && d3 !== d4) return true;
      if (d1 === 0 && d2 === 0) return true; // on one line, boxes overlapping
    }
  }
  return false;
}

/** Like `simplify`, always keeping the point farthest from the line between the ends. */
function simplifyBulge(pts: P[], tol: number): P[] {
  const a = pts[0];
  const b = pts[pts.length - 1];
  let far = 1;
  let fd = -1;
  for (let m = 1; m < pts.length - 1; m++) {
    const d = Math.abs((pts[m].x - a.x) * (b.y - a.y) - (pts[m].y - a.y) * (b.x - a.x));
    if (d > fd) {
      fd = d;
      far = m;
    }
  }
  return [...simplify(pts.slice(0, far + 1), tol).slice(0, -1), ...simplify(pts.slice(far), tol)];
}

/** A closed ring without points exactly on the line between their neighbours. */
function dropStraight(ring: P[]): P[] {
  const r = ring.slice();
  for (let q = 0; q < r.length && r.length > 3; ) {
    const a = r[(q + r.length - 1) % r.length];
    const b = r[q];
    const c = r[(q + 1) % r.length];
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) === 0) r.splice(q, 1);
    else q++;
  }
  return r;
}
