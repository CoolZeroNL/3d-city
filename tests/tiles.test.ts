import { describe, expect, it } from 'vitest';
import geojsonvt from 'geojson-vt';
import { fromGeojsonVt } from 'vt-pbf';
import { decodeTile, parseTiles, tileBounds, tilesForSquare, type LoadedTile, type TileRef } from '../src/geo/tiles';
import { makeProjector, type LngLat } from '../src/geo/projection';
import { signedArea, type Polygon } from '../src/geo/polygon';

const C: LngLat = { lat: 48.4967, lon: 11.7704 };
const proj = makeProjector(C);
const ll = (e: number, n: number): [number, number] => {
  const p = proj.toLngLat(e, n);
  return [p.lon, p.lat];
};
const box = (e: number, n: number, w: number, d: number) => [[ll(e, n), ll(e + w, n), ll(e + w, n + d), ll(e, n + d), ll(e, n)]];
const fc = (features: unknown[]) => ({ type: 'FeatureCollection', features });
const feat = (geometry: unknown, properties: Record<string, unknown> = {}) => ({ type: 'Feature', properties, geometry });

/** Encode GeoJSON layers into real vector tiles (as the CDN would serve them). */
function makeTiles(layers: Record<string, ReturnType<typeof fc>>, refs: TileRef[]): LoadedTile[] {
  const indexes = Object.fromEntries(Object.entries(layers).map(([k, v]) => [k, geojsonvt(v, { maxZoom: 14, indexMaxZoom: 0, extent: 4096, buffer: 64, tolerance: 0 })]));
  return refs.map((r) => {
    const tileLayers: Record<string, unknown> = {};
    for (const [k, idx] of Object.entries(indexes)) {
      const t = idx.getTile(r.z, r.x, r.y);
      if (t) tileLayers[k] = t;
    }
    return { ...r, tile: decodeTile(fromGeojsonVt(tileLayers, { version: 2, extent: 4096 })) };
  });
}

const area = (p: Polygon) => Math.abs(signedArea(p.outer)) - p.holes.reduce((a, h) => a + Math.abs(signedArea(h)), 0);

describe('vector tile data', () => {
  const refs = tilesForSquare(C, 2000, 14);

  it('covers the square with z14 tiles', () => {
    expect(refs.length).toBeGreaterThanOrEqual(4);
    expect(refs.length).toBeLessThanOrEqual(9);
    const bounds = refs.map((r) => tileBounds(r, proj));
    expect(Math.min(...bounds.map((b) => b[0]))).toBeLessThanOrEqual(-1000);
    expect(Math.max(...bounds.map((b) => b[2]))).toBeGreaterThanOrEqual(1000);
  });

  it('splits merged multipolygons into buildings, keeps heights, skips hide_3d outlines', () => {
    const tiles = makeTiles(
      {
        building: fc([
          feat({ type: 'MultiPolygon', coordinates: [box(100, 100, 20, 10), box(200, 100, 10, 10)] }, { render_height: 12, render_min_height: 0 }),
          feat({ type: 'Polygon', coordinates: box(-300, -300, 30, 30) }, { render_height: 30, render_min_height: 10 }),
          feat({ type: 'Polygon', coordinates: box(-300, 300, 30, 30) }, { render_height: 20, hide_3d: true }),
        ]),
      },
      refs,
    );
    const d = parseTiles(tiles, C, 2000);
    expect(d.buildings).toHaveLength(3);
    const tall = d.buildings.find((b) => b.height === 30)!;
    expect(tall.minHeight).toBe(10);
    expect(area(tall.poly)).toBeGreaterThan(850);
    expect(area(tall.poly)).toBeLessThan(950);
    expect(d.buildings.filter((b) => b.height === 12)).toHaveLength(2);
  });

  it('neither doubles nor splits buildings that cross a tile edge or sit in neighbours’ buffers', () => {
    // find the vertical edge between two tiles near the centre and straddle it
    const b = tileBounds(refs[0], proj);
    const edgeE = b[2];
    const tiles = makeTiles({ building: fc([feat({ type: 'Polygon', coordinates: box(edgeE - 20, b[1] + 200, 40, 20) }, { render_height: 9 })]) }, refs);
    const d = parseTiles(tiles, C, 4000);
    const total = d.buildings.reduce((a, x) => a + area(x.poly), 0);
    expect(d.buildings.length).toBe(1); // cut by the tiles, joined again
    expect(total).toBeGreaterThan(760);
    expect(total).toBeLessThan(840); // ≈ 40 × 20 m, not twice that
  });

  it('maps roads, water, the sea, green areas and places', () => {
    const tiles = makeTiles(
      {
        transportation: fc([
          feat({ type: 'LineString', coordinates: [ll(-500, 0), ll(500, 0)] }, { class: 'primary' }),
          feat({ type: 'LineString', coordinates: [ll(-500, 50), ll(500, 50)] }, { class: 'minor', brunnel: 'tunnel' }),
          feat({ type: 'LineString', coordinates: [ll(0, -500), ll(0, 500)] }, { class: 'rail', subclass: 'rail' }),
          feat({ type: 'Polygon', coordinates: box(50, 50, 40, 40) }, { class: 'path', subclass: 'pedestrian' }),
        ]),
        water: fc([
          feat({ type: 'Polygon', coordinates: box(-900, -900, 1800, 200) }, { class: 'ocean' }),
          feat({ type: 'Polygon', coordinates: box(300, 300, 50, 50) }, { class: 'lake' }),
        ]),
        waterway: fc([feat({ type: 'LineString', coordinates: [ll(-500, 400), ll(500, 420)] }, { class: 'river' })]),
        landcover: fc([feat({ type: 'Polygon', coordinates: box(-400, 200, 100, 100) }, { class: 'wood', subclass: 'forest' })]),
        place: fc([
          feat({ type: 'Point', coordinates: ll(0, 0) }, { class: 'village', name: 'Kleinfelde' }),
          feat({ type: 'Point', coordinates: ll(4000, 4000) }, { class: 'hamlet', name: 'Hof Nord' }),
        ]),
      },
      refs,
    );
    const d = parseTiles(tiles, C, 2000);
    const kinds = d.features.lines.map((l) => l.kind);
    expect(kinds).toContain('primary');
    expect(kinds).toContain('rail');
    expect(kinds).toContain('river');
    expect(kinds).not.toContain('minor'); // tunnel
    const areaKinds = new Set(d.features.areas.map((a) => a.kind));
    expect([...areaKinds].sort()).toEqual(['forest', 'plaza', 'water']);
    expect(d.features.sea?.length).toBeGreaterThan(0);
    const names = d.settlements.map((s) => s.name).sort();
    expect(names).toEqual(['Kleinfelde']); // Hof Nord lies outside these tiles
    expect(d.settlements[0].distanceM).toBeLessThan(5);
  });
});
