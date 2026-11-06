import { describe, expect, it } from 'vitest';
import { addRoads, ROAD_MIN_MM, ROAD_RAISE_MM, surfaceMm, type PrintRoad } from '../src/export/roads';
import { buildPrint, Triangles } from '../src/export/stl';
import { buildTiledPrint } from '../src/export/tiles';
import type { HeightGrid } from '../src/geo/terrain';

/** Every directed edge once, and its reverse once: closed shells, none sharing an edge with another. */
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

/** Up-facing triangles of `t` whose plan covers (x, y) mm: the highest one's z there, else null. */
function topAt(t: Triangles, x: number, y: number): number | null {
  let best: number | null = null;
  const d = t.data;
  for (let k = 0; k < t.count; k++) {
    const p = k * 9;
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = d.subarray(p, p + 9);
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (den <= 1e-12) continue; // facing down or on edge (anticlockwise seen from above = up)
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den;
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
    const z = l1 * az + l2 * bz + l3 * cz;
    if (best === null || z > best) best = z;
  }
  return best;
}

/** 1 km, 33 × 33 points: a hill in the middle on a gentle slope. */
function hill(): HeightGrid {
  const n = 33;
  const elev = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i - 16) * 31.25;
      const y = (j - 16) * 31.25;
      elev[j * n + i] = 20 + i * 0.4 + 60 * Math.exp(-(x * x + y * y) / (2 * 200 * 200));
    }
  }
  let min = Infinity, max = -Infinity;
  for (const v of elev) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return { n, sizeM: 1000, elev, min, max, zoom: 15 };
}

const opts = { sideMm: 200, baseMm: 3, exaggeration: 1.5 };
const s = 200 / 1000; // mm per metre

describe('raised roads in prints', () => {
  it('reads the printed surface exactly at the grid points', () => {
    const g = hill();
    for (const [i, j] of [[0, 0], [5, 7], [16, 16], [32, 32]]) {
      const x = -500 + i * 31.25;
      const y = -500 + j * 31.25;
      expect(surfaceMm(g, x, y, 1.5, s)).toBeCloseTo((g.elev[j * g.n + i] - g.min) * 1.5 * s, 9);
    }
  });

  it('puts every road 0.4 mm above the ground under it, over a hill, as closed pieces', () => {
    const g = hill();
    const road: PrintRoad = { pts: [[-450, -20], [0, 10], [450, 40]], widthM: 8, bridge: false };
    const t = new Triangles();
    expect(addRoads(t, g, [road], { s, exaggeration: 1.5 })).toBe(1);
    expect(t.count).toBeGreaterThan(0);
    expect(closedShells(t)).toBe(true);
    // along the road the top is the ground plus 0.4 mm, give or take where the ground bends
    for (const e of [-300, -120, 0, 150, 333]) {
      const n = e < 0 ? -20 + ((e + 450) / 450) * 30 : 10 + (e / 450) * 30;
      const top = topAt(t, e * s, n * s)!;
      expect(top - surfaceMm(g, e, n, 1.5, s)).toBeGreaterThan(ROAD_RAISE_MM - 0.05);
      expect(top - surfaceMm(g, e, n, 1.5, s)).toBeLessThan(ROAD_RAISE_MM + 0.05);
    }
    // and the road is as wide as it should be: 8 m is 1.6 mm here
    expect(topAt(t, 0, 10 * s + 0.75)).not.toBeNull();
    expect(topAt(t, 0, 10 * s + 0.9)).toBeNull();
  });

  it('mitres corners up to 90° and rounds sharper ones, leaving no notch', () => {
    const g = hill();
    for (const [corner, outer] of [
      // a right angle: east, then north; the mitre point is south-east of the corner
      [[[-100, 0], [0, 0], [0, 100]], [0.95, -0.95]],
      // a hairpin: east, then back west-north-west
      [[[-100, 0], [0, 0], [-100, 30]], [0.95, 0]],
    ] as Array<[Array<[number, number]>, [number, number]]>) {
      const t = new Triangles();
      addRoads(t, g, [{ pts: corner, widthM: 10, bridge: false }], { s, exaggeration: 1.5 });
      expect(closedShells(t)).toBe(true);
      // 10 m is 2 mm: points just inside the outer edge of the bend are covered
      expect(topAt(t, outer[0], outer[1])).not.toBeNull();
    }
  });

  it('keeps a bridge level between its ends, over the valley under it', () => {
    const n = 33;
    const elev = new Float32Array(n * n).fill(40);
    for (let j = 0; j < n; j++) for (let i = 14; i <= 18; i++) elev[j * n + i] = 10; // a valley running north
    const g: HeightGrid = { n, sizeM: 1000, elev, min: 10, max: 40, zoom: 15 };
    const t = new Triangles();
    addRoads(t, g, [{ pts: [[-150, 0], [150, 0]], widthM: 8, bridge: true }], { s, exaggeration: 1 });
    expect(closedShells(t)).toBe(true);
    const deck = surfaceMm(g, -150, 0, 1, s) + ROAD_RAISE_MM;
    expect(topAt(t, 0, 0)).toBeCloseTo(deck, 3);
  });

  it('cuts roads at the edge of the print and leaves out ones too thin to print', () => {
    const g = hill();
    const roads: PrintRoad[] = [
      { pts: [[-700, 100], [700, 100]], widthM: 6, bridge: false },
      // a 1.6 m path is 0.16 mm at 1:10,000: left out
      { pts: [[-200, -200], [200, -200]], widthM: 1.6, bridge: false },
    ];
    const t = buildPrint(g, [], { ...opts, sideMm: 100 }, roads);
    const plain = buildPrint(g, [], { ...opts, sideMm: 100 });
    expect(closedShells(t)).toBe(true);
    let x0 = Infinity, x1 = -Infinity;
    for (let k = 0; k < t.count * 9; k += 3) {
      x0 = Math.min(x0, t.data[k]);
      x1 = Math.max(x1, t.data[k]);
    }
    expect(x0).toBeGreaterThanOrEqual(-50 - 1e-6);
    expect(x1).toBeLessThanOrEqual(50 + 1e-6);
    // the road is there, at least ROAD_MIN_MM wide; the path isn't
    expect(topAt(t, 10, 10 + ROAD_MIN_MM / 2 - 0.05)! - topAt(plain, 10, 10 + ROAD_MIN_MM / 2 - 0.05)!).toBeGreaterThan(0.3);
    expect(topAt(t, 0, -20)).toBeCloseTo(topAt(plain, 0, -20)!, 6);
  });

  it('makes no shared faces from the same road given twice', () => {
    const g = hill();
    const road: PrintRoad = { pts: [[-100, 50], [100, 60]], widthM: 6, bridge: false };
    const t = new Triangles();
    addRoads(t, g, [road, { ...road }], { s, exaggeration: 1.5 });
    expect(closedShells(t)).toBe(true);
  });

  it('runs roads across tiles, cut exactly at the seams', () => {
    const g = hill();
    const roads: PrintRoad[] = [{ pts: [[-400, -300], [400, 300]], widthM: 8, bridge: false }];
    const tiles = buildTiledPrint(g, [], { sideMm: 100, baseMm: 3, exaggeration: 1.5, tiles: 2 }, roads);
    const plain = buildTiledPrint(g, [], { sideMm: 100, baseMm: 3, exaggeration: 1.5, tiles: 2 });
    for (const t of tiles) expect(closedShells(t.tris)).toBe(true);
    // the diagonal crosses the middle of the square, the corner of all four tiles: just south-west
    // of it, tile B1 (south-west) has the road up to its corner
    const sw = tiles.find((t) => t.name === 'B1')!;
    const swPlain = plain.find((t) => t.name === 'B1')!;
    // B1 is centred at (-250, -250) m, at 0.2 mm/m (500 m on 100 mm): the point (-20, -15) m
    const [x, y] = [(-20 + 250) * 0.2, (-15 + 250) * 0.2];
    expect(topAt(sw.tris, x, y)! - topAt(swPlain.tris, x, y)!).toBeCloseTo(ROAD_RAISE_MM, 1);
    // and the north-east tile has the other end
    const ne = tiles.find((t) => t.name === 'A2')!;
    const nePlain = plain.find((t) => t.name === 'A2')!;
    const [u, v] = [(200 - 250) * 0.2, (150 - 250) * 0.2];
    expect(topAt(ne.tris, u, v)! - topAt(nePlain.tris, u, v)!).toBeCloseTo(ROAD_RAISE_MM, 1);
  });
});
