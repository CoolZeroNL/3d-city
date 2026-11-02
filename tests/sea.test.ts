import { describe, expect, it } from 'vitest';
import { computeSeaMask, isSea, seaShare } from '../src/geo/sea';
import type { Pt } from '../src/geo/polygon';

describe('sea from coastlines', () => {
  it('fills the right-hand side of the coastline (OSM convention)', () => {
    // heading east → water on the right = south
    const coast: Pt[] = [
      [-700, 0],
      [700, 0],
    ];
    const m = computeSeaMask([coast], 1000, 256)!;
    expect(isSea(m, 0, -250)).toBe(true);
    expect(isSea(m, 0, 250)).toBe(false);
    expect(seaShare(m)).toBeGreaterThan(0.45);
    expect(seaShare(m)).toBeLessThan(0.55);
  });

  it('follows the direction: heading west puts the sea in the north', () => {
    const m = computeSeaMask([[[700, 100], [-700, 100]]], 1000, 256)!;
    expect(isSea(m, 0, 300)).toBe(true);
    expect(isSea(m, 0, -300)).toBe(false);
  });

  it('keeps an island dry (counter-clockwise ring: land on the left, inside)', () => {
    const island: Pt[] = [
      [-200, -200],
      [200, -200],
      [200, 200],
      [-200, 200],
      [-200, -200],
    ];
    const m = computeSeaMask([island], 1000, 256)!;
    expect(isSea(m, 0, 0)).toBe(false);
    expect(isSea(m, 400, 400)).toBe(true);
    expect(isSea(m, -400, -400)).toBe(true);
  });

  it('handles coastlines that are mostly outside the square and gives up without any', () => {
    const m = computeSeaMask([[[-5000, -400], [5000, -400]]], 1000, 128)!;
    expect(isSea(m, 0, -450)).toBe(true);
    expect(isSea(m, 0, 0)).toBe(false);
    expect(computeSeaMask([], 1000, 128)).toBeNull();
    expect(computeSeaMask([[[-5000, 4000], [5000, 4000]]], 1000, 128)).toBeNull();
  });
});
