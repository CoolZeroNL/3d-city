/**
 * Roads, water and green areas are painted into one canvas texture draped over
 * the terrain. Rasterising keeps them perfectly glued to the ground at any
 * exaggeration, costs no extra triangles, and makes toggling a layer a redraw.
 */

import { CanvasTexture, LinearMipmapLinearFilter, SRGBColorSpace } from 'three';
import type { AreaFeature, AreaKind, FeatureSet, LineFeature, LineKind } from '../geo/osm';
import type { SeaMask } from '../geo/sea';
import type { Layers } from '../state';

export const PALETTE = {
  ground: '#ebe6dc',
  farmland: '#e5e0cd',
  green: '#cbd7b6',
  forest: '#b4c69c',
  sand: '#ede0c0',
  plaza: '#f5f2eb',
  water: '#a9c5d6',
  roadFill: '#fbfaf6',
  // a clear edge: white roads on the beige ground were hard to see from a distance
  roadCasing: '#998c76',
  path: '#f6f2ea',
  rail: '#8e877b',
};

const AREA_ORDER: AreaKind[] = ['farmland', 'green', 'forest', 'sand', 'plaza', 'water'];
const AREA_LAYER: Record<AreaKind, keyof Layers> = {
  farmland: 'green',
  green: 'green',
  forest: 'green',
  sand: 'green',
  plaza: 'roads',
  water: 'water',
};

const ROAD_RANK: Record<LineKind, number> = {
  path: 0,
  service: 1,
  minor: 2,
  tertiary: 3,
  secondary: 4,
  primary: 5,
  motorway: 6,
  rail: 7,
  stream: -1,
  canal: -1,
  river: -1,
};

export class Overlay {
  readonly canvas: HTMLCanvasElement;
  readonly texture: CanvasTexture;
  private seaLayer: HTMLCanvasElement | null = null;

  constructor(readonly px: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = px;
    this.canvas.height = px;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearMipmapLinearFilter;
    this.texture.generateMipmaps = true;
    this.draw(null, 1000, { roads: true, water: true, green: true });
  }

  /** Pre-render the sea mask once; draw() composites it under the water layer. */
  setSea(mask: SeaMask | null): void {
    if (!mask) {
      this.seaLayer = null;
      return;
    }
    const c = document.createElement('canvas');
    c.width = mask.px;
    c.height = mask.px;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(mask.px, mask.px);
    const [r, g, b] = hexToRgb(PALETTE.water);
    for (let i = 0; i < mask.data.length; i++) {
      if (!mask.data[i]) continue;
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    this.seaLayer = c;
  }

  draw(features: FeatureSet | null, sizeM: number, layers: Layers): void {
    const ctx = this.canvas.getContext('2d')!;
    const W = this.px;
    const s = W / sizeM;
    const h = sizeM / 2;
    ctx.save();
    ctx.fillStyle = PALETTE.ground;
    ctx.fillRect(0, 0, W, W);
    if (!features) {
      ctx.restore();
      this.texture.needsUpdate = true;
      return;
    }
    if (this.seaLayer && layers.water) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.seaLayer, 0, 0, W, W);
    }
    // local (E, N) metres → canvas pixels (north up)
    ctx.setTransform(s, 0, 0, -s, h * s, h * s);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const byKind = new Map<AreaKind, AreaFeature[]>();
    for (const a of features.areas) {
      const arr = byKind.get(a.kind);
      if (arr) arr.push(a);
      else byKind.set(a.kind, [a]);
    }
    for (const kind of AREA_ORDER) {
      if (!layers[AREA_LAYER[kind]]) continue;
      const list = byKind.get(kind);
      if (!list) continue;
      ctx.fillStyle = PALETTE[kind];
      ctx.beginPath();
      for (const a of list) {
        for (const p of a.polys) {
          traceRing(ctx, p.outer);
          for (const hole of p.holes) traceRing(ctx, hole);
        }
      }
      // outers are counter-clockwise and holes clockwise, so nonzero keeps holes open while
      // overlapping areas of the same kind (a park on grass) stay filled; evenodd would punch them out
      ctx.fill('nonzero');
    }

    const minW = 0.8 / s; // keep thin lines at least ~0.8 px wide
    if (layers.water) {
      ctx.strokeStyle = PALETTE.water;
      for (const l of features.lines) {
        if (ROAD_RANK[l.kind] >= 0) continue;
        strokeLine(ctx, l, Math.max(l.widthM, minW));
      }
    }

    if (layers.roads) {
      const roads = features.lines.filter((l) => ROAD_RANK[l.kind] >= 0 && l.kind !== 'rail').sort((a, b) => ROAD_RANK[a.kind] - ROAD_RANK[b.kind]);
      // paths: no casing
      ctx.strokeStyle = PALETTE.path;
      for (const l of roads) if (l.kind === 'path') strokeLine(ctx, l, Math.max(l.widthM, minW));
      // casings first, then fills, so junctions merge cleanly
      const vehicular = roads.filter((l) => l.kind !== 'path');
      const casing = Math.max(4, 3 / s);
      ctx.strokeStyle = PALETTE.roadCasing;
      for (const l of vehicular) strokeLine(ctx, l, Math.max(l.widthM, minW) + casing);
      ctx.strokeStyle = PALETTE.roadFill;
      for (const l of vehicular) strokeLine(ctx, l, Math.max(l.widthM, minW));
      ctx.strokeStyle = PALETTE.rail;
      for (const l of features.lines) if (l.kind === 'rail') strokeLine(ctx, l, Math.max(l.widthM * 0.6, minW));
    }
    ctx.restore();
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function traceRing(ctx: CanvasRenderingContext2D, ring: Array<[number, number]>): void {
  if (ring.length < 3) return;
  ctx.moveTo(ring[0][0], ring[0][1]);
  for (let k = 1; k < ring.length; k++) ctx.lineTo(ring[k][0], ring[k][1]);
  ctx.closePath();
}

function strokeLine(ctx: CanvasRenderingContext2D, l: LineFeature, width: number): void {
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(l.pts[0][0], l.pts[0][1]);
  for (let k = 1; k < l.pts.length; k++) ctx.lineTo(l.pts[k][0], l.pts[k][1]);
  ctx.stroke();
}
