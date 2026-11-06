/**
 * 3D-print export: the model as a binary STL in millimetres, z up.
 *
 * The print is a set of closed shells that slicers union:
 *  - the terrain block: the height grid as the top, four side walls down to a
 *    flat base, and a bottom — one watertight shell;
 *  - one prism per building, from inside the block up to its roof;
 *  - optionally raised roads: short pieces whose tops follow the terrain (roads.ts).
 * A building column that starts below the terrain surface is buried in the
 * block, so the union is exactly "building above ground" — no gaps on slopes.
 * Every shell is closed with outward-facing triangles, so slicers (PrusaSlicer,
 * Bambu Studio, OrcaSlicer, Cura) need no repairs.
 */

import earcut, { deviation } from 'earcut';
import polygonClipping from 'polygon-clipping';
import { signedArea, type Polygon } from '../geo/polygon';
import type { HeightGrid } from '../geo/terrain';
import { addRoads, type PrintRoad } from './roads';

/** A building for print: footprint (m from the centre) and roof height (m above the lowest terrain point, exaggeration applied). */
export interface PrintBuilding {
  poly: Polygon;
  top: number;
}

export interface PrintOptions {
  /** width of the square print (mm) */
  sideMm: number;
  /** solid base under the lowest terrain point (mm) */
  baseMm: number;
  /** vertical exaggeration of the terrain, as on screen */
  exaggeration: number;
  /**
   * Keep buildings from touching (mm). Terraced houses share walls and building parts
   * share floors; exactly coincident faces of separate shells make slicers "repair" the
   * file. A hundredth of a millimetre (varied a little per building) separates them;
   * slicers close gaps that small, so the print is unchanged.
   */
  shellGapMm?: number;
}

export const PRINT_SHELL_GAP_MM = 0.01;

export const PRINT_SIZES_MM = [100, 150, 200] as const;
export const PRINT_BASE_MM = 3;

type V = [number, number, number];

/** Triangles as a flat, growable list of xyz × 3. */
export class Triangles {
  data = new Float32Array(9 * 4096);
  count = 0;
  /** buildings left out because their outline could not be made valid */
  skipped = 0;

  /** Add a triangle, flipped if needed so its normal points along `out`. */
  add(a: V, b: V, c: V, out: V): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz < 1e-18) return; // zero area
    if (nx * out[0] + ny * out[1] + nz * out[2] < 0) [b, c] = [c, b];
    if ((this.count + 1) * 9 > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data.set(a, this.count * 9);
    this.data.set(b, this.count * 9 + 3);
    this.data.set(c, this.count * 9 + 6);
    this.count++;
  }
}

const UP: V = [0, 0, 1];
const DOWN: V = [0, 0, -1];

/** Build the print as triangles (mm), with raised roads if any are given. */
export function buildPrint(grid: HeightGrid, buildings: PrintBuilding[], opts: PrintOptions, roads: PrintRoad[] = []): Triangles {
  const t = new Triangles();
  const s = opts.sideMm / grid.sizeM; // mm per metre
  const base = -opts.baseMm;
  addTerrainBlock(t, grid, opts.exaggeration, s, base);
  // building columns start halfway into the base: always inside the block
  const bottom = base / 2;
  const gap = opts.shellGapMm ?? PRINT_SHELL_GAP_MM;
  buildings.forEach((b, i) => {
    // vary inset and floor depth per building, so no two shells share a point even when
    // their outlines are identical (an outline and its building part)
    addPrism(t, b.poly, b.top * s, bottom - gap * 0.3 * (i % 97), s, gap * (1 + 0.4 * (i % 5)));
  });
  if (roads.length) addRoads(t, grid, roads, { s, exaggeration: opts.exaggeration });
  return t;
}

function addTerrainBlock(t: Triangles, grid: HeightGrid, ex: number, s: number, base: number): void {
  const { n, sizeM, elev, min } = grid;
  const h = sizeM / 2;
  const step = sizeM / (n - 1);
  // one formula per grid point, so shared edges get bit-identical vertices
  const top = (i: number, j: number): V => [(-h + i * step) * s, (-h + j * step) * s, (elev[j * n + i] - min) * ex * s];
  const foot = (i: number, j: number): V => [(-h + i * step) * s, (-h + j * step) * s, base];

  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = top(i, j);
      const b = top(i + 1, j);
      const c = top(i, j + 1);
      const d = top(i + 1, j + 1);
      t.add(a, b, d, UP);
      t.add(a, d, c, UP);
    }
  }

  // the perimeter, anticlockwise from the south-west corner (j = 0 is the south edge)
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < n - 1; i++) ring.push([i, 0]);
  for (let j = 0; j < n - 1; j++) ring.push([n - 1, j]);
  for (let i = n - 1; i > 0; i--) ring.push([i, n - 1]);
  for (let j = n - 1; j > 0; j--) ring.push([0, j]);
  const centre: V = [0, 0, base];
  for (let k = 0; k < ring.length; k++) {
    const [i0, j0] = ring[k];
    const [i1, j1] = ring[(k + 1) % ring.length];
    // outward: the side this edge is on
    const out: V = j0 === 0 && j1 === 0 ? [0, -1, 0] : i0 === n - 1 && i1 === n - 1 ? [1, 0, 0] : j0 === n - 1 && j1 === n - 1 ? [0, 1, 0] : [-1, 0, 0];
    const a0 = foot(i0, j0);
    const b0 = foot(i1, j1);
    const a1 = top(i0, j0);
    const b1 = top(i1, j1);
    t.add(a0, b0, b1, out);
    t.add(a0, b1, a1, out);
    // the bottom: a fan to the centre, through every perimeter point (no T-junctions)
    t.add(centre, a0, b0, DOWN);
  }
}

/**
 * Drop repeated points and points on a straight wall (common where a neighbour's
 * corner attaches). The roof triangulation skips such points, so walls keeping
 * them would leave hairline gaps along the roof edge. Same exact test as earcut's.
 * Also drops hairline spikes (an edge that folds back on itself within ~1°), which
 * would become back-to-back slivers of wall.
 */
export function cleanRing(ring: Array<[number, number]>, minEdge = 0.005): Array<[number, number]> {
  const r = ring.slice();
  let changed = true;
  while (changed && r.length >= 3) {
    changed = false;
    for (let k = 0; k < r.length && r.length >= 3; k++) {
      const p = r[(k - 1 + r.length) % r.length];
      const q = r[k];
      const n = r[(k + 1) % r.length];
      // repeated, or closer than `minEdge` (mm) — such points also make spike angles noisy
      const same = (q[0] === n[0] && q[1] === n[1]) || Math.hypot(n[0] - q[0], n[1] - q[1]) < minEdge;
      const cross = (q[1] - p[1]) * (n[0] - q[0]) - (q[0] - p[0]) * (n[1] - q[1]);
      const straight = cross === 0;
      const dot = (q[0] - p[0]) * (n[0] - q[0]) + (q[1] - p[1]) * (n[1] - q[1]);
      const spike = dot < 0 && Math.abs(cross) < 0.017 * Math.hypot(q[0] - p[0], q[1] - p[1]) * Math.hypot(n[0] - q[0], n[1] - q[1]);
      if (same || straight || spike) {
        r.splice(k, 1);
        changed = true;
        k--;
      }
    }
  }
  return r;
}

type P2 = [number, number];

/**
 * Move a ring's points by d (mm) into the solid, which lies left of each edge
 * (mitred corners, capped at sharp spikes).
 */
export function insetRing(r: P2[], d: number): P2[] {
  if (d === 0) return r;
  const m = r.length;
  return r.map((q, k) => {
    const p = r[(k - 1 + m) % m];
    const n = r[(k + 1) % m];
    const la = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const lb = Math.hypot(n[0] - q[0], n[1] - q[1]) || 1;
    // left normals of the two edges meeting at q
    const n1x = -(q[1] - p[1]) / la;
    const n1y = (q[0] - p[0]) / la;
    const n2x = -(n[1] - q[1]) / lb;
    const n2y = (n[0] - q[0]) / lb;
    const mx = n1x + n2x;
    const my = n1y + n2y;
    const m2 = mx * mx + my * my;
    if (m2 < 1e-12) return q; // the outline doubles back on itself here
    const f = Math.min((2 * d) / m2, 4 * d); // miter length d / cos(angle / 2), capped
    return [q[0] + mx * f, q[1] + my * f] as P2;
  });
}

/** A footprint in mm with the solid left of every edge: outer anticlockwise, holes clockwise. */
interface Footprint {
  outer: P2[];
  holes: P2[][];
}

/**
 * A building outline as valid footprints in mm: scaled and cleaned; repaired if it
 * crosses itself; oriented (checked, not trusted); then moved slightly into the solid.
 */
function footprints(poly: Polygon, s: number, inset: number): Footprint[] {
  const scale = (ring: Polygon['outer']) => cleanRing(ring.map(([e, nn]) => [e * s, nn * s] as P2));
  const outer = scale(poly.outer);
  if (outer.length < 3) return [];
  const holes = poly.holes.map(scale).filter((h) => h.length >= 3);
  const raw = { outer, holes };
  const valid = validFootprint(raw) ? [orient(raw)] : repair(raw);
  return valid.map((fp) => insetFootprint(fp, inset)).filter((fp): fp is Footprint => !!fp);
}

function orient(fp: Footprint): Footprint {
  const outer = signedArea(fp.outer) > 0 ? fp.outer : fp.outer.slice().reverse();
  return { outer, holes: fp.holes.map((h) => (signedArea(h) < 0 ? h : h.slice().reverse())) };
}

function insetFootprint(fp: Footprint, d: number): Footprint | null {
  const shrink = (r: P2[], sign: number): P2[] | null => {
    const out = cleanRing(insetRing(r, d));
    // too small to survive the inset (it turned inside out): drop it
    return out.length >= 3 && Math.sign(signedArea(out)) === sign ? out : null;
  };
  const outer = shrink(fp.outer, 1);
  if (!outer) return null;
  return { outer, holes: fp.holes.map((h) => shrink(h, -1)).filter((h): h is P2[] => !!h) };
}

/** Roof triangles if the footprint is valid (simple rings, fully triangulated), else null. */
function triangulate(fp: Footprint, attempt = 0): { fp: Footprint; flat: number[]; tris: number[] } | null {
  const rings = [fp.outer, ...fp.holes];
  if (!validFootprint(fp)) return null;
  const flat: number[] = [];
  const holeIdx: number[] = [];
  for (const ring of rings) {
    if (flat.length) holeIdx.push(flat.length / 2);
    for (const [x, y] of ring) flat.push(x, y);
  }
  const holes = holeIdx.length ? holeIdx : undefined;
  const tris = earcut(flat, holes, 2);
  // earcut gives up quietly on broken input: check that the triangles cover the area
  if (!tris.length || deviation(flat, holes ?? null, 2, tris) > 1e-6) return null;
  // Joining a courtyard to the outer ring can line points up, and earcut then skips
  // them; walls keeping a skipped point would leave a hairline gap. Retry without them.
  const used = new Uint8Array(flat.length / 2);
  for (const i of tris) used[i] = 1;
  if (used.every((u) => u === 1)) return roofFitsWalls(rings, tris) ? { fp, flat, tris } : null;
  if (attempt >= 3) return null;
  let k = 0;
  const keep = (r: P2[]) => r.filter(() => used[k++] === 1);
  const outer = keep(fp.outer);
  const next = { outer, holes: fp.holes.map(keep).filter((h) => h.length >= 3) };
  return outer.length >= 3 ? triangulate(next, attempt + 1) : null;
}

const orient2 = (a: P2, b: P2, c: P2) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));

/** Segments a–b and c–d cross, touch, or overlap on one line. */
function segmentsMeet(a: P2, b: P2, c: P2, d: P2): boolean {
  if (Math.max(c[0], d[0]) < Math.min(a[0], b[0]) || Math.min(c[0], d[0]) > Math.max(a[0], b[0])) return false;
  if (Math.max(c[1], d[1]) < Math.min(a[1], b[1]) || Math.min(c[1], d[1]) > Math.max(a[1], b[1])) return false;
  const o1 = orient2(a, b, c);
  const o2 = orient2(a, b, d);
  const o3 = orient2(c, d, a);
  const o4 = orient2(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true; // crossing, or touching at an end
  return o1 === 0 && o2 === 0; // on one line, with overlapping bounding boxes
}

/**
 * The roof's boundary is exactly the walls' top edges: every ring edge belongs to one
 * triangle, every other triangle edge to two. (On degenerate input earcut can return
 * overlapping triangles whose total area still looks right.)
 */
function roofFitsWalls(rings: P2[][], tris: number[]): boolean {
  const count = new Map<number, number>();
  const n = rings.reduce((a, r) => a + r.length, 0);
  const key = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  for (let k = 0; k < tris.length; k += 3) {
    for (const [a, b] of [[tris[k], tris[k + 1]], [tris[k + 1], tris[k + 2]], [tris[k + 2], tris[k]]]) {
      const e = key(a, b);
      count.set(e, (count.get(e) ?? 0) + 1);
    }
  }
  let ringEdges = 0;
  let k0 = 0;
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      if (count.get(key(k0 + i, k0 + ((i + 1) % r.length))) !== 1) return false;
      ringEdges++;
    }
    k0 += r.length;
  }
  let single = 0;
  for (const c of count.values()) {
    if (c === 1) single++;
    else if (c !== 2) return false;
  }
  return single === ringEdges;
}

/** No two non-neighbouring edges of the ring touch or cross. */
export function isSimple(r: P2[]): boolean {
  const m = r.length;
  for (let i = 0; i < m; i++) {
    for (let j = i + 2; j < m; j++) {
      if (i === 0 && j === m - 1) continue; // the edge closing the ring meets the first edge
      if (segmentsMeet(r[i], r[(i + 1) % m], r[j], r[(j + 1) % m])) return false;
    }
  }
  return true;
}

/** Simple rings that keep apart from each other (a courtyard must not touch the outer wall). */
export function validFootprint(fp: { outer: P2[]; holes: P2[][] }): boolean {
  const rings = [fp.outer, ...fp.holes];
  if (!rings.every(isSimple)) return false;
  const box = rings.map((r) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of r) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    return [x0, y0, x1, y1];
  });
  for (let a = 0; a < rings.length; a++) {
    for (let b = a + 1; b < rings.length; b++) {
      const [ax0, ay0, ax1, ay1] = box[a];
      const [bx0, by0, bx1, by1] = box[b];
      if (bx0 > ax1 || bx1 < ax0 || by0 > ay1 || by1 < ay0) continue;
      const ra = rings[a];
      const rb = rings[b];
      for (let i = 0; i < ra.length; i++)
        for (let j = 0; j < rb.length; j++)
          if (segmentsMeet(ra[i], ra[(i + 1) % ra.length], rb[j], rb[(j + 1) % rb.length])) return false;
    }
  }
  return true;
}

/** Make a self-intersecting footprint valid: its union with itself, as simple polygons. */
function repair(fp: Footprint): Footprint[] {
  try {
    const out = polygonClipping.union([[...fp.outer, fp.outer[0]], ...fp.holes.map((h) => [...h, h[0]])]);
    return out
      .map(([outer, ...holes]) => {
        const o = cleanRing(outer.slice(0, -1) as P2[]);
        if (signedArea(o) < 0) o.reverse();
        const hs = holes.map((h) => cleanRing(h.slice(0, -1) as P2[])).filter((h) => h.length >= 3);
        for (const h of hs) if (signedArea(h) > 0) h.reverse();
        return { outer: o, holes: hs };
      })
      .filter((f) => f.outer.length >= 3);
  } catch {
    return [];
  }
}

/**
 * A closed solid from an outline already in millimetres (the raised title and its ledge), built
 * like the buildings: cleaned, repaired if needed, checked, and counted in `skipped` if hopeless.
 */
export function addSolid(t: Triangles, poly: Polygon, topZ: number, bottomZ: number, inset = PRINT_SHELL_GAP_MM): void {
  addPrism(t, poly, topZ, bottomZ, 1, inset);
}

/** A closed prism: walls, roof and floor. `inset` (mm) keeps it from touching its neighbours. */
function addPrism(t: Triangles, poly: Polygon, topZ: number, bottomZ: number, s: number, inset: number): void {
  if (topZ <= bottomZ) return;
  for (const fp of footprints(poly, s, inset)) {
    const done = triangulate(fp);
    if (done) {
      emitPrism(t, done.fp, done.flat, done.tris, topZ, bottomZ);
      continue;
    }
    // the inset closed a narrow notch, or earcut gave up: repair once more, else leave it out
    let emitted = false;
    for (const fixed of repair(fp)) {
      const ok = triangulate(fixed);
      if (!ok) continue;
      emitPrism(t, ok.fp, ok.flat, ok.tris, topZ, bottomZ);
      emitted = true;
    }
    if (!emitted) t.skipped++;
  }
}

function emitPrism(t: Triangles, fp: Footprint, flat: number[], tris: number[], topZ: number, bottomZ: number): void {
  const at = (k: number, z: number): V => [flat[k * 2], flat[k * 2 + 1], z];
  let k0 = 0;
  for (const ring of [fp.outer, ...fp.holes]) {
    const m = ring.length;
    for (let k = 0; k < m; k++) {
      const a = k0 + k;
      const b = k0 + ((k + 1) % m);
      const de = flat[b * 2] - flat[a * 2];
      const dn = flat[b * 2 + 1] - flat[a * 2 + 1];
      // solid on the left of the edge → outward normal on the right
      const out: V = [dn, -de, 0];
      t.add(at(a, bottomZ), at(b, bottomZ), at(b, topZ), out);
      t.add(at(a, bottomZ), at(b, topZ), at(a, topZ), out);
    }
    k0 += m;
  }
  for (let k = 0; k < tris.length; k += 3) {
    const [p, q, r] = [tris[k], tris[k + 1], tris[k + 2]];
    t.add(at(p, topZ), at(q, topZ), at(r, topZ), UP);
    t.add(at(p, bottomZ), at(q, bottomZ), at(r, bottomZ), DOWN);
  }
}

export const STL_CREDIT = ' | (c) OpenStreetMap contributors';

/** Binary STL: 80-byte header, triangle count, then normal + 3 vertices + 2 spare bytes per triangle. */
export function toBinaryStl(t: Triangles, header: string): ArrayBuffer {
  const buf = new ArrayBuffer(84 + 50 * t.count);
  const dv = new DataView(buf);
  // ASCII only, and never starting with "solid" (that marks text STL to some readers).
  // The map data credit (ODbL) goes last and is never cut off.
  const text = `Your Place: ${header}`.replace(/[^\x20-\x7e]/g, '?').slice(0, 80 - STL_CREDIT.length) + STL_CREDIT;
  for (let i = 0; i < text.length; i++) dv.setUint8(i, text.charCodeAt(i));
  dv.setUint32(80, t.count, true);
  const d = t.data;
  let o = 84;
  for (let k = 0; k < t.count; k++) {
    const p = k * 9;
    const ux = d[p + 3] - d[p];
    const uy = d[p + 4] - d[p + 1];
    const uz = d[p + 5] - d[p + 2];
    const vx = d[p + 6] - d[p];
    const vy = d[p + 7] - d[p + 1];
    const vz = d[p + 8] - d[p + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    dv.setFloat32(o, nx, true);
    dv.setFloat32(o + 4, ny, true);
    dv.setFloat32(o + 8, nz, true);
    for (let q = 0; q < 9; q++) dv.setFloat32(o + 12 + q * 4, d[p + q], true);
    dv.setUint16(o + 48, 0, true);
    o += 50;
  }
  return buf;
}

/** "1:13,300" for a print of `sideMm` covering `sizeM`. */
export function printScale(sizeM: number, sideMm: number): string {
  const ratio = (sizeM * 1000) / sideMm;
  return `1:${new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 }).format(ratio)}`;
}
