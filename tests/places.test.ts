import { afterEach, describe, expect, it, vi } from 'vitest';
import { distanceM, photonPlace, placeKind, resolveToSettlement } from '../src/geo/geocode';
import { compassWord, formatDistance, parseSettlements, pickSettlement, settlementsQuery, type OverpassResponse } from '../src/geo/osm';

const VILLAGE = { lat: 48.4967, lon: 11.7704 };
const POSTCODE_MIDDLE = { lat: 48.4835, lon: 11.7531 };

describe('place kinds', () => {
  it('recognises postcode areas, settlements, areas, streets and addresses', () => {
    expect(placeKind({ osm_key: 'boundary', osm_value: 'postal_code' })).toBe('postcode');
    expect(placeKind({ osm_key: 'place', osm_value: 'postcode' })).toBe('postcode');
    expect(placeKind({ osm_key: 'place', osm_value: 'village' })).toBe('village');
    expect(placeKind({ osm_key: 'place', osm_value: 'neighbourhood' })).toBe('suburb');
    expect(placeKind({ osm_key: 'boundary', osm_value: 'administrative' })).toBe('area');
    expect(placeKind({ osm_key: 'highway', osm_value: 'residential' })).toBe('street');
    expect(placeKind({ osm_key: 'building', osm_value: 'yes', housenumber: '5' })).toBe('address');
    expect(placeKind({ osm_key: 'amenity', osm_value: 'school' })).toBe('poi');
  });

  it('keeps the settlement a postcode result belongs to', () => {
    const p = photonPlace({
      geometry: { coordinates: [POSTCODE_MIDDLE.lon, POSTCODE_MIDDLE.lat] },
      properties: { name: '84999', city: 'Kleinfelde', country: 'Germany', osm_key: 'boundary', osm_value: 'postal_code' },
    });
    expect(p.kind).toBe('postcode');
    expect(p.settlement).toBe('Kleinfelde');
    expect(p.label).toBe('84999');
  });
});

describe('resolving a postcode to its village', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('picks the nearest settlement with the right name and asks only for places', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('osm_tag=place');
      expect(url).toContain('q=Kleinfelde');
      return new Response(
        JSON.stringify({
          features: [
            // same name, far away — must lose
            { geometry: { coordinates: [8.0, 50.0] }, properties: { name: 'Kleinfelde', osm_key: 'place', osm_value: 'village', country: 'Germany' } },
            { geometry: { coordinates: [VILLAGE.lon, VILLAGE.lat] }, properties: { name: 'Kleinfelde', osm_key: 'place', osm_value: 'village', state: 'Bavaria', country: 'Germany' } },
          ],
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await resolveToSettlement({ label: '84999', detail: 'Kleinfelde, Germany', center: POSTCODE_MIDDLE, kind: 'postcode', settlement: 'Kleinfelde' });
    expect(r?.label).toBe('Kleinfelde');
    expect(r?.center).toEqual(VILLAGE);
    expect(r?.detail).toBe('Postcode 84999 · Germany');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('leaves ordinary results alone', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await resolveToSettlement({ label: 'Marienplatz 8', detail: '', center: VILLAGE, kind: 'address' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tells same-named villages apart in suggestions', () => {
    const a = photonPlace({ geometry: { coordinates: [10.0, 52.0] }, properties: { name: 'Neudorf', osm_key: 'place', osm_value: 'village', state: 'Bavaria', country: 'Germany' } });
    const b = photonPlace({ geometry: { coordinates: [11.0, 49.0] }, properties: { name: 'Neudorf', osm_key: 'place', osm_value: 'village', state: 'Bavaria', country: 'Germany' } });
    expect(a.detail).toBe('Bavaria, Germany');
    expect(b.detail).toBe('Bavaria, Germany');
  });

  it('measures distances', () => {
    expect(distanceM(VILLAGE, POSTCODE_MIDDLE)).toBeGreaterThan(1800);
    expect(distanceM(VILLAGE, POSTCODE_MIDDLE)).toBeLessThan(2000);
  });
});

describe('nearby settlements', () => {
  const res: OverpassResponse = {
    elements: [
      { type: 'node', id: 1, lat: 48.4967, lon: 11.7704, tags: { place: 'village', name: 'Kleinfelde' } },
      { type: 'node', id: 2, lat: 48.4850, lon: 11.7560, tags: { place: 'hamlet', name: 'Hof Nord' } },
      { type: 'node', id: 3, lat: 48.5620, lon: 11.7370, tags: { place: 'town', name: 'Marktstadt' } },
      { type: 'node', id: 4, lat: 48.49, lon: 11.76, tags: { place: 'village' } }, // unnamed → ignored
    ] as unknown as OverpassResponse['elements'],
  };

  it('queries named settlement nodes around the centre', () => {
    const q = settlementsQuery(POSTCODE_MIDDLE, 8000);
    expect(q).toContain('around:8000,48.4835,11.7531');
    expect(q).toContain('"place"~"^(city|town|village|hamlet|suburb)$"');
  });

  it('parses distance and bearing, and skips places already in the square', () => {
    const list = parseSettlements(res, POSTCODE_MIDDLE);
    expect(list.map((s) => s.name)).toEqual(['Kleinfelde', 'Hof Nord', 'Marktstadt']);
    const d = list[0];
    expect(d.distanceM).toBeGreaterThan(1800);
    expect(compassWord(d.bearingDeg)).toBe('north-east');
    // the farmstead 270 m away is nearest overall…
    expect(pickSettlement(list)?.name).toBe('Hof Nord');
    // …but it is inside the square (and empty): outside it, the village wins over the farther town
    expect(pickSettlement(list, 600)?.name).toBe('Kleinfelde');
    expect(pickSettlement(list, 50000)).toBeNull();
    expect(pickSettlement([])).toBeNull();
  });

  it('words directions and distances for people', () => {
    expect(compassWord(0)).toBe('north');
    expect(compassWord(359)).toBe('north');
    expect(compassWord(100)).toBe('east');
    expect(compassWord(225)).toBe('south-west');
    expect(formatDistance(420)).toBe('400 m');
    expect(formatDistance(1834)).toBe('1.8 km');
    expect(formatDistance(12500)).toBe('13 km');
  });
});
