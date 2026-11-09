import { describe, expect, it } from 'vitest';
import fontData from '../src/export/glyphs/inter-bold.json';
import { addLabel, type GlyphFont } from '../src/export/label';
import { DEFAULT_FILAMENTS, PAINT, paintCode } from '../src/export/paint';
import type { PrintRoad } from '../src/export/roads';
import { buildPrint, Triangles } from '../src/export/stl';
import { modelXml, to3mf } from '../src/export/threemf';
import { buildTiledPrint } from '../src/export/tiles';
import type { HeightGrid } from '../src/geo/terrain';

/**
 * A paint code read back the way the slicers do (FacetsAnnotation::set_triangle_from_string, then
 * TriangleSelector::deserialize): hex digits last first, each 4 bits low bit first; 2 bits of split
 * sides (0 for a whole triangle), then the state in 2 bits, or 0b11 and 4 more bits for state − 3.
 */
function readPaint(code: string): number {
  const bits: boolean[] = [];
  for (const ch of [...code].reverse()) {
    const v = parseInt(ch, 16);
    for (let i = 0; i < 4; i++) bits.push(!!(v & (1 << i)));
  }
  let at = 0;
  const take = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v |= (bits[at++] ? 1 : 0) << i;
    return v;
  };
  expect(take(2)).toBe(0); // not split
  const state = take(2);
  return state < 3 ? state : 3 + take(4);
}

interface Mesh {
  vertices: number[][];
  triangles: Array<{ v: number[]; paint?: string; prusa?: string }>;
}

function parse(xml: string): Mesh {
  const vertices = [...xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  const triangles = [...xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"([^/]*)\/>/g)].map((m) => ({
    v: [Number(m[1]), Number(m[2]), Number(m[3])],
    paint: /paint_color="([0-9A-F]+)"/.exec(m[4])?.[1],
    prusa: /slic3rpe:mmu_segmentation="([0-9A-F]+)"/.exec(m[4])?.[1],
  }));
  return { vertices, triangles };
}

/** Every directed edge once, and its reverse once, by vertex index: closed shells. */
function closedByIndex(m: Mesh): boolean {
  const seen = new Map<string, number>();
  for (const { v } of m.triangles) for (let e = 0; e < 3; e++) seen.set(`${v[e]}>${v[(e + 1) % 3]}`, (seen.get(`${v[e]}>${v[(e + 1) % 3]}`) ?? 0) + 1);
  for (const [d, n] of seen) {
    const [a, b] = d.split('>');
    if (n !== 1 || seen.get(`${b}>${a}`) !== 1) return false;
  }
  return true;
}

/** The filament of the highest up-facing triangle over (x, y) mm (1 when unpainted), or null. */
function filamentAt(m: Mesh, x: number, y: number): number | null {
  let best: { z: number; f: number } | null = null;
  for (const t of m.triangles) {
    const [[ax, ay, az], [bx, by, bz], [cx, cy, cz]] = t.v.map((i) => m.vertices[i]);
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (den <= 1e-12) continue;
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den;
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
    const z = l1 * az + l2 * bz + l3 * cz;
    if (!best || z > best.z) best = { z, f: t.paint ? readPaint(t.paint) : 1 };
  }
  return best?.f ?? null;
}

/** 400 m, 33 × 33 points, on a slope, with a river along the south (y < -130 m) sunk 4 m. */
function riverTown(): { grid: HeightGrid; water: Uint8Array } {
  const n = 33;
  const step = 400 / (n - 1);
  const elev = new Float32Array(n * n);
  const water = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -200 + i * step;
      const y = -200 + j * step;
      water[j * n + i] = y < -130 ? 1 : 0;
      elev[j * n + i] = 20 + 0.03 * x + 6 * Math.exp(-(x * x + y * y) / (2 * 90 * 90)) - water[j * n + i] * 4;
    }
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of elev) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return { grid: { n, sizeM: 400, elev, min, max, zoom: 15 }, water };
}

const square = (cx: number, cy: number, r: number) => ({
  outer: [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]] as Array<[number, number]>,
  holes: [],
});
const buildings = [square(60, 60, 10), square(-60, 80, 12), square(100, -60, 8)].map((poly) => ({ poly, top: 40 }));
const roads: PrintRoad[] = [
  { pts: [[-250, -10], [250, -10]], widthM: 12, bridge: false },
  { pts: [[-10, -250], [-10, 250]], widthM: 10, bridge: false },
];
const font = fontData as unknown as GlyphFont;
// at 100 mm for 400 m: 0.25 mm per metre
const mm = (m: number) => m * 0.25;

/** Raw DEFLATE undone, as unzip tools do. */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('the colour print file (3MF)', () => {
  it('writes paint codes the slicers read back as the same filament', () => {
    expect([1, 2, 3, 4].map(paintCode)).toEqual(['4', '8', '0C', '1C']);
    for (let f = 1; f <= 17; f++) expect(readPaint(paintCode(f))).toBe(f);
  });

  it('paints buildings, raised roads and water, keeps the ground unpainted, and stays closed', () => {
    const { grid, water } = riverTown();
    const t = buildPrint(grid, buildings, { sideMm: 100, baseMm: 3, exaggeration: 1, water }, roads);
    const m = parse(modelXml(t, 'Test & "town"', 'a test'));
    expect(m.triangles.length).toBe(t.count);
    expect(closedByIndex(m)).toBe(true);
    expect(filamentAt(m, mm(60), mm(60))).toBe(DEFAULT_FILAMENTS[PAINT.buildings]); // a roof
    expect(filamentAt(m, mm(100), mm(-10))).toBe(DEFAULT_FILAMENTS[PAINT.roads]); // the east-west road
    expect(filamentAt(m, mm(80), mm(-180))).toBe(DEFAULT_FILAMENTS[PAINT.water]); // the river
    expect(filamentAt(m, mm(-120), mm(-60))).toBe(1); // plain ground
    // both slicers' attributes, always the same code
    for (const tri of m.triangles) expect(tri.prusa).toBe(tri.paint);
  });

  it('leaves the buried undersides of buildings and roads unpainted', () => {
    const { grid, water } = riverTown();
    const t = buildPrint(grid, buildings, { sideMm: 100, baseMm: 3, exaggeration: 1, water }, roads);
    const d = t.data;
    for (let k = 0; k < t.count; k++) {
      const p = k * 9;
      const nz = (d[p + 3] - d[p]) * (d[p + 7] - d[p + 1]) - (d[p + 4] - d[p + 1]) * (d[p + 6] - d[p]);
      if (nz < -1e-9) expect(t.paint[k]).toBe(0);
    }
  });

  it('paints sunken road floors and their walls, and the water around them', () => {
    const { grid, water } = riverTown();
    const t = buildPrint(grid, buildings, { sideMm: 100, baseMm: 3, exaggeration: 1, water, sinkRoadsMm: 0.6 }, roads);
    expect(t.roadsRaisedInstead).toBe(false);
    const m = parse(modelXml(t, 'Test', 'a test'));
    expect(closedByIndex(m)).toBe(true);
    expect(filamentAt(m, mm(100), mm(-10))).toBe(DEFAULT_FILAMENTS[PAINT.roads]);
    expect(filamentAt(m, mm(-10), mm(-180))).toBe(DEFAULT_FILAMENTS[PAINT.roads]); // the road through the river
    expect(filamentAt(m, mm(80), mm(-180))).toBe(DEFAULT_FILAMENTS[PAINT.water]);
    expect(filamentAt(m, mm(-120), mm(60))).toBe(1);
  });

  it('paints level roads flush with the ground, without lowering or raising them', () => {
    const { grid, water } = riverTown();
    const painted = buildPrint(grid, [], { sideMm: 100, baseMm: 3, exaggeration: 1, water, paintRoads: true }, roads);
    const plain = buildPrint(grid, [], { sideMm: 100, baseMm: 3, exaggeration: 1, water }, []);
    expect(painted.roadsRaisedInstead).toBe(false);
    const m = parse(modelXml(painted, 'Test', 'a test'));
    const p = parse(modelXml(plain, 'Test', 'a test'));
    expect(closedByIndex(m)).toBe(true);
    expect(filamentAt(m, mm(100), mm(-10))).toBe(DEFAULT_FILAMENTS[PAINT.roads]);
    expect(filamentAt(m, mm(-10), mm(60))).toBe(DEFAULT_FILAMENTS[PAINT.roads]);
    expect(filamentAt(m, mm(80), mm(-180))).toBe(DEFAULT_FILAMENTS[PAINT.water]);
    expect(filamentAt(m, mm(-120), mm(60))).toBe(1);
    // the same ground as without roads, to a few micrometres (cut faces may span a cell's diagonal)
    const height = (mesh: Mesh, x: number, y: number) => {
      let best = -Infinity;
      for (const t of mesh.triangles) {
        const [[ax, ay, az], [bx, by, bz], [cx, cy, cz]] = t.v.map((i) => mesh.vertices[i]);
        const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (den <= 1e-12) continue;
        const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den;
        const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
        if (l1 < -1e-9 || l2 < -1e-9 || 1 - l1 - l2 < -1e-9) continue;
        best = Math.max(best, l1 * az + l2 * bz + (1 - l1 - l2) * cz);
      }
      return best;
    };
    for (const [x, y] of [[100, -10], [-10, 60], [-10, -8], [37, -4.5], [-120, 60]]) expect(height(m, mm(x), mm(y))).toBeCloseTo(height(p, mm(x), mm(y)), 2);
  });

  it('paints parks and woods like the ground by default, or in any filament chosen per part', () => {
    const { grid, water } = riverTown();
    // a park in the north-west, away from the river and the roads
    const green = new Uint8Array(grid.n * grid.n);
    const step = grid.sizeM / (grid.n - 1);
    for (let j = 0; j < grid.n; j++) for (let i = 0; i < grid.n; i++) {
      const x = -200 + i * step;
      const y = -200 + j * step;
      green[j * grid.n + i] = x < -60 && y > 40 ? 1 : 0;
    }
    const t = buildPrint(grid, buildings, { sideMm: 100, baseMm: 3, exaggeration: 1, water, green, paintRoads: true }, roads);
    const park: [number, number] = [mm(-140), mm(140)];
    expect(filamentAt(parse(modelXml(t, 'Test', 'a test')), ...park)).toBe(1); // four filaments by default
    const standard = parse(modelXml(t, 'Test', 'a test', [1, 2, 3, 4, 5]));
    expect(closedByIndex(standard)).toBe(true);
    expect(filamentAt(standard, ...park)).toBe(5);
    expect(filamentAt(standard, mm(80), mm(-180))).toBe(4); // the river
    // no water here? parks on 4; roads like the ground (unpainted); buildings on 3
    const mine = parse(modelXml(t, 'Test', 'a test', [1, 3, 1, 4, 4]));
    expect(filamentAt(mine, ...park)).toBe(4);
    expect(filamentAt(mine, mm(80), mm(-180))).toBe(4);
    expect(filamentAt(mine, mm(100), mm(-10))).toBe(1);
    expect(filamentAt(mine, mm(60), mm(60))).toBe(3);
    expect(mine.triangles.filter((x) => x.paint).length).toBeLessThan(standard.triangles.filter((x) => x.paint).length);
  });

  it('paints the water in every tile that has some', () => {
    const { grid, water } = riverTown();
    const tiles = buildTiledPrint(grid, [], { sideMm: 100, baseMm: 3, exaggeration: 1, water, tiles: 2 }, []);
    const wet = (name: string) => {
      const tile = tiles.find((x) => x.name === name)!;
      return Array.from(tile.tris.paint.subarray(0, tile.tris.count)).filter((p) => p === PAINT.water).length;
    };
    // row B is the south, where the river is
    expect(wet('B1')).toBeGreaterThan(50);
    expect(wet('B2')).toBeGreaterThan(50);
    expect(wet('A1')).toBe(0);
    expect(wet('A2')).toBe(0);
  });

  it('puts the title letters in the buildings’ filament, the ledge in the ground’s', () => {
    const t = new Triangles();
    expect(addLabel(t, font, ['AB'], 100, 3)).not.toBeNull();
    const painted = Array.from(t.paint.subarray(0, t.count));
    expect(painted.some((p) => p === PAINT.buildings)).toBe(true);
    expect(painted.every((p) => p === 0 || p === PAINT.buildings)).toBe(true);
  });

  it('packs a 3MF: content types, relationships and the model, compressed', async () => {
    const { grid, water } = riverTown();
    const t = buildPrint(grid, buildings, { sideMm: 100, baseMm: 3, exaggeration: 1, water }, roads);
    const zip = await to3mf(t, 'Test', 'a test');
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const files = new Map<string, Uint8Array>();
    let p = 0;
    while (v.getUint32(p, true) === 0x04034b50) {
      const method = v.getUint16(p + 8, true);
      const size = v.getUint32(p + 18, true);
      const nameLen = v.getUint16(p + 26, true);
      const name = new TextDecoder().decode(zip.subarray(p + 30, p + 30 + nameLen));
      const body = zip.subarray(p + 30 + nameLen, p + 30 + nameLen + size);
      files.set(name, method === 8 ? await inflate(body) : body);
      p += 30 + nameLen + size;
    }
    expect([...files.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
    const model = new TextDecoder().decode(files.get('3D/3dmodel.model'));
    expect(model).toBe(modelXml(t, 'Test', 'a test'));
    expect(zip.length).toBeLessThan(model.length / 3);
    expect(new TextDecoder().decode(files.get('_rels/.rels'))).toContain('Target="/3D/3dmodel.model"');
  });
});
