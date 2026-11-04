import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng } from '../src/geo/png';
import { decodeTerrarium } from '../src/geo/terrain';

/** Build a PNG the way encoders do: each row filtered with one of the five PNG filters. */
function encodePng(width: number, height: number, channels: 3 | 4, pixels: Uint8Array, filterOf: (y: number) => number): Uint8Array {
  const stride = width * channels;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const f = filterOf(y);
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const x = pixels[y * stride + i];
      const a = i >= channels ? pixels[y * stride + i - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels] : 0;
      const pa = Math.abs(b - c);
      const pb = Math.abs(a - c);
      const pc = Math.abs(a + b - 2 * c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][f];
      raw[y * (stride + 1) + 1 + i] = (x - pred) & 0xff;
    }
  }
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    new DataView(out.buffer).setUint32(0, body.length);
    out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
    out.set(body, 8);
    return out; // the decoder doesn't check CRCs
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr.set([8, channels === 3 ? 2 : 6, 0, 0, 0], 8);
  const idat = deflateSync(raw);
  // split the data over two IDAT chunks, as some encoders do
  const half = idat.length >> 1;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat.subarray(0, half)), chunk('IDAT', idat.subarray(half)), chunk('IEND', new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return png;
}

describe('PNG decoding for elevation tiles', () => {
  it('reads every filter type back exactly, RGB and RGBA', async () => {
    for (const channels of [3, 4] as const) {
      const w = 37;
      const h = 23;
      const px = new Uint8Array(w * h * channels);
      for (let i = 0; i < px.length; i++) px[i] = (i * 97 + (i >> 3) * 31) & 0xff; // varied bytes, wrap-arounds included
      const png = encodePng(w, h, channels, px, (y) => y % 5);
      const out = await decodePng(png);
      expect([out.width, out.height, out.channels]).toEqual([w, h, channels]);
      expect(out.data).toEqual(px);
    }
  });

  it('keeps heights exact: one unit of red is 256 m', async () => {
    // a Terrarium pixel for 12.5 m and its neighbour one red unit up
    const px = new Uint8Array([128, 12, 128, 129, 12, 128]);
    const out = await decodePng(encodePng(2, 1, 3, px, () => 1));
    expect(decodeTerrarium(out.data[0], out.data[1], out.data[2])).toBeCloseTo(12.5, 6);
    expect(decodeTerrarium(out.data[3], out.data[4], out.data[5])).toBeCloseTo(268.5, 6);
  });

  it('refuses what it cannot read', async () => {
    await expect(decodePng(new Uint8Array([1, 2, 3]))).rejects.toThrow('not a PNG');
  });
});
