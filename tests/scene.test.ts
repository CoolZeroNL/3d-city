import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { applyBuildingStyle, buildBuildings, rampColor, setBuildingsExaggeration } from '../src/scene/buildingsMesh';
import { withOrientation, type Polygon } from '../src/geo/polygon';
import { decodeState, DEFAULT_STATE, encodeState, type ViewState } from '../src/state';

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
    };
    const back = decodeState(`#${encodeState(s)}`);
    expect(back).toEqual(s);
  });

  it('never writes anything but coordinates and view settings', () => {
    const h = encodeState({ ...DEFAULT_STATE, center: { lat: 1, lon: 2 } });
    expect(h).toBe('lat=1.00000&lon=2.00000&km=2&ex=1.5');
  });

  it('rejects bad input and clamps values', () => {
    expect(decodeState('#lat=abc&lon=1').center).toBeNull();
    expect(decodeState('#lat=10&lon=10&ex=50').exaggeration).toBe(5);
    expect(decodeState('#lat=10&lon=10&km=3').size).toBe(2000);
  });
});
