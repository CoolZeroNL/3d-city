import { describe, expect, it } from 'vitest';
import { buildPrint, type Triangles } from '../src/export/stl';
import { buildTiledPrint } from '../src/export/tiles';
import { areaMask, depthInMetres, GREEN_RAISE_MM, shiftMasked, sinkWater, waterMask, WATER_DEPTH_MM } from '../src/export/water';
import type { Polygon } from '../src/geo/polygon';
import type { HeightGrid } from '../src/geo/terrain';

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

/** The terrain's top at a point of the print (mm): the highest vertex there that isn't a building. */
function topAt(t: Triangles, x: number, y: number): number {
  let z = -Infinity;
  for (let i = 0; i < t.count * 9; i += 3) if (Math.abs(t.data[i] - x) < 1e-3 && Math.abs(t.data[i + 1] - y) < 1e-3) z = Math.max(z, t.data[i + 2]);
  return z;
}

/** 1 km of gentle slope, 33 × 33 points (31.25 m apart). */
function slope(): HeightGrid {
  const n = 33;
  const elev = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) elev[j * n + i] = 50 + i * 0.5 + j * 0.3;
  return { n, sizeM: 1000, elev, min: 50, max: 50 + 32 * 0.8, zoom: 15 };
}

const ring = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
// a lake 400 m across with an island in the middle
const lake: Polygon = { outer: ring(-200, -200, 200, 200), holes: [ring(-50, -50, 50, 50)] };

describe('sunken water in prints', () => {
  it('finds the water: the lake, not its island, and the sea', () => {
    const g = slope();
    const at = (mask: Uint8Array, e: number, n: number) => mask[Math.round((n + 500) / 31.25) * g.n + Math.round((e + 500) / 31.25)];
    const m = waterMask(g, [lake], (e) => e > 400);
    expect(at(m, -156.25, 0)).toBe(1); // in the lake
    expect(at(m, 0, 0)).toBe(0); // on the island
    expect(at(m, -406.25, 0)).toBe(0); // on land
    expect(at(m, 437.5, 0)).toBe(1); // at sea
  });

  for (const ex of [1, 2.5]) {
    it(`sinks it ${WATER_DEPTH_MM} mm in the print at terrain ×${ex}, and only the water`, () => {
      const g = slope();
      const opts = { sideMm: 100, baseMm: 3, exaggeration: ex };
      const plain = buildPrint(g, [], opts);
      const sunk = buildPrint(sinkWater(g, waterMask(g, [lake]), depthInMetres(WATER_DEPTH_MM, 100, 1000, ex)), [], opts);
      const mm = (m: number) => m * 0.1; // 100 mm for 1000 m
      expect(topAt(plain, mm(-156.25), 0) - topAt(sunk, mm(-156.25), 0)).toBeCloseTo(1, 4);
      expect(topAt(sunk, 0, 0)).toBeCloseTo(topAt(plain, 0, 0), 5); // the island stays
      expect(topAt(sunk, mm(-406.25), 0)).toBeCloseTo(topAt(plain, mm(-406.25), 0), 5); // and the land
      expect(closedShells(sunk)).toBe(true);
    });
  }

  it('keeps tiles closed and matching when the water is sunk', () => {
    const g = slope();
    const sunk = sinkWater(g, waterMask(g, [lake]), depthInMetres(WATER_DEPTH_MM, 2 * 100, 1000, 1.5));
    const tiles = buildTiledPrint(sunk, [], { sideMm: 100, baseMm: 3, exaggeration: 1.5, tiles: 2 });
    for (const t of tiles) expect(closedShells(t.tris)).toBe(true);
    // the lake spans all four tiles; in each, its part is 1 mm below the plain print
    const plain = buildTiledPrint(g, [], { sideMm: 100, baseMm: 3, exaggeration: 1.5, tiles: 2 });
    // tile A1 (north-west, centred at -250, 250) holds the lake's north-west part: the grid point
    // at (-156.25, 156.25) is (93.75, -93.75) m from the tile's centre, 0.2 mm per metre
    const [x, y] = [93.75 * 0.2, -93.75 * 0.2];
    expect(topAt(plain[0].tris, x, y) - topAt(tiles[0].tris, x, y)).toBeCloseTo(1, 3);
  });

  it(`raises parks and woods ${GREEN_RAISE_MM} mm, and keeps the water sunk inside them`, () => {
    const g = slope();
    const park: Polygon = { outer: ring(-300, -300, 300, 300), holes: [] };
    const opts = { sideMm: 100, baseMm: 3, exaggeration: 2 };
    const plain = buildPrint(g, [], opts);
    const water = waterMask(g, [lake]);
    const green = areaMask(g, [park]);
    for (let k = 0; k < green.length; k++) if (water[k]) green[k] = 0; // as CityModel.printGreen does
    const metres = (mm: number) => depthInMetres(mm, 100, 1000, 2);
    const both = buildPrint(shiftMasked(sinkWater(g, water, metres(WATER_DEPTH_MM)), green, metres(GREEN_RAISE_MM)), [], opts);
    const mm = (m: number) => m * 0.1;
    expect(topAt(both, mm(-250), mm(-250)) - topAt(plain, mm(-250), mm(-250))).toBeCloseTo(GREEN_RAISE_MM, 4); // in the park
    expect(topAt(plain, mm(-156.25), 0) - topAt(both, mm(-156.25), 0)).toBeCloseTo(WATER_DEPTH_MM, 4); // its lake
    expect(topAt(both, 0, 0) - topAt(plain, 0, 0)).toBeCloseTo(GREEN_RAISE_MM, 4); // the island is park too
    expect(topAt(both, mm(-406.25), 0)).toBeCloseTo(topAt(plain, mm(-406.25), 0), 5); // outside it
    expect(closedShells(both)).toBe(true);
  });
});
