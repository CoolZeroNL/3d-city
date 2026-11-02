/**
 * Building height rule (spec, "Data sources"):
 *   1. LiDAR-derived surface model where available   — needs the tile server; not in the client prototype
 *   2. the OSM `height` tag
 *   3. `building:levels` × 3 m
 *   4. a neighbourhood median as the last fallback
 * Heights from steps 4+ are flagged as estimated so the UI can say so.
 */

export const METRES_PER_LEVEL = 3;

export type HeightSource = 'height' | 'levels' | 'median' | 'default';

export interface HeightInfo {
  height: number;
  minHeight: number;
  source: HeightSource;
}

/** Parse an OSM length value: "12", "12.5 m", "12m", "40'", "40 ft", "12;15" (first wins). */
export function parseLength(raw: string | undefined): number | null {
  if (!raw) return null;
  const first = raw.split(';')[0].trim().replace(',', '.');
  const ftIn = /^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*")?$/.exec(first);
  if (ftIn) return Number(ftIn[1]) * 0.3048 + (ftIn[2] ? Number(ftIn[2]) * 0.0254 : 0);
  const m = /^(-?\d+(?:\.\d+)?)\s*(m|meters?|metres?|ft|feet)?$/i.exec(first);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const unit = (m[2] ?? 'm').toLowerCase();
  return unit === 'ft' || unit === 'feet' ? v * 0.3048 : v;
}

function parseCount(raw: string | undefined): number | null {
  if (!raw) return null;
  const v = Number(raw.split(';')[0].trim().replace(',', '.'));
  return Number.isFinite(v) && v >= 0 ? v : null;
}

const SMALL_TYPES = new Set(['garage', 'garages', 'shed', 'carport', 'hut', 'kiosk', 'roof', 'cabin', 'container', 'toilets', 'bunker', 'ruins', 'greenhouse', 'transformer_tower', 'service']);
const HOUSE_TYPES = new Set(['house', 'detached', 'semidetached_house', 'bungalow', 'terrace', 'farm', 'static_caravan', 'houseboat']);
const TALL_TYPES = new Set(['church', 'cathedral', 'chapel', 'mosque', 'synagogue', 'temple']);
const LARGE_TYPES = new Set(['apartments', 'commercial', 'office', 'hotel', 'hospital', 'university', 'dormitory', 'public', 'government', 'civic', 'college', 'school']);
const LOW_WIDE_TYPES = new Set(['industrial', 'warehouse', 'retail', 'supermarket', 'manufacture', 'hangar', 'parking', 'sports_hall', 'train_station', 'barn', 'farm_auxiliary', 'stable']);

/** Type-based default, used when no neighbourhood data exists (or for small structures). */
export function typeDefaultHeight(type: string | undefined): number {
  const t = type ?? 'yes';
  if (SMALL_TYPES.has(t)) return 3;
  if (HOUSE_TYPES.has(t)) return 7.5;
  if (TALL_TYPES.has(t)) return 18;
  if (LARGE_TYPES.has(t)) return 15;
  if (LOW_WIDE_TYPES.has(t)) return 8;
  return 9;
}

export function isSmallStructure(type: string | undefined): boolean {
  return SMALL_TYPES.has(type ?? '');
}

/** Height from tags only (steps 2–3). Returns null when the tags say nothing about height. */
export function heightFromTags(tags: Record<string, string>): HeightInfo | null {
  const minLevel = parseCount(tags['building:min_level']);
  const minHeight = parseLength(tags['min_height']) ?? (minLevel != null ? minLevel * METRES_PER_LEVEL : 0);
  const h = parseLength(tags['height']) ?? parseLength(tags['building:height']);
  if (h != null && h > 0) return { height: Math.max(h, minHeight + 0.5), minHeight, source: 'height' };
  const levels = parseCount(tags['building:levels']);
  if (levels != null && levels > 0) {
    const roofLevels = parseCount(tags['roof:levels']) ?? 0;
    // Roof storeys are usually under a pitched roof: count them half.
    const height = levels * METRES_PER_LEVEL + roofLevels * METRES_PER_LEVEL * 0.5;
    return { height: Math.max(height, minHeight + 0.5), minHeight, source: 'levels' };
  }
  return null;
}

export function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface HeightCandidate {
  tags: Record<string, string>;
  /** centroid in local metres */
  cx: number;
  cy: number;
}

/**
 * Resolve heights for a set of buildings. Buildings without tag data get the
 * median of tagged buildings within ~`cellM` (a 3×3 cell neighbourhood), then
 * the whole-area median, then a type default. Small structures (garages, sheds)
 * never inherit a neighbourhood median.
 */
export function resolveHeights(items: HeightCandidate[], cellM = 250, minSamples = 5): HeightInfo[] {
  const tagged: Array<HeightInfo | null> = items.map((it) => heightFromTags(it.tags));
  const cells = new Map<string, number[]>();
  const all: number[] = [];
  const cellKey = (cx: number, cy: number) => `${Math.floor(cx / cellM)},${Math.floor(cy / cellM)}`;
  items.forEach((it, i) => {
    const t = tagged[i];
    if (!t || isSmallStructure(it.tags.building ?? it.tags['building:part'])) return;
    const k = cellKey(it.cx, it.cy);
    let arr = cells.get(k);
    if (!arr) cells.set(k, (arr = []));
    arr.push(t.height);
    all.push(t.height);
  });
  const areaMedian = all.length >= minSamples ? median(all) : null;
  const neighbourhoodCache = new Map<string, number | null>();
  return items.map((it, i) => {
    const t = tagged[i];
    if (t) return t;
    const type = it.tags.building ?? it.tags['building:part'];
    const minLevel = parseCount(it.tags['building:min_level']);
    const minHeight = parseLength(it.tags['min_height']) ?? (minLevel != null ? minLevel * METRES_PER_LEVEL : 0);
    if (isSmallStructure(type)) return { height: Math.max(typeDefaultHeight(type), minHeight + 0.5), minHeight, source: 'default' };
    const gx = Math.floor(it.cx / cellM);
    const gy = Math.floor(it.cy / cellM);
    const k = `${gx},${gy}`;
    let local = neighbourhoodCache.get(k);
    if (local === undefined) {
      const vals: number[] = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) vals.push(...(cells.get(`${gx + dx},${gy + dy}`) ?? []));
      local = vals.length >= minSamples ? median(vals) : null;
      neighbourhoodCache.set(k, local);
    }
    const m = local ?? areaMedian;
    if (m != null) return { height: Math.max(m, minHeight + 0.5), minHeight, source: 'median' };
    return { height: Math.max(typeDefaultHeight(type), minHeight + 0.5), minHeight, source: 'default' };
  });
}

export function isEstimated(source: HeightSource): boolean {
  return source === 'median' || source === 'default';
}
