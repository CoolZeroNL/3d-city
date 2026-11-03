/**
 * 3D-print export: the model as a binary STL in millimetres, z up.
 *
 * The print is a set of closed shells that slicers union:
 *  - the terrain block: the height grid as the top, four side walls down to a
 *    flat base, and a bottom — one watertight shell;
 *  - one prism per building, from inside the block up to its roof.
 * A building column that starts below the terrain surface is buried in the
 * block, so the union is exactly "building above ground" — no gaps on slopes.
 * Every shell is closed with outward-facing triangles, so slicers (PrusaSlicer,
 * Bambu Studio, OrcaSlicer, Cura) need no repairs.
 */

import earcut from 'earcut';
import { signedArea, type Polygon } from '../geo/polygon';
import type { HeightGrid } from '../geo/terrain';

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
}

export const PRINT_SIZES_MM = [100, 150, 200] as const;
export const PRINT_BASE_MM = 3;

type V = [number, number, number];

/** Triangles as a flat, growable list of xyz × 3. */
export class Triangles {
  data = new Float32Array(9 * 4096);
  count = 0;

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

/** Build the print as triangles (mm). */
export function buildPrint(grid: HeightGrid, buildings: PrintBuilding[], opts: PrintOptions): Triangles {
  const t = new Triangles();
  const s = opts.sideMm / grid.sizeM; // mm per metre
  const base = -opts.baseMm;
  addTerrainBlock(t, grid, opts.exaggeration, s, base);
  // building columns start halfway into the base: always inside the block
  const bottom = base / 2;
  for (const b of buildings) addPrism(t, b.poly, b.top * s, bottom, s);
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
 */
export function cleanRing(ring: Array<[number, number]>): Array<[number, number]> {
  const r = ring.slice();
  let changed = true;
  while (changed && r.length >= 3) {
    changed = false;
    for (let k = 0; k < r.length && r.length >= 3; k++) {
      const p = r[(k - 1 + r.length) % r.length];
      const q = r[k];
      const n = r[(k + 1) % r.length];
      const same = q[0] === n[0] && q[1] === n[1];
      const straight = (q[1] - p[1]) * (n[0] - q[0]) - (q[0] - p[0]) * (n[1] - q[1]) === 0;
      if (same || straight) {
        r.splice(k, 1);
        changed = true;
        k--;
      }
    }
  }
  return r;
}

/** A closed prism: walls, roof and floor. */
function addPrism(t: Triangles, poly: Polygon, topZ: number, bottomZ: number, s: number): void {
  if (topZ <= bottomZ) return;
  const scaled = (ring: Polygon['outer']) => cleanRing(ring.map(([e, nn]) => [e * s, nn * s] as [number, number]));
  const outer = scaled(poly.outer);
  if (outer.length < 3) return;
  const rings = [outer, ...poly.holes.map(scaled).filter((r) => r.length >= 3)];
  const flat: number[] = [];
  const holeIdx: number[] = [];
  for (const ring of rings) {
    if (flat.length) holeIdx.push(flat.length / 2);
    for (const [x, y] of ring) flat.push(x, y);
  }
  const at = (k: number, z: number): V => [flat[k * 2], flat[k * 2 + 1], z];

  let k0 = 0;
  rings.forEach((ring, r) => {
    const m = ring.length;
    // the solid is left of each edge for an anticlockwise outer ring and clockwise holes;
    // don't trust the data's orientation, check it
    const ccw = signedArea(ring) > 0;
    const side = (r === 0) === ccw ? 1 : -1;
    for (let k = 0; k < m; k++) {
      const a = k0 + k;
      const b = k0 + ((k + 1) % m);
      const de = flat[b * 2] - flat[a * 2];
      const dn = flat[b * 2 + 1] - flat[a * 2 + 1];
      // solid on the left of the edge → outward normal on the right
      const out: V = [dn * side, -de * side, 0];
      t.add(at(a, bottomZ), at(b, bottomZ), at(b, topZ), out);
      t.add(at(a, bottomZ), at(b, topZ), at(a, topZ), out);
    }
    k0 += m;
  });
  const tris = earcut(flat, holeIdx.length ? holeIdx : undefined, 2);
  for (let k = 0; k < tris.length; k += 3) {
    const [p, q, r] = [tris[k], tris[k + 1], tris[k + 2]];
    t.add(at(p, topZ), at(q, topZ), at(r, topZ), UP);
    t.add(at(p, bottomZ), at(q, bottomZ), at(r, bottomZ), DOWN);
  }
}

/** Binary STL: 80-byte header, triangle count, then normal + 3 vertices + 2 spare bytes per triangle. */
export function toBinaryStl(t: Triangles, header: string): ArrayBuffer {
  const buf = new ArrayBuffer(84 + 50 * t.count);
  const dv = new DataView(buf);
  // ASCII only, and never starting with "solid" (that marks text STL to some readers)
  const text = `Your Place: ${header}`.replace(/[^\x20-\x7e]/g, '?').slice(0, 80);
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
