import { describe, expect, it } from 'vitest';
import fontData from '../src/export/glyphs/inter-bold.json';
import { addLabel, LEDGE_MM, LETTER_RAISE_MM, textPolygons, type GlyphFont } from '../src/export/label';
import { addSolid, buildPrint, Triangles } from '../src/export/stl';
import type { HeightGrid } from '../src/geo/terrain';

const font = fontData as unknown as GlyphFont;

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

function bounds(t: Triangles) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.count * 9; i += 3) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], t.data[i + a]);
      hi[a] = Math.max(hi[a], t.data[i + a]);
    }
  }
  return { lo, hi };
}

const flat = (sizeM: number): HeightGrid => ({ n: 5, sizeM, elev: new Float32Array(25).fill(100), min: 100, max: 100, zoom: 15 });

describe('raised title on the 3D print', () => {
  it('builds every character as closed solids, at the smallest size we print', () => {
    const chars = Object.keys(font.glyphs).filter((c) => c.trim());
    const t = new Triangles();
    chars.forEach((ch, i) => {
      const { polys } = textPolygons(font, ch, 2.4); // the second line on a 10 cm print
      for (const p of polys) {
        const move = (r: [number, number][]) => r.map(([x, y]) => [x + (i % 40) * 5, y + Math.floor(i / 40) * 5] as [number, number]);
        addSolid(t, { outer: move(p.outer), holes: p.holes.map(move) }, 1, 0);
      }
    });
    expect(chars.length).toBeGreaterThan(300);
    expect(t.skipped).toBe(0);
    expect(closedShells(t)).toBe(true);
  });

  it('adds a ledge with one or two lines in front of the model', () => {
    const t = buildPrint(flat(2000), [], { sideMm: 150, baseMm: 3, exaggeration: 1 });
    const r = addLabel(t, font, ['Where we met', 'June 2019 · Ölfjörður'], 150, 3);
    expect(r).not.toBeNull();
    expect(r!.missing).toEqual([]);
    expect(r!.capMm[0]).toBeCloseTo(6, 6);
    expect(t.skipped).toBe(0);
    expect(closedShells(t)).toBe(true);
    const { lo, hi } = bounds(t);
    expect(lo[1]).toBeCloseTo(-75 - r!.depthMm, 3); // the ledge reaches out in front (south)
    expect(hi[1]).toBeCloseTo(75, 3); // nothing sticks out behind
    expect(lo[2]).toBeCloseTo(-3, 3); // still standing on the base
    expect(hi[2]).toBeCloseTo(-3 + LEDGE_MM + LETTER_RAISE_MM, 3);
  });

  it('shrinks a long line to the width and reports characters it cannot print', () => {
    const t = new Triangles();
    const r = addLabel(t, font, ['The street I grew up on, a long time ago, in a town far away → 1987'], 100, 3)!;
    expect(r.missing).toEqual(['→']);
    expect(r.capMm[0]).toBeLessThan(4);
    const { lo, hi } = bounds(t);
    expect(hi[0] - lo[0]).toBeLessThanOrEqual(100);
    expect(addLabel(new Triangles(), font, ['  ', ''], 100, 3)).toBeNull();
  });
});
