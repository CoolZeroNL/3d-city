/**
 * Sea areas from OpenStreetMap coastlines.
 *
 * OSM has no polygons for the sea: it is implied by `natural=coastline` lines,
 * drawn with land on the left and water on the right. Elevation can't stand in
 * for it — harbour water reads as 0 m in the terrain tiles while polders sit
 * below sea level — so we rasterise the coastlines as barriers, seed a flood
 * fill just to the right of every coastline segment, and fill.
 */

import type { Polygon, Pt } from './polygon';

export interface SeaMask {
  /** pixels per side */
  px: number;
  sizeM: number;
  /** row 0 = north edge, column 0 = west edge; 1 = sea */
  data: Uint8Array;
}

/** Pixel coordinates (fractional) of a local (E, N) point. */
function toPx(p: Pt, sizeM: number, px: number): [number, number] {
  const h = sizeM / 2;
  return [((p[0] + h) / sizeM) * px, ((h - p[1]) / sizeM) * px];
}

/** Liang–Barsky clip of a segment to [lo, hi]²; null when it misses. */
function clipSegment(a: [number, number], b: [number, number], lo: number, hi: number): [[number, number], [number, number]] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const checks: Array<[number, number]> = [
    [-dx, a[0] - lo],
    [dx, hi - a[0]],
    [-dy, a[1] - lo],
    [dy, hi - a[1]],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return null;
    }
  }
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

/** 8-connected (Bresenham) line: a 4-connected flood fill cannot leak through it. */
function plotLine(barrier: Uint8Array, px: number, a: [number, number], b: [number, number]): void {
  let x0 = Math.floor(a[0]);
  let y0 = Math.floor(a[1]);
  const x1 = Math.floor(b[0]);
  const y1 = Math.floor(b[1]);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (x0 >= 0 && y0 >= 0 && x0 < px && y0 < px) barrier[y0 * px + x0] = 1;
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

export function computeSeaMask(coastlines: Pt[][], sizeM: number, px = 1024): SeaMask | null {
  if (!coastlines.length) return null;
  const barrier = new Uint8Array(px * px);
  const seeds: number[] = [];
  const lo = -2;
  const hi = px + 2;
  for (const line of coastlines) {
    for (let k = 0; k + 1 < line.length; k++) {
      const a = toPx(line[k], sizeM, px);
      const b = toPx(line[k + 1], sizeM, px);
      const seg = clipSegment(a, b, lo, hi);
      if (!seg) continue;
      plotLine(barrier, px, seg[0], seg[1]);
      // Water is to the right of the direction of travel. In pixel space (y down)
      // the right-hand normal of (dx, dy) is (-dy, dx).
      const dx = seg[1][0] - seg[0][0];
      const dy = seg[1][1] - seg[0][1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const steps = Math.max(1, Math.floor(len / 6));
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) / steps;
        const sxp = seg[0][0] + dx * t + (-dy / len) * 2.5;
        const syp = seg[0][1] + dy * t + (dx / len) * 2.5;
        const ix = Math.floor(sxp);
        const iy = Math.floor(syp);
        if (ix >= 0 && iy >= 0 && ix < px && iy < px) seeds.push(iy * px + ix);
      }
    }
  }
  if (!seeds.length) return null;
  const data = new Uint8Array(px * px);
  const stack = new Int32Array(px * px);
  let top = 0;
  for (const s of seeds) {
    if (barrier[s] || data[s]) continue;
    data[s] = 1;
    stack[top++] = s;
    while (top) {
      const i = stack[--top];
      const x = i % px;
      const y = (i - x) / px;
      if (x > 0 && !barrier[i - 1] && !data[i - 1]) { data[i - 1] = 1; stack[top++] = i - 1; }
      if (x < px - 1 && !barrier[i + 1] && !data[i + 1]) { data[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && !barrier[i - px] && !data[i - px]) { data[i - px] = 1; stack[top++] = i - px; }
      if (y < px - 1 && !barrier[i + px] && !data[i + px]) { data[i + px] = 1; stack[top++] = i + px; }
    }
  }
  // let the water cover the one-pixel coastline itself where it borders sea
  for (let i = 0; i < data.length; i++) {
    if (!barrier[i] || data[i]) continue;
    const x = i % px;
    if ((x > 0 && data[i - 1] === 1) || (x < px - 1 && data[i + 1] === 1) || (i >= px && data[i - px] === 1) || (i + px < data.length && data[i + px] === 1)) data[i] = 2;
  }
  for (let i = 0; i < data.length; i++) if (data[i] === 2) data[i] = 1;
  return { px, sizeM, data };
}

export function isSea(mask: SeaMask, e: number, n: number): boolean {
  const [x, y] = toPx([e, n], mask.sizeM, mask.px);
  const ix = Math.min(mask.px - 1, Math.max(0, Math.floor(x)));
  const iy = Math.min(mask.px - 1, Math.max(0, Math.floor(y)));
  return mask.data[iy * mask.px + ix] === 1;
}

export function seaShare(mask: SeaMask): number {
  let n = 0;
  for (let i = 0; i < mask.data.length; i++) n += mask.data[i];
  return n / mask.data.length;
}

/** Sea mask from sea polygons (vector tiles), rasterised with a 2D canvas. Browser only. */
export function seaMaskFromPolygons(polys: Polygon[], sizeM: number, px = 1024): SeaMask | null {
  if (!polys.length) return null;
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(px, px) : Object.assign(document.createElement('canvas'), { width: px, height: px });
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;
  const s = px / sizeM;
  const h = sizeM / 2;
  ctx.setTransform(s, 0, 0, -s, h * s, h * s);
  ctx.fillStyle = '#000';
  ctx.beginPath();
  for (const p of polys) {
    for (const ring of [p.outer, ...p.holes]) {
      ring.forEach(([e, n], i) => (i ? ctx.lineTo(e, n) : ctx.moveTo(e, n)));
      ctx.closePath();
    }
  }
  ctx.fill('nonzero');
  const img = ctx.getImageData(0, 0, px, px).data;
  const data = new Uint8Array(px * px);
  let any = false;
  for (let i = 0; i < data.length; i++) {
    if (img[i * 4 + 3] > 127) {
      data[i] = 1;
      any = true;
    }
  }
  return any ? { px, sizeM, data } : null;
}
