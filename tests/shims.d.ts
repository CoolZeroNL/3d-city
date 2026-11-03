// Test-only tile encoders (no published types).
declare module 'geojson-vt' {
  interface Index {
    getTile(z: number, x: number, y: number): unknown;
  }
  export default function geojsonvt(data: unknown, options?: Record<string, unknown>): Index;
}
declare module 'vt-pbf' {
  export function fromGeojsonVt(layers: Record<string, unknown>, options?: Record<string, unknown>): Uint8Array;
}
