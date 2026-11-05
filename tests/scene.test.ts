import { describe, expect, it } from 'vitest';
import { Color, Vector3 } from 'three';
import { applyBuildingStyle, buildBuildings, buildingOfVertex, buildingsAt, paintBuildings, rampColor, setBuildingsExaggeration } from '../src/scene/buildingsMesh';
import { withOrientation, type Polygon } from '../src/geo/polygon';
import { decodeState, DEFAULT_STATE, encodeState, formatArea, type ViewState } from '../src/state';

const box = (x: number, y: number, w: number, d: number): Polygon => ({
  outer: withOrientation(
    [
      [x, y],
      [x + w, y],
      [x + w, y + d],
      [x, y + d],
    ],
    true,
  ),
  holes: [],
});

describe('building extrusion', () => {
  const courtyard: Polygon = {
    outer: box(0, 0, 40, 40).outer,
    holes: [withOrientation([[10, 10], [30, 10], [30, 30], [10, 30]], false)],
  };
  const specs = [
    { poly: box(100, 0, 10, 10), height: 12, minHeight: 0, estimated: false },
    { poly: courtyard, height: 20, minHeight: 0, estimated: true },
    { poly: box(-50, -50, 8, 8), height: 30, minHeight: 10, estimated: false }, // raised part
  ];
  const ground = (p: Polygon) => (p.outer[0][0] > 50 ? 105 : 100);
  const b = buildBuildings(specs, ground, 90, 2);

  it('counts buildings and estimates', () => {
    expect(b.count).toBe(3);
    expect(b.estimatedCount).toBe(1);
    expect(b.maxHeight).toBe(30);
  });

  it('winds every triangle so its face normal agrees with the vertex normal', () => {
    const pos = b.geometry.getAttribute('position');
    const nrm = b.geometry.getAttribute('normal');
    const idx = b.geometry.getIndex()!;
    const a = new Vector3();
    const c = new Vector3();
    const d = new Vector3();
    const n = new Vector3();
    let checked = 0;
    for (let t = 0; t < idx.count; t += 3) {
      const [i, j, k] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
      a.fromBufferAttribute(pos, i);
      c.fromBufferAttribute(pos, j).sub(a);
      d.fromBufferAttribute(pos, k).sub(a);
      const face = c.clone().cross(d);
      if (face.lengthSq() < 1e-9) continue;
      n.fromBufferAttribute(nrm, i);
      expect(face.dot(n)).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('puts roofs at ground × exaggeration + height and follows the slider', () => {
    const pos = b.geometry.getAttribute('position');
    let topOfFirst = -Infinity;
    // first building (20 vertices: 4 walls × 4 + 4 roof): ground 105 → (105 - 90) * 2 + 12 = 42
    for (let v = 0; v < 20; v++) topOfFirst = Math.max(topOfFirst, pos.getY(v));
    expect(topOfFirst).toBeCloseTo(42);
    setBuildingsExaggeration(b, 1, 90);
    let top1 = -Infinity;
    for (let v = 0; v < 20; v++) top1 = Math.max(top1, b.geometry.getAttribute('position').getY(v));
    expect(top1).toBeCloseTo(27);
  });

  it('colours by height on the ramp style', () => {
    applyBuildingStyle(b, 'ramp');
    const col = b.geometry.getAttribute('color');
    const expected = rampColor(12);
    expect(col.getX(0)).toBeCloseTo(expected.r);
    applyBuildingStyle(b, 'white');
    expect(col.getX(0)).toBeGreaterThan(0.9);
  });

  it('keeps each building in one vertex range, so a hit face names its building', () => {
    expect(b.starts[0]).toBe(0);
    expect(b.starts[1]).toBe(20);
    expect(b.starts[3]).toBe(b.geometry.getAttribute('position').count);
    expect(buildingOfVertex(b, 0)).toBe(0);
    expect(buildingOfVertex(b, 19)).toBe(0);
    expect(buildingOfVertex(b, 20)).toBe(1);
    expect(buildingOfVertex(b, b.starts[3] - 1)).toBe(2);
  });

  it('finds the buildings under a point, not their courtyards', () => {
    expect(buildingsAt(b, specs, [105, 5])).toEqual([0]);
    expect(buildingsAt(b, specs, [5, 5])).toEqual([1]);
    expect(buildingsAt(b, specs, [20, 20])).toEqual([]); // courtyard
    expect(buildingsAt(b, specs, [70, 70])).toEqual([]);
  });

  it('paints only the pinned building', () => {
    applyBuildingStyle(b, 'white');
    paintBuildings(b, [1], new Color(1, 0, 0));
    const col = b.geometry.getAttribute('color');
    expect(col.getY(b.starts[1])).toBe(0);
    expect(col.getY(b.starts[2] - 1)).toBe(0);
    expect(col.getY(b.starts[1] - 1)).toBeGreaterThan(0.9);
    expect(col.getY(b.starts[2])).toBeGreaterThan(0.9);
  });
});

describe('view state URL', () => {
  it('round-trips through the hash', () => {
    const s: ViewState = {
      ...DEFAULT_STATE,
      center: { lat: 48.77651, lon: 9.17722 },
      size: 4000,
      exaggeration: 2.5,
      contours: true,
      style: 'ramp',
      layers: { roads: true, water: false, green: true },
      camera: { azimuth: 33.3, tilt: 41.2, distance: 3456, targetE: -120, targetN: 80 },
      pin: { lat: 48.77702, lon: 9.17654 },
    };
    const back = decodeState(`#${encodeState(s)}`);
    expect(back).toEqual(s);
  });

  it('carries a moved pin, and drops a broken or inherited one', () => {
    const base = { ...DEFAULT_STATE, center: { lat: 1, lon: 2 }, pin: { lat: 1.001, lon: 2.002 } };
    expect(encodeState(base)).toContain('pin=1.00100,2.00200');
    expect(decodeState('#lat=1&lon=2&pin=1.5,abc').pin).toBeNull();
    // a link without a pin clears the one the page had
    expect(decodeState('#lat=1&lon=2', base).pin).toBeNull();
  });

  it('never writes anything but coordinates and view settings', () => {
    const h = encodeState({ ...DEFAULT_STATE, center: { lat: 1, lon: 2 } });
    expect(h).toBe('lat=1.00000&lon=2.00000&km=2&ex=1.5');
  });

  it('rejects bad input and clamps values', () => {
    expect(decodeState('#lat=abc&lon=1').center).toBeNull();
    expect(decodeState('#lat=10&lon=10&ex=50').exaggeration).toBe(5);
    expect(decodeState('#lat=10&lon=10&km=abc').size).toBe(2000);
  });

  it('takes any area from 300 m to 4 km in 100 m steps, old links included', () => {
    const size = (km: string) => decodeState(`#lat=10&lon=10&km=${km}`).size;
    expect([size('1'), size('2'), size('4')]).toEqual([1000, 2000, 4000]);
    expect([size('1.5'), size('0.3'), size('3.7')]).toEqual([1500, 300, 3700]);
    expect([size('1.23'), size('0.1'), size('9')]).toEqual([1200, 300, 4000]);
    const s: ViewState = { ...DEFAULT_STATE, center: { lat: 1, lon: 2 }, size: 1500 };
    expect(encodeState(s)).toContain('km=1.5');
    expect(decodeState(encodeState({ ...s, size: 500 })).size).toBe(500);
    expect([formatArea(500), formatArea(1500), formatArea(2000)]).toEqual(['500 × 500 m', '1.5 × 1.5 km', '2 × 2 km']);
  });
});
