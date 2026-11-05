import { describe, expect, it } from 'vitest';
import { removeRoofBumps, type Footprint } from '../src/geo/surface';
import { sampleGrid, type HeightGrid } from '../src/geo/terrain';

const SIZE = 1000;
const N = 129;

/** A grid from a height function of local (east, north) metres. */
function grid(f: (e: number, n: number) => number): HeightGrid {
  const elev = new Float32Array(N * N);
  const step = SIZE / (N - 1);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) elev[j * N + i] = f(-SIZE / 2 + i * step, -SIZE / 2 + j * step);
  let min = Infinity;
  let max = -Infinity;
  for (const v of elev) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return { n: N, sizeM: SIZE, elev, min, max, zoom: 15 };
}

const square = (cx: number, cy: number, w: number, height: number): Footprint => ({
  poly: { outer: [[cx - w / 2, cy - w / 2], [cx + w / 2, cy - w / 2], [cx + w / 2, cy + w / 2], [cx - w / 2, cy + w / 2]], holes: [] },
  height,
});
const bump = (e: number, n: number, cx: number, cy: number, top: number, sigma: number) => top * Math.exp(-((e - cx) ** 2 + (n - cy) ** 2) / (2 * sigma * sigma));

// twelve 40 × 40 m buildings, 20 m tall, spread over the square
const SPOTS: [number, number][] = [];
for (const x of [-300, -100, 100, 300]) for (const y of [-300, 0, 300]) SPOTS.push([x, y]);
const halls = SPOTS.map(([x, y]) => square(x, y, 40, 20));
/** surface-model data: each hall leaves a smooth 18 m bump */
const roofs = (e: number, n: number) => SPOTS.reduce((s, [x, y]) => s + bump(e, n, x, y, 18, 22), 0);

describe('roof bumps in surface-model elevation data', () => {
  it('lowers the ground under buildings where the data measured roofs', () => {
    const g = grid((e, n) => 10 + roofs(e, n));
    const r = removeRoofBumps(g, halls);
    expect(r.applied).toBe(true);
    expect(r.bumped).toBe(12);
    for (const [x, y] of SPOTS) expect(sampleGrid(g, x, y)).toBeLessThan(11.5);
    expect(sampleGrid(g, 200, 150)).toBeCloseTo(10, 3); // open ground between them is untouched
  });

  it('leaves bare-ground data alone, castle hill included', () => {
    // flat ground with no bumps under the halls, and a castle on an 80 m hill
    const hill = (e: number, n: number) => bump(e, n, 0, 150, 80, 90);
    const g = grid((e, n) => 10 + hill(e, n));
    const before = g.elev.slice();
    const r = removeRoofBumps(g, [...halls, square(0, 150, 50, 20)]);
    expect(r.applied).toBe(false);
    expect(g.elev).toEqual(before);
  });

  it('keeps a real hill under a building even where the data measured roofs', () => {
    const hill = (e: number, n: number) => bump(e, n, 0, 150, 80, 90);
    const g = grid((e, n) => 10 + roofs(e, n) + hill(e, n));
    const top = sampleGrid(g, 0, 150);
    const r = removeRoofBumps(g, [...halls, square(0, 150, 50, 20)]);
    expect(r.applied).toBe(true);
    expect(sampleGrid(g, 0, 150)).toBeCloseTo(top, 3); // 80 m is no roof of a 20 m castle
  });

  it('handles a town on a slope: no roofs, no change; roofs, removed', () => {
    const slope = (e: number, n: number) => 100 + 0.1 * e + 0.05 * n; // a 10% hillside
    const plain = grid(slope);
    const before = plain.elev.slice();
    expect(removeRoofBumps(plain, halls).applied).toBe(false);
    expect(plain.elev).toEqual(before);

    const roofed = grid((e, n) => slope(e, n) + roofs(e, n));
    expect(removeRoofBumps(roofed, halls).applied).toBe(true);
    for (const [x, y] of SPOTS) expect(Math.abs(sampleGrid(roofed, x, y) - slope(x, y))).toBeLessThan(3);
  });

  it('also reaches roofs at the edge of the model', () => {
    const edge: [number, number] = [470, -150];
    const g = grid((e, n) => 10 + roofs(e, n) + bump(e, n, edge[0], edge[1], 18, 22));
    const r = removeRoofBumps(g, [...halls, square(edge[0], edge[1], 40, 20)]);
    expect(r.applied).toBe(true);
    expect(sampleGrid(g, edge[0], edge[1])).toBeLessThan(12);
  });

  it('lowers a podium under its neighbouring tower\'s bump', () => {
    // a 20 m podium beside a 200 m tower; the radar saw the tower and left a 60 m bump over both
    const podium = square(-200, 150, 50, 20);
    const tower = square(-150, 150, 30, 200);
    const g = grid((e, n) => 10 + roofs(e, n) + bump(e, n, -175, 150, 60, 30));
    const before = sampleGrid(g, -200, 150);
    const r = removeRoofBumps(g, [...halls, podium, tower]);
    expect(r.applied).toBe(true);
    // from about 52 m to within a few metres of street level (the tower's wide bump lifts the street ring a little)
    expect(sampleGrid(g, -200, 150)).toBeLessThan(before - 30);
    expect(sampleGrid(g, -200, 150)).toBeLessThan(20);
    expect(r.remaining).toBeLessThan(r.bumped);
  });

  it('takes unmapped buildings out of their roof bumps and gives them the measured height', () => {
    // OpenStreetMap has no height for these 25 m halls: the tiles say 5 m
    const unknown = SPOTS.map(([x, y]) => ({ ...square(x, y, 40, 5), heightKnown: false }));
    const g = grid((e, n) => 10 + SPOTS.reduce((s, [x, y]) => s + bump(e, n, x, y, 25, 22), 0));
    const r = removeRoofBumps(g, unknown);
    expect(r.applied).toBe(true);
    for (const [x, y] of SPOTS) expect(sampleGrid(g, x, y)).toBeLessThan(11.5);
    expect(r.heights.size).toBe(12);
    for (const h of r.heights.values()) expect(h).toBeGreaterThan(15); // the smoothed bump, a little under the roof
  });

  it('keeps a castle hill under a building without a known height', () => {
    const hill = (e: number, n: number) => bump(e, n, 0, 150, 80, 90);
    const g = grid((e, n) => 10 + roofs(e, n) + hill(e, n));
    const top = sampleGrid(g, 0, 150);
    const r = removeRoofBumps(g, [...halls, { ...square(0, 150, 50, 5), heightKnown: false }]);
    expect(r.applied).toBe(true);
    expect(sampleGrid(g, 0, 150)).toBeCloseTo(top, 3);
    expect(r.heights.has(halls.length)).toBe(false);
  });

  it('lowers roofs near a bluff: the ground drops on one side only, unlike a hill', () => {
    // a plateau at 40 m whose northern edge falls to 10 m between 150 and 250 m north
    const bluff = (n: number) => 10 + 30 * (1 - Math.min(1, Math.max(0, (n - 150) / 100)) ** 2 * (3 - 2 * Math.min(1, Math.max(0, (n - 150) / 100))));
    const nearEdge = square(0, 70, 40, 20);
    const g = grid((e, n) => bluff(n) + roofs(e, n) + bump(e, n, 0, 70, 18, 22));
    const r = removeRoofBumps(g, [...halls, nearEdge]);
    expect(r.applied).toBe(true);
    expect(sampleGrid(g, 0, 70)).toBeLessThan(41.5); // back to the plateau, no pit either
    expect(sampleGrid(g, 0, 70)).toBeGreaterThan(38);
    expect(sampleGrid(g, 0, 400)).toBeCloseTo(10, 3); // the low ground stays
  });
});
