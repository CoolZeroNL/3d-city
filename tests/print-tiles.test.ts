import { describe, expect, it } from 'vitest';
import { buildTiledPrint, tileName } from '../src/export/tiles';
import { crc32, makeZip } from '../src/export/zip';
import type { Triangles } from '../src/export/stl';
import type { HeightGrid } from '../src/geo/terrain';

/** Every directed edge used exactly once, and its reverse too: each shell is closed. */
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

/** Terrain-top vertices on one edge of a tile (x = ±half), as "y,z" strings. */
function edgeProfile(t: Triangles, x: number, base: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < t.count * 9; i += 3) {
    if (Math.abs(t.data[i] - x) < 1e-4 && t.data[i + 2] > base + 1e-3) out.add(`${t.data[i + 1].toFixed(3)},${t.data[i + 2].toFixed(3)}`);
  }
  return out;
}

function zRange(t: Triangles): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 2; i < t.count * 9; i += 3) {
    lo = Math.min(lo, t.data[i]);
    hi = Math.max(hi, t.data[i]);
  }
  return [lo, hi];
}

/** A 1 km square of rolling hills, 33 × 33 points. */
function hills(): HeightGrid {
  const n = 33;
  const sizeM = 1000;
  const elev = new Float32Array(n * n);
  const step = sizeM / (n - 1);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const e = -500 + i * step;
      const m = -500 + j * step;
      elev[j * n + i] = 100 + 30 * Math.sin(e / 140) * Math.cos(m / 170) + 0.02 * e;
    }
  }
  return { n, sizeM, elev, min: Math.min(...elev), max: Math.max(...elev), zoom: 15 };
}

const square = (cx: number, cy: number, w: number, top: number) => ({
  poly: { outer: [[cx - w / 2, cy - w / 2], [cx + w / 2, cy - w / 2], [cx + w / 2, cy + w / 2], [cx - w / 2, cy + w / 2]] as [number, number][], holes: [] },
  top,
});

describe('a print in tiles', () => {
  // a tall tower in the north-west, a hall across the middle (on the seam of a 2 × 2 split)
  const buildings = [square(-300, 300, 40, 150), square(0, -100, 80, 70), square(250, -250, 30, 60)];
  const opts = { sideMm: 100, baseMm: 3, exaggeration: 1.5 };

  for (const n of [2, 3, 8]) {
    it(`splits into ${n} × ${n} closed tiles that meet edge to edge on one base`, () => {
      const tiles = buildTiledPrint(hills(), buildings, { ...opts, tiles: n });
      expect(tiles.map((t) => t.name)).toEqual(Array.from({ length: n * n }, (_, k) => tileName(Math.floor(k / n), k % n)));
      for (const t of tiles) {
        expect(t.tris.skipped).toBe(0);
        expect(closedShells(t.tris)).toBe(true);
        expect(zRange(t.tris)[0]).toBeCloseTo(-3, 5); // every tile stands on the same base
      }
      const at = (row: number, col: number) => tiles[row * n + col].tris;
      for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
          if (col + 1 < n) expect(edgeProfile(at(row, col), 50, -3)).toEqual(edgeProfile(at(row, col + 1), -50, -3));
        }
      }
      // north–south seams: compare along x, the same way
      const profileNS = (t: Triangles, y: number) => {
        const out = new Set<string>();
        for (let i = 0; i < t.count * 9; i += 3) {
          if (Math.abs(t.data[i + 1] - y) < 1e-4 && t.data[i + 2] > -3 + 1e-3) out.add(`${t.data[i].toFixed(3)},${t.data[i + 2].toFixed(3)}`);
        }
        return out;
      };
      for (let row = 0; row + 1 < n; row++) expect(profileNS(at(row, 0), -50)).toEqual(profileNS(at(row + 1, 0), 50));
    });
  }

  it('names tiles from the north-west and cuts buildings exactly at the seams', () => {
    const tiles = buildTiledPrint(hills(), buildings, { ...opts, tiles: 2 });
    const top = (name: string) => zRange(tiles.find((t) => t.name === name)!.tris)[1];
    // the 150 m tower stands in A1, the north-west quarter: 150 m × 0.2 mm/m = 30 mm
    expect(top('A1')).toBeGreaterThan(29);
    expect(Math.max(top('A2'), top('B1'), top('B2'))).toBeLessThan(25);
    // the hall across the centre shows up in all four tiles, reaching each tile's inner edges
    for (const t of tiles) {
      let reach = 0;
      for (let i = 0; i < t.tris.count * 9; i += 3) if (t.tris.data[i + 2] > 13.5) reach = Math.max(reach, Math.abs(t.tris.data[i]), Math.abs(t.tris.data[i + 1]));
      expect(reach).toBeGreaterThan(49.9);
    }
  });

  it('as one tile, is the same as a single print', () => {
    const [one] = buildTiledPrint(hills(), buildings, { ...opts, tiles: 1 });
    expect(one.name).toBe('A1');
    expect(closedShells(one.tris)).toBe(true);
  });
});

describe('the ZIP archive', () => {
  it('computes CRC-32 as ZIP does', () => {
    expect(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });

  it('lists every file with its size and checksum, readable back', () => {
    const files = [
      { name: 'tile-A1.stl', data: new Uint8Array([1, 2, 3, 4, 5]) },
      { name: 'README.txt', data: new TextEncoder().encode('A1 is the north-west corner.') },
    ];
    const zip = makeZip(files);
    const v = new DataView(zip.buffer);
    const end = zip.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    expect(v.getUint16(end + 10, true)).toBe(2);
    let p = v.getUint32(end + 16, true);
    for (const f of files) {
      expect(v.getUint32(p, true)).toBe(0x02014b50);
      const nameLen = v.getUint16(p + 28, true);
      expect(new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen))).toBe(f.name);
      expect(v.getUint32(p + 16, true)).toBe(crc32(f.data));
      const local = v.getUint32(p + 42, true);
      expect(v.getUint32(local, true)).toBe(0x04034b50);
      const start = local + 30 + v.getUint16(local + 26, true);
      expect([...zip.subarray(start, start + f.data.length)]).toEqual([...f.data]);
      p += 46 + nameLen;
    }
  });
});
