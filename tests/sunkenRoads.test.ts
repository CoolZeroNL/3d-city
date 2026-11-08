import { describe, expect, it } from 'vitest';
import type { PrintRoad } from '../src/export/roads';
import { buildPrint, Triangles } from '../src/export/stl';
import { addCarvedTerrainBlock, ROAD_SINK_MM, simplify } from '../src/export/sunkenRoads';
import { buildTiledPrint } from '../src/export/tiles';
import type { HeightGrid } from '../src/geo/terrain';

/** Every directed edge once, and its reverse once: closed shells, consistently wound. */
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

/** The highest up-facing triangle over (x, y) mm, or null. */
function topAt(t: Triangles, x: number, y: number): number | null {
  let best: number | null = null;
  const d = t.data;
  for (let k = 0; k < t.count; k++) {
    const p = k * 9;
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = d.subarray(p, p + 9);
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (den <= 1e-12) continue;
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den;
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
    const z = l1 * az + l2 * bz + l3 * cz;
    if (best === null || z > best) best = z;
  }
  return best;
}

function grid(n: number, sizeM: number, f: (x: number, y: number) => number): HeightGrid {
  const elev = new Float32Array(n * n);
  const step = sizeM / (n - 1);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) elev[j * n + i] = f(-sizeM / 2 + i * step, -sizeM / 2 + j * step);
  let min = Infinity;
  let max = -Infinity;
  for (const v of elev) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return { n, sizeM, elev, min, max, zoom: 15 };
}

const flat = grid(33, 400, () => 10);
const hilly = grid(33, 400, (x, y) => 20 + 0.05 * x + 15 * Math.exp(-(x * x + y * y) / (2 * 120 * 120)) + 2 * Math.sin(x / 23) * Math.cos(y / 31));

const road = (pts: Array<[number, number]>, widthM = 8, bridge = false): PrintRoad => ({ pts, widthM, bridge });
const circle = (cx: number, cy: number, r: number, m = 24): Array<[number, number]> =>
  Array.from({ length: m + 1 }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / m), cy + r * Math.sin((2 * Math.PI * i) / m)] as [number, number]);

/** A bit of everything: crossings, a diagonal, a bend, a dead end, a roundabout with an island, the border, a corner. */
const town: PrintRoad[] = [
  road([[-250, 0], [250, 0]], 12),
  road([[0, -250], [0, 250]], 10),
  road([[-180, -170], [170, 160]], 6),
  road([[-150, 80], [-90, 95], [-60, 140], [-70, 190]], 5),
  road([[60, -60], [110, -90]], 7), // dead end
  road(circle(100, 100, 18), 6), // a ring road round a small island
  road([[-250, 196], [250, 197]], 9), // along the north border, half outside
  road([[170, -230], [230, -170]], 8), // across the south-east corner
  road([[300, 300], [320, 330]], 8), // wholly outside
  road([[-20, -120], [20, -120]], 0.5), // too narrow to print: left out
  road([[-120, -60], [-120, 60]], 8, true), // a bridge: raised, not cut
];

describe('sunken roads', () => {
  const opts = { sideMm: 100, baseMm: 3, exaggeration: 1.5, sinkRoadsMm: ROAD_SINK_MM };

  it('cuts the roads into one closed block, on flat and hilly ground', () => {
    for (const g of [flat, hilly]) {
      const t = new Triangles();
      const carved = addCarvedTerrainBlock(t, g, town, { s: 0.25, exaggeration: 1.5, base: -3, depthMm: ROAD_SINK_MM });
      expect(carved).toBe(8); // not the one outside, the hair-thin one or the bridge
      expect(closedShells(t)).toBe(true);
      expect(volume(t)).toBeGreaterThan(0);
    }
  });

  it('puts the road floor exactly the depth below the land', () => {
    const t = buildPrint(flat, [], opts, town);
    expect(t.roadsRaisedInstead).toBe(false);
    const land = topAt(t, -30 * 0.25, 40 * 0.25)!; // between the roads
    expect(land).toBeCloseTo(0, 5);
    expect(topAt(t, -100 * 0.25, 0)!).toBeCloseTo(-ROAD_SINK_MM, 5); // on the main road
    expect(topAt(t, 100 * 0.25, 100 * 0.25)!).toBeCloseTo(0, 5); // the roundabout's island stays up
    expect(topAt(t, 118 * 0.25, 100 * 0.25)!).toBeCloseTo(-ROAD_SINK_MM, 5); // its ring is cut
    expect(topAt(t, -15 * 0.25, -120 * 0.25)!).toBeCloseTo(0, 5); // the hair-thin path is left out
  });

  it('keeps bridges raised and the whole print closed', () => {
    const t = buildPrint(hilly, [], opts, town);
    expect(closedShells(t)).toBe(true);
    const plain = buildPrint(hilly, [], opts, town.filter((r) => !r.bridge));
    expect(t.count).toBeGreaterThan(plain.count); // the bridge's pieces
  });

  it('stays closed with many random roads, at every print size', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const sideMm of [100, 150, 200]) {
      const roads: PrintRoad[] = [];
      for (let r = 0; r < 40; r++) {
        const pts: Array<[number, number]> = [[rnd() * 440 - 220, rnd() * 440 - 220]];
        for (let q = 0; q < 1 + Math.floor(rnd() * 4); q++) {
          const [x, y] = pts[pts.length - 1];
          pts.push([x + rnd() * 160 - 80, y + rnd() * 160 - 80]);
        }
        roads.push(road(pts, 2 + rnd() * 14));
      }
      const t = buildPrint(hilly, [], { ...opts, sideMm }, roads);
      expect(t.roadsRaisedInstead).toBe(false);
      expect(closedShells(t)).toBe(true);
      expect(volume(t)).toBeGreaterThan(0);
    }
  });

  it('cuts every tile of a tiled print, closed', () => {
    const tiles = buildTiledPrint(hilly, [], { ...opts, tiles: 3 }, town);
    expect(tiles).toHaveLength(9);
    for (const tile of tiles) {
      expect(tile.tris.roadsRaisedInstead).toBe(false);
      expect(closedShells(tile.tris)).toBe(true);
    }
  });

  it('without roads, is the plain block', () => {
    const t = new Triangles();
    expect(addCarvedTerrainBlock(t, hilly, [], { s: 0.25, exaggeration: 1.5, base: -3, depthMm: ROAD_SINK_MM })).toBe(0);
    const plain = buildPrint(hilly, [], { ...opts, sinkRoadsMm: undefined });
    expect(closedShells(t)).toBe(true);
    expect(volume(t)).toBeCloseTo(volume(plain), 3);
  });

  it('simplifies straight runs of the edge but keeps its turns', () => {
    const p = (x: number, y: number) => ({ x, y, z: 0 });
    expect(simplify([p(0, 0), p(1, 0.001), p(2, 0), p(3, 0.002), p(4, 0)], 0.01)).toHaveLength(2);
    expect(simplify([p(0, 0), p(1, 1), p(0, 2)], 0.01)).toHaveLength(3);
    expect(simplify([p(0, 0), p(2, 0), p(1, 0.001)], 0.01)).toHaveLength(3); // doubles back
  });
});
