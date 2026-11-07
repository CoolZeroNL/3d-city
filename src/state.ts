/**
 * View state and its URL form. Shared links carry coordinates and view
 * settings only — never the address the user typed (spec: privacy).
 */

import { round, type LngLat } from './geo/projection';
import { decodeSeries, encodeSeries, seriesCenter, type Series } from './geo/series';

/** Building colours: one colour for all, or coloured by height ('ramp'). */
export const BUILDING_STYLES = ['white', 'grey', 'sand', 'dark', 'ramp'] as const;
export type BuildingStyle = (typeof BUILDING_STYLES)[number];
/** The side of the square (m): 300 m to 4 km in 100 m steps. */
export type AreaSize = number;
export const AREA_MIN = 300;
export const AREA_MAX = 4000;
export const AREA_STEP = 100;
export const clampSize = (m: number): AreaSize => Math.min(AREA_MAX, Math.max(AREA_MIN, Math.round(m / AREA_STEP) * AREA_STEP));
/** "500 m", "1.5 km", "2 km" */
export const formatSize = (m: number): string => (m < 1000 ? `${m} m` : `${Number((m / 1000).toFixed(1))} km`);
/** "500 × 500 m", "2 × 2 km" */
export const formatArea = (m: number): string => (m < 1000 ? `${m} × ${m} m` : `${Number((m / 1000).toFixed(1))} × ${formatSize(m)}`);

export interface Layers {
  roads: boolean;
  water: boolean;
  green: boolean;
}

/** Orbit camera: angles in degrees, distance in metres, target offset in metres (E, N). */
export interface CameraState {
  azimuth: number;
  tilt: number;
  distance: number;
  targetE: number;
  targetN: number;
}

export interface ViewState {
  center: LngLat | null;
  size: AreaSize;
  exaggeration: number;
  contours: boolean;
  style: BuildingStyle;
  layers: Layers;
  camera: CameraState | null;
  /** where the user put the pin ("this one is ours"); null = at the centre */
  pin: LngLat | null;
  /** part of a bigger map of squares side by side; its square decides the centre */
  series: Series | null;
}

export const DEFAULT_STATE: ViewState = {
  center: null,
  size: 2000,
  exaggeration: 1.5,
  contours: false,
  style: 'white',
  layers: { roads: true, water: true, green: true },
  camera: null,
  pin: null,
  series: null,
};

export const EXAGGERATION_MIN = 1;
export const EXAGGERATION_MAX = 5;

export function encodeState(s: ViewState): string {
  if (!s.center) return '';
  const p = new URLSearchParams();
  p.set('lat', round(s.center.lat, 5).toFixed(5));
  p.set('lon', round(s.center.lon, 5).toFixed(5));
  p.set('km', String(Number((s.size / 1000).toFixed(1))));
  p.set('ex', round(s.exaggeration, 1).toString());
  if (s.contours) p.set('ct', '1');
  if (s.style !== 'white') p.set('st', s.style);
  const ly = `${s.layers.roads ? 'r' : ''}${s.layers.water ? 'w' : ''}${s.layers.green ? 'g' : ''}`;
  if (ly !== 'rwg') p.set('ly', ly || '-');
  if (s.camera) {
    const c = s.camera;
    p.set('cam', [round(c.azimuth, 1), round(c.tilt, 1), Math.round(c.distance), Math.round(c.targetE), Math.round(c.targetN)].join(','));
  }
  if (s.pin) p.set('pin', `${round(s.pin.lat, 5).toFixed(5)},${round(s.pin.lon, 5).toFixed(5)}`);
  if (s.series) p.set('ser', encodeSeries(s.series));
  // commas are fine in a fragment and keep links readable
  return p.toString().replace(/%2C/g, ',');
}

export function decodeState(raw: string, base: ViewState = DEFAULT_STATE): ViewState {
  const p = new URLSearchParams(raw.replace(/^[#?]/, ''));
  const s: ViewState = { ...base, layers: { ...base.layers }, camera: null, pin: null, series: null };
  const lat = Number(p.get('lat'));
  const lon = Number(p.get('lon'));
  if (p.has('lat') && p.has('lon') && validLatLon(lat, lon)) {
    s.center = { lat, lon };
  } else {
    return { ...base, center: null, pin: null, series: null };
  }
  const km = Number(p.get('km'));
  if (p.has('km') && Number.isFinite(km) && km > 0) s.size = clampSize(km * 1000);
  const ex = Number(p.get('ex'));
  if (p.has('ex') && Number.isFinite(ex)) s.exaggeration = Math.min(EXAGGERATION_MAX, Math.max(EXAGGERATION_MIN, ex));
  s.contours = p.get('ct') === '1';
  const st = p.get('st');
  s.style = BUILDING_STYLES.find((x) => x === st) ?? 'white';
  const ly = p.get('ly');
  if (ly != null) s.layers = { roads: ly.includes('r'), water: ly.includes('w'), green: ly.includes('g') };
  const cam = p.get('cam')?.split(',').map(Number);
  if (cam && cam.length === 5 && cam.every(Number.isFinite)) {
    s.camera = { azimuth: cam[0], tilt: cam[1], distance: cam[2], targetE: cam[3], targetN: cam[4] };
  }
  const pin = p.get('pin')?.split(',').map(Number);
  if (pin && pin.length === 2 && validLatLon(pin[0], pin[1])) s.pin = { lat: pin[0], lon: pin[1] };
  // a square of a bigger map: its place in the series decides the centre, and the series the terrain
  const series = decodeSeries(p.get('ser'));
  if (series) {
    s.series = series;
    s.center = seriesCenter(series, s.size);
    s.exaggeration = series.ex;
  }
  return s;
}

function validLatLon(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180;
}

export function samePlace(a: LngLat | null, b: LngLat | null): boolean {
  return a === b || (!!a && !!b && a.lat === b.lat && a.lon === b.lon);
}
