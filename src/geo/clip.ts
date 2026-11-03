/**
 * Exact clipping of building outlines to a rectangle (a tile or the model square).
 *
 * Ring-by-ring clipping (polygon.ts) is fine for drawing, but where an outline
 * crosses the rectangle it can leave zero-width slits: a courtyard cut open by
 * the edge, or a U-shaped building leaving and re-entering. Those slits become
 * back-to-back walls that break 3D prints. Outlines that cross the edge go
 * through a real polygon intersection instead; the rest are returned as they are.
 *
 * Map tiles cut every building that crosses a tile edge; `joinPieces` glues the
 * pieces back together, so a building is one solid (and one pin highlight).
 */

import polygonClipping, { type MultiPolygon } from 'polygon-clipping';
import { clipPolygonToRect, ringBounds, signedArea, withOrientation, type Polygon, type Ring } from './polygon';

export function clipBuildingToRect(poly: Polygon, xmin: number, ymin: number, xmax: number, ymax: number, minArea = 0.5): Polygon[] {
  const [x0, y0, x1, y1] = ringBounds(poly.outer);
  if (x1 <= xmin || x0 >= xmax || y1 <= ymin || y0 >= ymax) return [];
  if (x0 >= xmin && x1 <= xmax && y0 >= ymin && y1 <= ymax) return Math.abs(signedArea(poly.outer)) >= minArea ? [poly] : [];
  const rect: Ring = [
    [xmin, ymin],
    [xmax, ymin],
    [xmax, ymax],
    [xmin, ymax],
  ];
  try {
    return fromMulti(polygonClipping.intersection(toGeom(poly), [closed(rect)]), minArea);
  } catch {
    // degenerate input the exact clipper rejects: fall back to ring-by-ring clipping
    const c = clipPolygonToRect(poly, xmin, ymin, xmax, ymax, minArea);
    return c ? [c] : [];
  }
}

/** Union pieces that touch or overlap (pieces of one building cut by tile edges). */
export function joinPieces(pieces: Polygon[]): Polygon[] {
  if (pieces.length < 2) return pieces;
  try {
    const [first, ...rest] = pieces.map(toGeom);
    return fromMulti(polygonClipping.union(first, ...rest), 0);
  } catch {
    return pieces;
  }
}

const closed = (r: Ring): Ring => [...r, r[0]];
const toGeom = (p: Polygon) => [closed(p.outer), ...p.holes.map(closed)];

function fromMulti(mp: MultiPolygon, minArea: number): Polygon[] {
  const polys: Polygon[] = [];
  for (const [outer, ...holes] of mp) {
    const o = outer.slice(0, -1) as Ring;
    if (o.length < 3 || Math.abs(signedArea(o)) < minArea) continue;
    polys.push({
      outer: withOrientation(o, true),
      holes: holes.map((h) => withOrientation(h.slice(0, -1) as Ring, false)).filter((h) => h.length >= 3),
    });
  }
  return polys;
}
