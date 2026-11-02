import { describe, expect, it } from 'vitest';
import { heightFromTags, parseLength, resolveHeights, typeDefaultHeight } from '../src/geo/heights';
import { areaKind, buildingsQuery, lineClass, parseBuildings, parseFeatures, type OverpassResponse } from '../src/geo/osm';
import { assembleRings, clipRingToRect, groupPolygons, pointInRing, signedArea, type Ring } from '../src/geo/polygon';
import { lngLatToTile, makeProjector, squareBBox } from '../src/geo/projection';
import { chooseZoom, contourInterval, decodeTerrarium, gridFromMosaic, sampleGrid, SEA_FLOOR } from '../src/geo/terrain';
import { parseCoordinates, photonLabel } from '../src/geo/geocode';

const center = { lat: 52.2647, lon: 10.5236 };

describe('projection', () => {
  it('round-trips local metres and lon/lat', () => {
    const p = makeProjector(center);
    const [e, n] = p.toLocal(10.53, 52.27);
    const back = p.toLngLat(e, n);
    expect(back.lon).toBeCloseTo(10.53, 9);
    expect(back.lat).toBeCloseTo(52.27, 9);
  });

  it('uses roughly the right scale at 52°N', () => {
    const p = makeProjector(center);
    expect(p.mPerDegLat).toBeGreaterThan(111200);
    expect(p.mPerDegLat).toBeLessThan(111300);
    expect(p.mPerDegLon).toBeGreaterThan(68000);
    expect(p.mPerDegLon).toBeLessThan(68500);
  });

  it('builds a square bbox of the requested size', () => {
    const b = squareBBox(center, 2000);
    const p = makeProjector(center);
    const [w, s] = p.toLocal(b.west, b.south);
    const [e, n] = p.toLocal(b.east, b.north);
    expect(e - w).toBeCloseTo(2000, 3);
    expect(n - s).toBeCloseTo(2000, 3);
  });

  it('computes slippy tile coordinates', () => {
    const [x, y] = lngLatToTile(0, 0, 1);
    expect(x).toBeCloseTo(1);
    expect(y).toBeCloseTo(1);
  });
});

describe('terrain', () => {
  it('decodes Terrarium RGB', () => {
    expect(decodeTerrarium(128, 0, 0)).toBe(0);
    expect(decodeTerrarium(128, 100, 128)).toBeCloseTo(100.5);
    expect(decodeTerrarium(127, 255, 0)).toBe(-1);
  });

  it('picks zoom from area size and grid density', () => {
    expect(chooseZoom(52, 2000, 257)).toBe(14);
    expect(chooseZoom(52, 4000, 257)).toBe(13);
    expect(chooseZoom(0, 1000, 257)).toBe(14); // capped
  });

  it('resamples a mosaic into the grid and clamps the sea floor', () => {
    // one tile with a west→east ramp: elevation = column index
    const z = 14;
    const [tx, ty] = lngLatToTile(center.lon, center.lat, z);
    const data = new Float32Array(256 * 256 * 9);
    const width = 256 * 3;
    for (let y = 0; y < 256 * 3; y++) for (let x = 0; x < width; x++) data[y * width + x] = x - 300;
    const g = gridFromMosaic({ z, tx0: Math.floor(tx) - 1, ty0: Math.floor(ty) - 1, cols: 3, rows: 3, data }, center, 1000, 33);
    expect(g.n).toBe(33);
    // west edge lower than east edge, monotonic along a row
    for (let i = 1; i < 33; i++) expect(g.elev[16 * 33 + i]).toBeGreaterThanOrEqual(g.elev[16 * 33 + i - 1]);
    expect(g.min).toBeGreaterThanOrEqual(SEA_FLOOR);
    // sampling the centre matches the middle vertex
    expect(sampleGrid(g, 0, 0)).toBeCloseTo(g.elev[16 * 33 + 16], 4);
  });

  it('scales the contour interval with relief', () => {
    expect(contourInterval(30)).toBe(5);
    expect(contourInterval(120)).toBe(10);
    expect(contourInterval(900)).toBe(20);
  });
});

describe('polygon', () => {
  const square: Ring = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];

  it('computes signed area and containment', () => {
    expect(signedArea(square)).toBe(100);
    expect(signedArea(square.slice().reverse())).toBe(-100);
    expect(pointInRing([5, 5], square)).toBe(true);
    expect(pointInRing([15, 5], square)).toBe(false);
  });

  it('clips to a rectangle', () => {
    const clipped = clipRingToRect(square, 5, -5, 20, 20);
    expect(Math.abs(signedArea(clipped))).toBeCloseTo(50);
  });

  it('assembles rings from unordered, reversed segments', () => {
    const rings = assembleRings([
      [
        [0, 0],
        [10, 0],
      ],
      [
        [10, 10],
        [10, 0],
      ], // reversed
      [
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ]);
    expect(rings).toHaveLength(1);
    expect(Math.abs(signedArea(rings[0]))).toBe(100);
  });

  it('assigns holes to their outer ring with the right orientation', () => {
    const hole: Ring = [
      [2, 2],
      [4, 2],
      [4, 4],
      [2, 4],
    ];
    const [p] = groupPolygons([square.slice().reverse()], [hole]);
    expect(signedArea(p.outer)).toBeGreaterThan(0);
    expect(p.holes).toHaveLength(1);
    expect(signedArea(p.holes[0])).toBeLessThan(0);
  });
});

describe('building heights', () => {
  it('parses OSM length values', () => {
    expect(parseLength('12')).toBe(12);
    expect(parseLength('12.5 m')).toBe(12.5);
    expect(parseLength('12,5')).toBe(12.5);
    expect(parseLength('40 ft')).toBeCloseTo(12.192);
    expect(parseLength("10'")).toBeCloseTo(3.048);
    expect(parseLength('12;15')).toBe(12);
    expect(parseLength('tall')).toBeNull();
    expect(parseLength(undefined)).toBeNull();
  });

  it('follows the spec order: height, then levels × 3 m', () => {
    expect(heightFromTags({ building: 'yes', height: '21', 'building:levels': '3' })).toMatchObject({ height: 21, source: 'height' });
    expect(heightFromTags({ building: 'yes', 'building:levels': '4' })).toMatchObject({ height: 12, source: 'levels' });
    expect(heightFromTags({ building: 'yes', 'building:levels': '2', 'roof:levels': '1' })).toMatchObject({ height: 7.5 });
    expect(heightFromTags({ building: 'yes', min_height: '10', height: '20' })).toMatchObject({ height: 20, minHeight: 10 });
    expect(heightFromTags({ building: 'yes' })).toBeNull();
  });

  it('falls back to a neighbourhood median, flagged as estimated', () => {
    const items = [
      ...[10, 12, 14, 16, 18].map((h, i) => ({ tags: { building: 'yes', height: String(h) }, cx: i * 10, cy: 0 })),
      { tags: { building: 'yes' }, cx: 20, cy: 10 },
      { tags: { building: 'garage' }, cx: 25, cy: 10 },
    ];
    const r = resolveHeights(items);
    expect(r[5]).toMatchObject({ height: 14, source: 'median' });
    expect(r[6]).toMatchObject({ height: typeDefaultHeight('garage'), source: 'default' });
  });

  it('uses type defaults when nothing is known nearby', () => {
    const r = resolveHeights([{ tags: { building: 'house' }, cx: 0, cy: 0 }]);
    expect(r[0]).toMatchObject({ source: 'default', height: typeDefaultHeight('house') });
  });
});

describe('osm parsing', () => {
  const p = makeProjector(center);
  const ll = (e: number, n: number) => p.toLngLat(e, n);
  const ring = (pts: Array<[number, number]>) => [...pts, pts[0]].map(([e, n]) => ll(e, n));

  it('includes ways and multipolygon relations in the buildings query', () => {
    const q = buildingsQuery(squareBBox(center, 2000));
    expect(q).toContain('way["building"]');
    expect(q).toContain('relation["building"]["type"="multipolygon"]');
    expect(q).toContain('out geom');
  });

  it('parses ways, multipolygons with courtyards, clips at the edge and drops outlines with parts', () => {
    const res: OverpassResponse = {
      elements: [
        { type: 'way', id: 1, tags: { building: 'yes' }, geometry: ring([[0, 0], [20, 0], [20, 20], [0, 20]]) },
        {
          type: 'relation',
          id: 2,
          tags: { type: 'multipolygon', building: 'apartments' },
          members: [
            { type: 'way', ref: 10, role: 'outer', geometry: [ll(100, 100), ll(160, 100), ll(160, 160)] },
            { type: 'way', ref: 11, role: 'outer', geometry: [ll(160, 160), ll(100, 160), ll(100, 100)] },
            { type: 'way', ref: 12, role: 'inner', geometry: ring([[120, 120], [140, 120], [140, 140], [120, 140]]) },
          ],
        },
        // straddles the east edge of a 1 km square (edge at +500 m)
        { type: 'way', id: 3, tags: { building: 'yes' }, geometry: ring([[480, 0], [520, 0], [520, 20], [480, 20]]) },
        // outline with a part inside → outline dropped
        { type: 'way', id: 4, tags: { building: 'church' }, geometry: ring([[-200, -200], [-150, -200], [-150, -150], [-200, -150]]) },
        { type: 'way', id: 5, tags: { 'building:part': 'yes', height: '60' }, geometry: ring([[-180, -180], [-170, -180], [-170, -170], [-180, -170]]) },
        { type: 'way', id: 6, tags: { building: 'no' }, geometry: ring([[300, 300], [310, 300], [310, 310], [300, 310]]) },
      ],
    };
    const b = parseBuildings(res, center, 1000);
    const ids = b.map((x) => x.id).sort();
    expect(ids).toEqual(['r2', 'w1', 'w3', 'w5']);
    const court = b.find((x) => x.id === 'r2')!;
    expect(court.poly.holes).toHaveLength(1);
    expect(signedArea(court.poly.outer)).toBeCloseTo(3600, 0);
    const clipped = b.find((x) => x.id === 'w3')!;
    expect(Math.max(...clipped.poly.outer.map(([e]) => e))).toBeLessThanOrEqual(500.0001);
  });

  it('classifies areas and lines', () => {
    expect(areaKind({ natural: 'water' })).toBe('water');
    expect(areaKind({ leisure: 'park' })).toBe('green');
    expect(areaKind({ landuse: 'forest' })).toBe('forest');
    expect(areaKind({ highway: 'residential' })).toBeNull();
    expect(lineClass({ highway: 'primary' })?.[0]).toBe('primary');
    expect(lineClass({ highway: 'primary', tunnel: 'yes' })).toBeNull();
    expect(lineClass({ waterway: 'river', width: '40' })).toEqual(['river', 40]);
  });

  it('parses features into areas and lines', () => {
    const res: OverpassResponse = {
      elements: [
        { type: 'way', id: 1, tags: { leisure: 'park' }, geometry: ring([[0, 0], [50, 0], [50, 50], [0, 50]]) },
        { type: 'way', id: 2, tags: { highway: 'residential' }, geometry: [ll(0, 0), ll(100, 0)] },
        { type: 'way', id: 3, tags: { highway: 'pedestrian', area: 'yes' }, geometry: ring([[0, 0], [10, 0], [10, 10], [0, 10]]) },
      ],
    };
    const f = parseFeatures(res, center);
    expect(f.areas.map((a) => a.kind).sort()).toEqual(['green', 'plaza']);
    expect(f.lines).toHaveLength(1);
    expect(f.lines[0].pts[1][0]).toBeCloseTo(100, 6);
  });
});

describe('geocoding helpers', () => {
  it('reads raw coordinates', () => {
    expect(parseCoordinates('52.26, 10.52')).toEqual({ lat: 52.26, lon: 10.52 });
    expect(parseCoordinates('52.26 10.52')).toEqual({ lat: 52.26, lon: 10.52 });
    expect(parseCoordinates('Main Street 5')).toBeNull();
    expect(parseCoordinates('95, 10')).toBeNull();
  });

  it('builds readable labels from Photon properties', () => {
    expect(photonLabel({ street: 'Bohlweg', housenumber: '30', postcode: '38100', city: 'Braunschweig', country: 'Germany' })).toEqual({
      label: 'Bohlweg 30',
      detail: '38100 Braunschweig, Germany',
    });
    expect(photonLabel({ name: 'Heidelberg', state: 'Baden-Württemberg', country: 'Germany' }).label).toBe('Heidelberg');
  });
});
