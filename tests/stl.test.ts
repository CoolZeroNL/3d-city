import { describe, expect, it } from 'vitest';
import { buildPrint, cleanRing, insetRing, isSimple, printScale, toBinaryStl, Triangles, validFootprint } from '../src/export/stl';
import { clipBuildingToRect } from '../src/geo/clip';
import { clipPolygonToRect, signedArea } from '../src/geo/polygon';
import { withOrientation, type Polygon } from '../src/geo/polygon';
import type { HeightGrid } from '../src/geo/terrain';

function grid(n: number, sizeM: number, f: (e: number, nm: number) => number): HeightGrid {
  const elev = new Float32Array(n * n);
  const step = sizeM / (n - 1);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) elev[j * n + i] = f(-sizeM / 2 + i * step, -sizeM / 2 + j * step);
  let min = Infinity;
  let max = -Infinity;
  for (const v of elev) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return { n, sizeM, elev, min, max } as HeightGrid;
}

const square = (x: number, y: number, w: number, ccw = true): Polygon => ({
  outer: withOrientation([[x, y], [x + w, y], [x + w, y + w], [x, y + w]], ccw),
  holes: [],
});

/** Signed volume (positive when every triangle faces outward). */
function volume(t: Triangles): number {
  let v = 0;
  const d = t.data;
  for (let k = 0; k < t.count; k++) {
    const p = k * 9;
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = d.subarray(p, p + 9);
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

/** Every edge used by exactly two triangles, once in each direction: closed and consistently wound. */
function closedShells(t: Triangles): boolean {
  const seen = new Map<string, number>();
  const key = (p: number) => `${t.data[p]},${t.data[p + 1]},${t.data[p + 2]}`;
  for (let k = 0; k < t.count; k++) {
    const v = [key(k * 9), key(k * 9 + 3), key(k * 9 + 6)];
    for (let e = 0; e < 3; e++) {
      const dir = `${v[e]}>${v[(e + 1) % 3]}`;
      seen.set(dir, (seen.get(dir) ?? 0) + 1);
    }
  }
  for (const [dir, count] of seen) {
    const [a, b] = dir.split('>');
    if (count !== 1 || seen.get(`${b}>${a}`) !== 1) return false;
  }
  return true;
}

describe('3D print (STL)', () => {
  const opts = { sideMm: 100, baseMm: 3, exaggeration: 1, shellGapMm: 0 };

  it('makes a flat site a closed block of the right size', () => {
    const t = buildPrint(grid(5, 100, () => 50), [], opts);
    expect(closedShells(t)).toBe(true);
    expect(volume(t)).toBeCloseTo(100 * 100 * 3, 3); // 1 mm per m: a 100 × 100 × 3 mm slab
  });

  it('keeps hilly terrain watertight and scales relief by the exaggeration', () => {
    const hill = (e: number, n: number) => 100 + 20 * Math.exp(-(e * e + n * n) / 800);
    const t1 = buildPrint(grid(17, 100, hill), [], opts);
    const t2 = buildPrint(grid(17, 100, hill), [], { ...opts, exaggeration: 2 });
    expect(closedShells(t1)).toBe(true);
    expect(closedShells(t2)).toBe(true);
    const slab = 100 * 100 * 3;
    expect(volume(t2) - slab).toBeCloseTo(2 * (volume(t1) - slab), 0);
  });

  it('adds each building as a closed prism rising from inside the block', () => {
    const t = buildPrint(grid(3, 100, () => 0), [{ poly: square(0, 0, 10), top: 20 }], { ...opts, baseMm: 4 });
    expect(closedShells(t)).toBe(true);
    // slab 100 × 100 × 4 plus a 10 × 10 column from 2 mm below the surface to 20 mm above
    expect(volume(t)).toBeCloseTo(100 * 100 * 4 + 10 * 10 * 22, 2);
  });

  it('copes with courtyards and with outlines wound the wrong way', () => {
    const courtyard: Polygon = { outer: square(0, 0, 30).outer, holes: [withOrientation([[10, 10], [20, 10], [20, 20], [10, 20]], false)] };
    const backwards = square(-40, -40, 10, false);
    const flat = grid(3, 100, () => 0);
    const only = (b: Polygon) => volume(buildPrint(flat, [{ poly: b, top: 10 }], opts)) - 100 * 100 * 3;
    expect(only(courtyard)).toBeCloseTo((900 - 100) * 11.5, 2);
    expect(only(backwards)).toBeCloseTo(100 * 11.5, 2);
    expect(closedShells(buildPrint(flat, [{ poly: courtyard, top: 10 }, { poly: backwards, top: 10 }], opts))).toBe(true);
  });

  it('stays closed when outlines have extra points on straight walls or repeated points', () => {
    const flat = grid(3, 100, () => 0);
    const terrace: Polygon = {
      outer: withOrientation([[0, 0], [5, 0], [10, 0], [10, 0], [10, 8], [10, 16], [0, 16], [0, 8]], true),
      holes: [],
    };
    const t = buildPrint(flat, [{ poly: terrace, top: 9 }], opts);
    expect(closedShells(t)).toBe(true);
    expect(volume(t) - 100 * 100 * 3).toBeCloseTo(10 * 16 * 10.5, 2);
  });

  it('cuts buildings at a tile edge without slits, so the print stays closed', () => {
    const flat = grid(3, 100, () => 0);
    // a courtyard block cut through its courtyard by the edge x = 15
    const block: Polygon = { outer: square(0, 0, 30).outer, holes: [withOrientation([[10, 10], [20, 10], [20, 20], [10, 20]], false)] };
    const exact = clipBuildingToRect(block, -50, -50, 15, 50);
    expect(exact).toHaveLength(1);
    expect(exact[0].holes).toHaveLength(0); // the courtyard is open to the cut now
    expect(Math.abs(signedArea(exact[0].outer))).toBeCloseTo(15 * 30 - 5 * 10);
    expect(closedShells(buildPrint(flat, exact.map((poly) => ({ poly, top: 10 })), opts))).toBe(true);
    // ring-by-ring clipping leaves the courtyard touching the cut — invalid, but the
    // print repairs such outlines too
    const naive = clipPolygonToRect(block, -50, -50, 15, 50)!;
    expect(validFootprint(naive)).toBe(false);
    expect(closedShells(buildPrint(flat, [{ poly: naive, top: 10 }], opts))).toBe(true);
    // a U-shape leaving and re-entering the rectangle becomes two buildings
    const u: Polygon = { outer: withOrientation([[0, 0], [30, 0], [30, 30], [20, 30], [20, 10], [10, 10], [10, 30], [0, 30]], true), holes: [] };
    expect(clipBuildingToRect(u, -50, -50, 50, 20)).toHaveLength(1);
    expect(clipBuildingToRect(u, -50, 15, 50, 50)).toHaveLength(2);
    // inside: untouched; outside: gone
    expect(clipBuildingToRect(u, -50, -50, 50, 50)[0]).toBe(u);
    expect(clipBuildingToRect(u, 40, 40, 50, 50)).toEqual([]);
  });

  it('keeps touching houses and stacked parts from sharing any point', () => {
    const flat = grid(3, 100, () => 0);
    // two terraced houses sharing a wall, and an outline with an identical building part
    const row = [square(0, 0, 10), square(10, 0, 10), square(-30, -30, 10), square(-30, -30, 10)].map((poly) => ({ poly, top: 8 }));
    expect(closedShells(buildPrint(flat, row, opts))).toBe(false); // coincident walls and floors
    const t = buildPrint(flat, row, { ...opts, shellGapMm: undefined });
    expect(closedShells(t)).toBe(true);
    // the default gap is far below what a printer resolves
    const v = volume(t) - 100 * 100 * 3;
    expect(v).toBeGreaterThan(4 * 100 * 9.5 * 0.97);
  });

  it('repairs outlines that cross themselves instead of leaving holes in the print', () => {
    const flat = grid(3, 100, () => 0);
    // a bow tie: the outline crosses itself in the middle
    const bowTie: Polygon = { outer: [[0, 0], [10, 10], [10, 0], [0, 10]], holes: [] };
    // repaired into two triangles of 25 mm² that touch at a point; the shell gap parts them
    const t = buildPrint(flat, [{ poly: bowTie, top: 5 }], { ...opts, shellGapMm: undefined });
    expect(closedShells(t)).toBe(true);
    expect((volume(t) - 100 * 100 * 3) / (50 * 6.5)).toBeGreaterThan(0.98);
    expect(isSimple(bowTie.outer)).toBe(false);
    expect(isSimple(square(0, 0, 10).outer)).toBe(true);
  });

  it('insets outlines into the solid', () => {
    const r = insetRing(square(0, 0, 10).outer, 0.5);
    expect(Math.abs(signedArea(r))).toBeCloseTo(9 * 9, 6);
    expect(insetRing(square(0, 0, 10).outer, 0)).toEqual(square(0, 0, 10).outer);
  });

  it('writes a binary STL that readers recognise', () => {
    const t = buildPrint(grid(3, 100, () => 0), [{ poly: square(0, 0, 10), top: 5 }], opts);
    const buf = toBinaryStl(t, 'Kleinfelde — 1 km');
    const dv = new DataView(buf);
    expect(buf.byteLength).toBe(84 + 50 * t.count);
    expect(dv.getUint32(80, true)).toBe(t.count);
    const header = new TextDecoder().decode(new Uint8Array(buf, 0, 80));
    expect(header.startsWith('solid')).toBe(false);
    expect(header).toContain('Kleinfelde');
    expect(header).toContain('(c) OpenStreetMap contributors');
    // a long place name is shortened, the map data credit is kept
    const long = new TextDecoder().decode(new Uint8Array(toBinaryStl(t, 'Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch, 4 km, 1:20,000, terrain x3.0'), 0, 80));
    expect(long.endsWith(' | (c) OpenStreetMap contributors')).toBe(true);
    const [nx, ny, nz] = [dv.getFloat32(84, true), dv.getFloat32(88, true), dv.getFloat32(92, true)];
    expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
  });

  it('cleans rings like the roof triangulator does', () => {
    expect(cleanRing([[0, 0], [1, 0], [2, 0], [2, 2], [2, 2], [0, 2]])).toEqual([[0, 0], [2, 0], [2, 2], [0, 2]]);
    expect(cleanRing([[0, 0], [1, 0], [2, 0]])).toHaveLength(2); // degenerate: nothing left to build
  });

  it('drops hairline spikes', () => {
    // a spike out of the top edge that folds back within a fraction of a degree
    const spiky: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [5, 10], [5.001, 20], [5.002, 10], [0, 10]];
    expect(cleanRing(spiky)).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
  });

  it('stays closed for an Eixample-style block: octagon with an aligned courtyard', () => {
    const flat = grid(3, 200, () => 0);
    const oct = (c: number, r: number, k: number): Array<[number, number]> => [
      [c - r + k, c - r], [c + r - k, c - r], [c + r, c - r + k], [c + r, c + r - k],
      [c + r - k, c + r], [c - r + k, c + r], [c - r, c + r - k], [c - r, c - r + k],
    ];
    // courtyard corners exactly on the lines of the outer walls
    const block: Polygon = { outer: withOrientation(oct(0, 56, 10), true), holes: [withOrientation(oct(0, 36, 10), false)] };
    const t = buildPrint(flat, [{ poly: block, top: 20 }], { ...opts, sideMm: 200, shellGapMm: undefined });
    expect(closedShells(t)).toBe(true);
  });

  it('repairs a courtyard that runs along the outer wall', () => {
    const flat = grid(3, 100, () => 0);
    // the courtyard's bottom edge lies on the outer ring's bottom edge (invalid, but in the data)
    const touching: Polygon = { outer: square(0, 0, 30).outer, holes: [withOrientation([[10, 0], [20, 0], [20, 10], [10, 10]], false)] };
    expect(validFootprint(touching)).toBe(false);
    const t = buildPrint(flat, [{ poly: touching, top: 10 }], { ...opts, shellGapMm: undefined });
    expect(closedShells(t)).toBe(true);
    expect((volume(t) - 100 * 100 * 3) / ((900 - 100) * 11.5)).toBeGreaterThan(0.98);
  });

  it('merges points closer than 5 µm, so hairline spikes are caught', () => {
    // a spike whose tip is two points 2 µm apart: its angle is noise until they merge
    const r: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [5, 10], [5.0005, 20], [5.0019, 20.0014], [5.002, 10], [0, 10]];
    expect(cleanRing(r)).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
  });

  it('states the scale', () => {
    expect(printScale(2000, 150)).toBe('1:13,300');
    expect(printScale(1000, 100)).toBe('1:10,000');
  });
});
