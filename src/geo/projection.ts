/**
 * Coordinate helpers.
 *
 * The model lives in a local, metre-based frame centred on the chosen place:
 *   E = metres east of the centre, N = metres north of the centre.
 * For areas of a few kilometres an equirectangular projection around the centre
 * is accurate to well under a metre, which is far below the data's resolution.
 *
 * three.js is y-up, so scene coordinates are (x, y, z) = (E, height, -N):
 * north points into the screen when the camera looks from the south.
 */

export interface LngLat {
  lon: number;
  lat: number;
}

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface Projector {
  center: LngLat;
  /** metres per degree of longitude at the centre latitude */
  mPerDegLon: number;
  /** metres per degree of latitude at the centre latitude */
  mPerDegLat: number;
  toLocal(lon: number, lat: number): [number, number];
  toLngLat(e: number, n: number): LngLat;
}

const DEG = Math.PI / 180;

export function makeProjector(center: LngLat): Projector {
  const phi = center.lat * DEG;
  // Standard series for metres per degree on the WGS84 ellipsoid.
  const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const mPerDegLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  return {
    center,
    mPerDegLat,
    mPerDegLon,
    toLocal(lon, lat) {
      return [(lon - center.lon) * mPerDegLon, (lat - center.lat) * mPerDegLat];
    },
    toLngLat(e, n) {
      return { lon: center.lon + e / mPerDegLon, lat: center.lat + n / mPerDegLat };
    },
  };
}

/** Bounding box of a square of `sizeM` metres centred on `center`, plus an optional margin. */
export function squareBBox(center: LngLat, sizeM: number, marginM = 0): BBox {
  const p = makeProjector(center);
  const h = sizeM / 2 + marginM;
  const sw = p.toLngLat(-h, -h);
  const ne = p.toLngLat(h, h);
  return { south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon };
}

/** Fractional Web-Mercator tile coordinates (slippy-map scheme) at zoom z. */
export function lngLatToTile(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latR = lat * DEG;
  const y = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
  return [x, y];
}

/** Ground size of one 256 px tile pixel at zoom z and latitude (metres). */
export function metresPerPixel(lat: number, z: number): number {
  return (156543.03392 * Math.cos(lat * DEG)) / 2 ** z;
}

/** Round to a fixed number of decimals (used for URLs and cache keys). */
export function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

export function formatLatLon(c: LngLat): string {
  const lat = `${Math.abs(c.lat).toFixed(4)}° ${c.lat >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(c.lon).toFixed(4)}° ${c.lon >= 0 ? 'E' : 'W'}`;
  return `${lat}, ${lon}`;
}
