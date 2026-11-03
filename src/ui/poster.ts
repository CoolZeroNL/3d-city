/**
 * Poster-quality PNG: the current view rendered off-screen at high resolution,
 * framed on a paper background with the place name, coordinates and the data
 * attribution (required by the OSM and terrain licences on exports too).
 */

import { formatLatLon, type LngLat } from '../geo/projection';
import type { Viewer } from '../scene/viewer';

export interface PosterInfo {
  title: string;
  center: LngLat;
  sizeM: number;
  exaggeration: number;
}

export const ATTRIBUTION_TEXT = '© OpenStreetMap contributors (ODbL) · © OpenMapTiles · OpenFreeMap · Terrain: Mapzen, AWS Terrain Tiles';

export async function makePoster(viewer: Viewer, info: PosterInfo, width = 2400): Promise<Blob> {
  const render = viewer.renderStill(width, width);
  const W = render.width;
  const footer = Math.round(W * 0.25);
  const H = W + footer;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;

  const bg = ctx.createRadialGradient(W / 2, W * 0.4, W * 0.1, W / 2, W * 0.5, W * 0.9);
  bg.addColorStop(0, '#f6f3ee');
  bg.addColorStop(1, '#dfd9ce');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(render, 0, 0);

  const pad = Math.round(W * 0.06);
  const serif = "ui-serif, 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif";
  const sans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
  const y0 = W + footer * 0.08;

  ctx.fillStyle = '#c8431a';
  ctx.fillRect(pad, y0, Math.round(W * 0.05), Math.max(3, Math.round(W * 0.003)));

  ctx.fillStyle = '#1e1c19';
  ctx.textBaseline = 'top';
  let titleSize = Math.round(W * 0.055);
  ctx.font = `500 ${titleSize}px ${serif}`;
  while (ctx.measureText(info.title).width > W - 2 * pad && titleSize > 20) {
    titleSize -= 4;
    ctx.font = `500 ${titleSize}px ${serif}`;
  }
  ctx.fillText(info.title, pad, y0 + footer * 0.1);

  ctx.fillStyle = '#5c564d';
  ctx.font = `450 ${Math.round(W * 0.019)}px ${sans}`;
  const km = info.sizeM / 1000;
  const meta = `${formatLatLon(info.center)}   ·   ${km} × ${km} km   ·   terrain ×${info.exaggeration.toFixed(1)}`;
  ctx.fillText(meta, pad, y0 + footer * 0.1 + titleSize * 1.25);

  ctx.fillStyle = '#8a8378';
  ctx.font = `400 ${Math.round(W * 0.0125)}px ${sans}`;
  ctx.textBaseline = 'bottom';
  ctx.fillText(ATTRIBUTION_TEXT, pad, H - footer * 0.12);

  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
}

export function posterFileName(title: string, sizeM: number): string {
  return exportFileName(title, sizeM, 'png');
}

/** "your-place-kleinfelde-1km.png", "your-place-kleinfelde-1km-15cm.stl" */
export function exportFileName(title: string, sizeM: number, suffix: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `your-place-${slug || 'model'}-${sizeM / 1000}km${suffix.includes('.') ? '-' : '.'}${suffix}`;
}
