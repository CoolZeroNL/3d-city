/**
 * Extruded buildings, merged into one mesh per tile to keep draw calls low (spec).
 * Each building stands on the terrain height at its lowest footprint corner.
 *
 * Vertical exaggeration applies to the terrain only: a vertex's scene y is
 *   y = (groundElevation - referenceElevation) * exaggeration + heightAboveGround
 * so we keep both terms per vertex and re-evaluate y when the slider moves
 * (or when the reference changes because the sea was flattened).
 */

import earcut from 'earcut';
import { BufferAttribute, BufferGeometry, Color } from 'three';
import { pointInRing, ringBounds, type Polygon, type Pt } from '../geo/polygon';

export interface BuildingSpec {
  poly: Polygon;
  height: number;
  minHeight: number;
  estimated: boolean;
  /** false where the height is a fallback; roof bumps in the elevation data can then tell it */
  heightKnown?: boolean;
}

export interface BuildingsBuild {
  geometry: BufferGeometry;
  /** per vertex: ground elevation of its building (m above sea level) */
  ground: Float32Array;
  /** per vertex: height above the building's ground (m); also the `aHag` attribute */
  hag: Float32Array;
  /** per vertex: total height of the building it belongs to (m), for the colour ramp */
  buildingHeight: Float32Array;
  /** per building: ground elevation (m above sea level) */
  buildingGround: Float32Array;
  /** per building: first vertex; starts[count] is the vertex count (buildings own contiguous ranges) */
  starts: Uint32Array;
  /** per building: footprint bounds e0, n0, e1, n1 */
  bounds: Float32Array;
  count: number;
  estimatedCount: number;
  maxHeight: number;
}

export function buildBuildings(specs: BuildingSpec[], groundElevation: (poly: Polygon) => number, refElev: number, ex: number): BuildingsBuild {
  // pass 1: triangulate roofs and count
  const tris: number[][] = [];
  let vCount = 0;
  let iCount = 0;
  for (const s of specs) {
    const rings = [s.poly.outer, ...s.poly.holes];
    const flat: number[] = [];
    const holeIdx: number[] = [];
    let r = 0;
    for (const ring of rings) {
      if (flat.length) holeIdx.push(flat.length / 2);
      for (const [x, y] of ring) flat.push(x, y);
      r += ring.length;
    }
    const t = earcut(flat, holeIdx.length ? holeIdx : undefined, 2);
    tris.push(t);
    const under = s.minHeight > 0.5;
    vCount += r * 4 + r * (under ? 2 : 1);
    iCount += r * 6 + t.length * (under ? 2 : 1);
  }

  const pos = new Float32Array(vCount * 3);
  const nrm = new Float32Array(vCount * 3);
  const ground = new Float32Array(vCount);
  const hag = new Float32Array(vCount);
  const bh = new Float32Array(vCount);
  const buildingGround = new Float32Array(specs.length);
  const starts = new Uint32Array(specs.length + 1);
  const bounds = new Float32Array(specs.length * 4);
  const index = new Uint32Array(iCount);
  let v = 0;
  let ii = 0;
  let maxHeight = 0;
  let estimatedCount = 0;

  const put = (e: number, n: number, g: number, h: number, height: number, nx: number, ny: number, nz: number) => {
    pos[v * 3] = e;
    pos[v * 3 + 1] = (g - refElev) * ex + h;
    pos[v * 3 + 2] = -n;
    nrm[v * 3] = nx;
    nrm[v * 3 + 1] = ny;
    nrm[v * 3 + 2] = nz;
    ground[v] = g;
    hag[v] = h;
    bh[v] = height;
    return v++;
  };

  specs.forEach((s, bi) => {
    const g = groundElevation(s.poly);
    buildingGround[bi] = g;
    starts[bi] = v;
    bounds.set(ringBounds(s.poly.outer), bi * 4);
    const top = s.height;
    const bottom = s.minHeight > 0.5 ? s.minHeight : -1.5; // sink slightly so no seam shows on flat ground
    maxHeight = Math.max(maxHeight, top);
    if (s.estimated) estimatedCount++;
    const rings = [s.poly.outer, ...s.poly.holes];

    // walls (outer CCW, holes CW → interior on the left, outward normal on the right)
    for (const ring of rings) {
      const n = ring.length;
      for (let k = 0; k < n; k++) {
        const [ae, an] = ring[k];
        const [be, bn] = ring[(k + 1) % n];
        const de = be - ae;
        const dn = bn - an;
        const len = Math.hypot(de, dn) || 1;
        const nx = dn / len;
        const nz = de / len;
        const a0 = put(ae, an, g, bottom, top, nx, 0, nz);
        const b0 = put(be, bn, g, bottom, top, nx, 0, nz);
        const b1 = put(be, bn, g, top, top, nx, 0, nz);
        const a1 = put(ae, an, g, top, top, nx, 0, nz);
        index[ii++] = a0; index[ii++] = b0; index[ii++] = b1;
        index[ii++] = a0; index[ii++] = b1; index[ii++] = a1;
      }
    }

    // roof (and underside for raised parts such as overhangs and bridges)
    const flatPts = rings.flat();
    const t = tris[bi];
    const roofStart = v;
    for (const [e, n] of flatPts) put(e, n, g, top, top, 0, 1, 0);
    for (let k = 0; k < t.length; k += 3) {
      const [p, q, r] = [t[k], t[k + 1], t[k + 2]];
      const ccw = cross2(flatPts[p], flatPts[q], flatPts[r]) > 0;
      if (ccw) {
        index[ii++] = roofStart + p; index[ii++] = roofStart + q; index[ii++] = roofStart + r;
      } else {
        index[ii++] = roofStart + p; index[ii++] = roofStart + r; index[ii++] = roofStart + q;
      }
    }
    if (s.minHeight > 0.5) {
      const underStart = v;
      for (const [e, n] of flatPts) put(e, n, g, s.minHeight, top, 0, -1, 0);
      for (let k = 0; k < t.length; k += 3) {
        const [p, q, r] = [t[k], t[k + 1], t[k + 2]];
        const ccw = cross2(flatPts[p], flatPts[q], flatPts[r]) > 0;
        if (ccw) {
          index[ii++] = underStart + p; index[ii++] = underStart + r; index[ii++] = underStart + q;
        } else {
          index[ii++] = underStart + p; index[ii++] = underStart + q; index[ii++] = underStart + r;
        }
      }
    }
  });

  starts[specs.length] = v;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new BufferAttribute(nrm, 3));
  geometry.setAttribute('aHag', new BufferAttribute(hag, 1));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(vCount * 3).fill(1), 3));
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  return { geometry, ground, hag, buildingHeight: bh, buildingGround, starts, bounds, count: specs.length, estimatedCount, maxHeight };
}

/** The building a vertex belongs to (e.g. from a raycast hit's face). */
export function buildingOfVertex(b: BuildingsBuild, vertex: number): number {
  let lo = 0;
  let hi = b.count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (b.starts[mid] <= vertex) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Every building whose footprint contains the point (a house and its parts can overlap). */
export function buildingsAt(b: BuildingsBuild, specs: BuildingSpec[], pt: Pt): number[] {
  const [e, n] = pt;
  const out: number[] = [];
  for (let i = 0; i < b.count; i++) {
    const k = i * 4;
    if (e < b.bounds[k] || n < b.bounds[k + 1] || e > b.bounds[k + 2] || n > b.bounds[k + 3]) continue;
    const { outer, holes } = specs[i].poly;
    if (pointInRing(pt, outer) && !holes.some((h) => pointInRing(pt, h))) out.push(i);
  }
  return out;
}

function cross2(a: [number, number], b: [number, number], c: [number, number]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

export function setBuildingsExaggeration(b: BuildingsBuild, ex: number, refElev: number): void {
  const pos = b.geometry.getAttribute('position') as BufferAttribute;
  const arr = pos.array as Float32Array;
  for (let v = 0; v < b.ground.length; v++) arr[v * 3 + 1] = (b.ground[v] - refElev) * ex + b.hag[v];
  pos.needsUpdate = true;
  b.geometry.computeBoundingSphere();
}

// ---------------------------------------------------------------- colour

/** Height ramp (viridis stops: colour-blind safe, monotonic lightness). */
/**
 * Height colours: yellow through orange and magenta to deep indigo (matplotlib's plasma, from
 * light to dark). No greens or light blues, so buildings never look like parks or water.
 */
export const HEIGHT_RAMP: Array<[number, string]> = [
  [0, '#f0f921'],
  [10, '#f89540'],
  [20, '#cc4778'],
  [40, '#9c179e'],
  [80, '#5c01a6'],
  [160, '#0d0887'],
];

/** One colour for every building: white, and three that stand apart from roads, parks and water. */
export const BUILDING_COLOURS = {
  white: '#f7f5f0',
  grey: '#a7a39b',
  sand: '#d9bd8c',
  dark: '#56524d',
} as const;

const rampColors = HEIGHT_RAMP.map(([h, c]) => [h, new Color(c)] as const);

export function rampColor(h: number, out = new Color()): Color {
  if (h <= rampColors[0][0]) return out.copy(rampColors[0][1]);
  for (let k = 1; k < rampColors.length; k++) {
    const [h1, c1] = rampColors[k];
    if (h <= h1) {
      const [h0, c0] = rampColors[k - 1];
      return out.copy(c0).lerp(c1, (h - h0) / (h1 - h0));
    }
  }
  return out.copy(rampColors[rampColors.length - 1][1]);
}

export function applyBuildingStyle(b: BuildingsBuild, style: keyof typeof BUILDING_COLOURS | 'ramp'): void {
  const col = b.geometry.getAttribute('color') as BufferAttribute;
  const arr = col.array as Float32Array;
  const c = new Color();
  const solid = style === 'ramp' ? null : new Color(BUILDING_COLOURS[style]);
  let lastH = -1;
  for (let v = 0; v < b.buildingHeight.length; v++) {
    const h = b.buildingHeight[v];
    if (solid) c.copy(solid);
    else if (h !== lastH) rampColor(h, c);
    lastH = solid ? -1 : h;
    arr[v * 3] = c.r;
    arr[v * 3 + 1] = c.g;
    arr[v * 3 + 2] = c.b;
  }
  col.needsUpdate = true;
}

/** Paint whole buildings in one colour, on top of the current style (the pinned house). */
export function paintBuildings(b: BuildingsBuild, indices: number[], color: Color): void {
  const col = b.geometry.getAttribute('color') as BufferAttribute;
  const arr = col.array as Float32Array;
  for (const i of indices) {
    for (let v = b.starts[i]; v < b.starts[i + 1]; v++) {
      arr[v * 3] = color.r;
      arr[v * 3 + 1] = color.g;
      arr[v * 3 + 2] = color.b;
    }
  }
  col.needsUpdate = true;
}
