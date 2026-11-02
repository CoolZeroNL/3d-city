/**
 * Small, dependency-free polygon helpers working on open rings
 * (the closing vertex is NOT repeated) in a planar (E, N) frame.
 */

export type Pt = [number, number];
export type Ring = Pt[];

export interface Polygon {
  outer: Ring;
  holes: Ring[];
}

/** Shoelace area; positive when the ring is counter-clockwise. */
export function signedArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

export function withOrientation(ring: Ring, ccw: boolean): Ring {
  const isCcw = signedArea(ring) > 0;
  return isCcw === ccw ? ring : ring.slice().reverse();
}

/** Drop a repeated closing vertex and consecutive duplicates. */
export function openRing(ring: Ring): Ring {
  const out: Ring = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  if (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) out.pop();
  }
  return out;
}

/**
 * Sutherland–Hodgman clip of a ring against an axis-aligned rectangle.
 * Works for concave rings; the result may contain zero-width "bridges" along
 * the rectangle edge, which is harmless for filling and extrusion at the border.
 */
export function clipRingToRect(ring: Ring, xmin: number, ymin: number, xmax: number, ymax: number): Ring {
  let out = ring;
  const edges: Array<[(p: Pt) => boolean, (a: Pt, b: Pt) => Pt]> = [
    [(p) => p[0] >= xmin, (a, b) => lerpAtX(a, b, xmin)],
    [(p) => p[0] <= xmax, (a, b) => lerpAtX(a, b, xmax)],
    [(p) => p[1] >= ymin, (a, b) => lerpAtY(a, b, ymin)],
    [(p) => p[1] <= ymax, (a, b) => lerpAtY(a, b, ymax)],
  ];
  for (const [inside, intersect] of edges) {
    if (out.length === 0) break;
    const input = out;
    out = [];
    let prev = input[input.length - 1];
    let prevIn = inside(prev);
    for (const cur of input) {
      const curIn = inside(cur);
      if (curIn) {
        if (!prevIn) out.push(intersect(prev, cur));
        out.push(cur);
      } else if (prevIn) {
        out.push(intersect(prev, cur));
      }
      prev = cur;
      prevIn = curIn;
    }
  }
  return openRing(out);
}

function lerpAtX(a: Pt, b: Pt, x: number): Pt {
  const t = (x - a[0]) / (b[0] - a[0]);
  return [x, a[1] + t * (b[1] - a[1])];
}

function lerpAtY(a: Pt, b: Pt, y: number): Pt {
  const t = (y - a[1]) / (b[1] - a[1]);
  return [a[0] + t * (b[0] - a[0]), y];
}

export function ringBounds(ring: Ring): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

export function pointInRing(pt: Pt, ring: Ring): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Area-weighted centroid, falling back to the vertex mean for degenerate rings. */
export function centroid(ring: Ring): Pt {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0;
    let sy = 0;
    for (const [x, y] of ring) {
      sx += x;
      sy += y;
    }
    return [sx / ring.length, sy / ring.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/**
 * Join open line segments (e.g. the member ways of an OSM multipolygon) into
 * closed rings by matching end points exactly. Chains that cannot be closed
 * are closed implicitly (first and last vertex joined), which is the most
 * forgiving behaviour for slightly broken data.
 */
export function assembleRings(segments: Pt[][]): Ring[] {
  const key = (p: Pt) => `${p[0]},${p[1]}`;
  const pool = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  const rings: Ring[] = [];
  while (pool.length) {
    let chain = pool.pop()!;
    let guard = 0;
    while (key(chain[0]) !== key(chain[chain.length - 1]) && guard++ < 100000) {
      const endKey = key(chain[chain.length - 1]);
      const startKey = key(chain[0]);
      let found = -1;
      let mode: 'append' | 'appendRev' | 'prepend' | 'prependRev' = 'append';
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i];
        const sStart = key(s[0]);
        const sEnd = key(s[s.length - 1]);
        if (sStart === endKey) {
          found = i;
          mode = 'append';
        } else if (sEnd === endKey) {
          found = i;
          mode = 'appendRev';
        } else if (sEnd === startKey) {
          found = i;
          mode = 'prepend';
        } else if (sStart === startKey) {
          found = i;
          mode = 'prependRev';
        }
        if (found >= 0) break;
      }
      if (found < 0) break;
      const seg = pool.splice(found, 1)[0];
      if (mode === 'append') chain = chain.concat(seg.slice(1));
      else if (mode === 'appendRev') chain = chain.concat(seg.slice().reverse().slice(1));
      else if (mode === 'prepend') chain = seg.slice(0, -1).concat(chain);
      else chain = seg.slice().reverse().slice(0, -1).concat(chain);
    }
    const ring = openRing(chain);
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** Assign each inner ring to the outer ring that contains it. Orients outers CCW and holes CW. */
export function groupPolygons(outers: Ring[], inners: Ring[]): Polygon[] {
  const polys: Polygon[] = outers.map((o) => ({ outer: withOrientation(o, true), holes: [] }));
  for (const inner of inners) {
    const probe = inner[0];
    const host = polys.find((p) => pointInRing(probe, p.outer));
    if (host) host.holes.push(withOrientation(inner, false));
  }
  return polys;
}

/** Clip a polygon with holes to a rectangle; returns null when nothing meaningful remains. */
export function clipPolygonToRect(
  poly: Polygon,
  xmin: number,
  ymin: number,
  xmax: number,
  ymax: number,
  minArea = 0.5,
): Polygon | null {
  const outer = clipRingToRect(poly.outer, xmin, ymin, xmax, ymax);
  if (outer.length < 3 || Math.abs(signedArea(outer)) < minArea) return null;
  const holes = poly.holes
    .map((h) => clipRingToRect(h, xmin, ymin, xmax, ymax))
    .filter((h) => h.length >= 3 && Math.abs(signedArea(h)) >= minArea);
  return { outer: withOrientation(outer, true), holes: holes.map((h) => withOrientation(h, false)) };
}
