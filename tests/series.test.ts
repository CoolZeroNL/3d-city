import { describe, expect, it } from 'vitest';
import { makeProjector } from '../src/geo/projection';
import { decodeSeries, encodeSeries, referenceHeight, seriesCenter, squareLabel, withReference, type Series } from '../src/geo/series';
import { decodeState, encodeState, DEFAULT_STATE } from '../src/state';

const base: Series = { origin: { lat: 48.7765, lon: 9.1772 }, i: 0, j: 0, ref: 180, n: 385, z: 15, mm: 200, ex: 1.5 };

describe('a bigger map of squares side by side', () => {
  it('puts the next square one square further, so neighbours share an edge', () => {
    const size = 4000;
    const a = seriesCenter(base, size);
    const east = seriesCenter({ ...base, i: 1 }, size);
    expect(a).toEqual(base.origin);
    // the east edge of the first square is the west edge of its neighbour, at every height along it
    for (const n of [-2000, 0, 2000]) {
      const edgeA = makeProjector(a).toLngLat(2000, n);
      const edgeB = makeProjector(east).toLngLat(-2000, n);
      expect(Math.abs(edgeA.lon - edgeB.lon) * makeProjector(a).mPerDegLon).toBeLessThan(0.01);
      expect(Math.abs(edgeA.lat - edgeB.lat) * makeProjector(a).mPerDegLat).toBeLessThan(0.01);
    }
    // a square north: its south edge is the first one's north edge (to well under a metre)
    const north = seriesCenter({ ...base, j: 1 }, size);
    const top = makeProjector(a).toLngLat(0, 2000);
    const bottom = makeProjector(north).toLngLat(0, -2000);
    expect(Math.abs(top.lat - bottom.lat) * makeProjector(a).mPerDegLat).toBeLessThan(0.5);
  });

  it('names a square by where it sits from the first one', () => {
    expect(squareLabel(0, 0)).toBe('E0 N0');
    expect(squareLabel(1, 0)).toBe('E1 N0');
    expect(squareLabel(-2, -1)).toBe('W2 S1');
  });

  it('sets the base a little below the lowest ground, in whole 10 m', () => {
    expect(referenceHeight(243.7)).toBe(220);
    expect(referenceHeight(0)).toBe(-20);
    expect(referenceHeight(-3)).toBe(-30);
  });

  it('measures heights from the base and flattens ground that dips below it', () => {
    const grid = { n: 2, sizeM: 100, elev: Float32Array.from([170, 200, 250, 190]), min: 170, max: 250, zoom: 15 };
    const g = withReference(grid, 180);
    expect([...g.elev]).toEqual([180, 200, 250, 190]);
    expect(g.min).toBe(180);
    expect(grid.elev[0]).toBe(170);
  });

  it('round-trips through the link, and its square decides the centre', () => {
    const s = { ...base, i: -1, j: 2 };
    expect(decodeSeries(encodeSeries(s))).toEqual(s);
    expect(decodeSeries('1,2,3')).toBeNull();
    expect(decodeSeries('48.7,9.1,0,0,180,385,15,120,1.5')).toBeNull(); // not a print size
    expect(decodeSeries('48.7,9.1,999,0,180,385,15,200,1.5')).toBeNull(); // too far
    const hash = encodeState({ ...DEFAULT_STATE, center: seriesCenter(s, 2000), size: 2000, exaggeration: 1.5, series: s });
    expect(hash).toContain('ser=');
    const back = decodeState(`#${hash}`);
    expect(back.series).toEqual(s);
    expect(back.center).toEqual(seriesCenter(s, 2000));
    // a link whose lat/lon were rounded still opens the exact square
    const nudged = decodeState(`#${hash.replace(/lat=[^&]+/, 'lat=48.70000')}`);
    expect(nudged.center).toEqual(seriesCenter(s, 2000));
  });
});
