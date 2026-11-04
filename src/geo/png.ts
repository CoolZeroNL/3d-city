/**
 * A small PNG decoder for the elevation tiles (8-bit RGB or RGBA, not interlaced).
 *
 * The tiles store heights in their colours (red × 256 + green + blue / 256 − 32768 m), so every
 * pixel has to come back exactly as it was stored. Reading it back from a canvas doesn't
 * guarantee that: browsers with fingerprinting protection (Orion, Brave, Safari in private
 * windows, Firefox with resistFingerprinting) add small random noise to getImageData, and one
 * unit of red is 256 m — the terrain turns into a forest of needles. Decoding the bytes here
 * sidesteps the canvas entirely.
 */

export interface DecodedPng {
  width: number;
  height: number;
  /** 3 (RGB) or 4 (RGBA) */
  channels: number;
  /** width × height × channels bytes, top row first */
  data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export async function decodePng(bytes: Uint8Array): Promise<DecodedPng> {
  if (bytes.length < 33 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  let idatLength = 0;
  for (let p = 8; p + 8 <= bytes.length; ) {
    const length = view.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const body = bytes.subarray(p + 8, p + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(p + 8);
      height = view.getUint32(p + 12);
      const [depth, colour, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) {
        throw new Error(`unsupported PNG (depth ${depth}, colour type ${colour}, interlace ${interlace})`);
      }
      channels = colour === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      idat.push(body);
      idatLength += body.length;
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + length;
  }
  if (!width || !height || !channels || !idatLength) throw new Error('incomplete PNG');

  const compressed = new Uint8Array(idatLength);
  let o = 0;
  for (const part of idat) {
    compressed.set(part, o);
    o += part.length;
  }
  const raw = new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());

  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error('truncated PNG data');
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const prev = row - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= channels ? data[row + i - channels] : 0;
      const b = y > 0 ? data[prev + i] : 0;
      const c = y > 0 && i >= channels ? data[prev + i - channels] : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`bad PNG filter ${filter}`);
      }
      data[row + i] = v & 0xff;
    }
  }
  return { width, height, channels, data };
}
