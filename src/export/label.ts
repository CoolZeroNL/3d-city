/**
 * The title raised on the 3D print: one or two lines of text on a slim ledge in front of the
 * model (the south side, since north is at the back), so a print can say "Where we met · June 2019".
 *
 * Letters come from flattened Inter Bold outlines (glyphs/inter-bold.json, SIL Open Font
 * License) and go through the same prism builder as the buildings, so every letter is a closed,
 * checked shell. The ledge reaches 1 mm into the terrain block and the letters 0.3 mm into the
 * ledge; slicers merge overlapping shells, as they do with the buildings.
 */

import type { Polygon, Ring } from '../geo/polygon';
import { addSolid, type Triangles } from './stl';

export interface GlyphFont {
  unitsPerEm: number;
  capHeight: number;
  ascender: number;
  descender: number;
  /** per character: advance width and polygons, each [outer, ...holes] as flat x,y lists */
  glyphs: Record<string, { a: number; p: number[][][] }>;
}

/** Loaded only when a print is made: about 30 KB compressed. */
export async function loadGlyphs(): Promise<GlyphFont> {
  return (await import('./glyphs/inter-bold.json')).default as unknown as GlyphFont;
}

/** Ledge thickness (mm): a step in front of the model, lower than the terrain block's base. */
export const LEDGE_MM = 2;
/** How far the letters stand up from the ledge (mm): five layers at 0.2 mm. */
export const LETTER_RAISE_MM = 1;

export interface TextShape {
  polys: Polygon[];
  /** width of the line (mm) */
  width: number;
  /** characters the font doesn't have (left out) */
  missing: string[];
}

/** A line of text as polygons in mm: baseline at y = 0, starting at x = 0, capital letters `capMm` tall. */
export function textPolygons(font: GlyphFont, text: string, capMm: number): TextShape {
  const k = capMm / font.capHeight;
  const polys: Polygon[] = [];
  const missing: string[] = [];
  let x = 0;
  for (const ch of text) {
    const g = font.glyphs[ch];
    if (!g) {
      if (!missing.includes(ch)) missing.push(ch);
      x += (font.glyphs[' ']?.a ?? 250) * k;
      continue;
    }
    for (const rings of g.p) {
      const [outer, ...holes] = rings.map((flat) => {
        const ring: Ring = [];
        // a fixed nudge of at most 0.2 µm per point breaks exact line-ups across a letter
        // (the opposite arms of ×), which would leave a zero-area triangle in its top face
        for (let i = 0; i < flat.length; i += 2) ring.push([x + flat[i] * k + nudge(i), flat[i + 1] * k + nudge(i + 1)]);
        return ring;
      });
      // In letters like # and æ a hole's edges lie on the very lines of the outer edges, and the
      // roof triangulation then merges points across them. Widening each hole by 0.2 % (about a
      // thousandth of a millimetre) breaks the exact line-up without changing the letter.
      polys.push({ outer, holes: holes.map(widen) });
    }
    x += g.a * k;
  }
  return { polys, width: x, missing };
}

/** A fixed, tiny offset (≤ 0.0002 mm) per coordinate. */
const nudge = (i: number) => ((((i + 1) * 2654435761) >>> 0) % 1001 / 1000 - 0.5) * 0.0004;

function widen(r: Ring): Ring {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of r) {
    cx += x;
    cy += y;
  }
  cx /= r.length;
  cy /= r.length;
  return r.map(([x, y]) => [cx + (x - cx) * 1.002, cy + (y - cy) * 1.002] as [number, number]);
}

export interface LabelResult {
  /** characters left out because the font doesn't have them */
  missing: string[];
  /** capital-letter height of each line (mm) */
  capMm: number[];
  /** how far the ledge reaches in front of the model (mm) */
  depthMm: number;
}

/**
 * Adds the ledge and the raised title in front of a print of `sideMm` on a `baseMm` base.
 * Returns null when there's no text. Lines that don't fit the width are made smaller.
 */
export function addLabel(t: Triangles, font: GlyphFont, lines: string[], sideMm: number, baseMm: number): LabelResult | null {
  const text = lines.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 2);
  if (!text.length) return null;
  const margin = Math.max(3, sideMm * 0.03);
  const usable = sideMm - 2 * margin;
  const first = sideMm * 0.04; // 6 mm capitals on a 15 cm print
  const shaped = text.map((s, i) => {
    let cap = i === 0 ? first : first * 0.6;
    let shape = textPolygons(font, s, cap);
    if (shape.width > usable) {
      cap *= usable / shape.width;
      shape = textPolygons(font, s, cap);
    }
    return { shape, cap };
  });
  const descender = (cap: number) => cap * 0.32; // room below the baseline for g, p, y
  const gap = first * 0.4;
  const pad = margin * 0.8;
  const depth = pad * 2 + shaped.reduce((a, { cap }) => a + cap + descender(cap), 0) + gap * (shaped.length - 1);

  // the ledge, 1 mm into the block and just inside its sides and floor so no faces coincide
  const half = sideMm / 2;
  const front = -half - depth;
  const ledgeTop = -baseMm + LEDGE_MM;
  const ledge: Polygon = {
    outer: [[-half + 0.01, front], [half - 0.01, front], [half - 0.01, -half + 1], [-half + 0.01, -half + 1]],
    holes: [],
  };
  addSolid(t, ledge, ledgeTop, -baseMm + 0.01, 0);

  // the first line nearest the model, read from the front
  let y = -half - pad;
  for (const { shape, cap } of shaped) {
    const baseline = y - cap;
    const dx = -shape.width / 2;
    for (const p of shape.polys) {
      const move = (r: Ring): Ring => r.map(([x, yy]) => [x + dx, yy + baseline] as [number, number]);
      addSolid(t, { outer: move(p.outer), holes: p.holes.map(move) }, ledgeTop + LETTER_RAISE_MM, ledgeTop - 0.3);
    }
    y = baseline - descender(cap) - gap;
  }
  return { missing: [...new Set(shaped.flatMap(({ shape }) => shape.missing))], capMm: shaped.map(({ cap }) => cap), depthMm: depth };
}
