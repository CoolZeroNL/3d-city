/**
 * Geocoding for the prototype:
 *  - Photon (komoot, OSM-based) for type-ahead suggestions — it is built for autocomplete.
 *  - Nominatim for a single lookup when the user submits without picking a suggestion
 *    (Nominatim's usage policy forbids autocomplete traffic).
 * Production should move this behind the app's own server (spec: privacy).
 */

import type { LngLat } from './projection';

export interface Place {
  label: string;
  detail: string;
  center: LngLat;
}

const PHOTON = 'https://photon.komoot.io';
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const PHOTON_LANGS = new Set(['en', 'de', 'fr', 'it']);

function photonLang(): string {
  const l = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return PHOTON_LANGS.has(l) ? l : 'en';
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    name?: string;
    housenumber?: string;
    street?: string;
    postcode?: string;
    city?: string;
    district?: string;
    county?: string;
    state?: string;
    country?: string;
    osm_value?: string;
    type?: string;
  };
}

export function photonLabel(p: PhotonFeature['properties']): { label: string; detail: string } {
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const label = p.name && p.name !== p.street ? p.name : street || p.name || p.city || p.state || 'Unnamed place';
  const detailParts = [
    label !== street && street ? street : '',
    [p.postcode, p.city && p.city !== label ? p.city : ''].filter(Boolean).join(' '),
    p.country,
  ].filter(Boolean);
  return { label, detail: detailParts.join(', ') };
}

/** Accepts "52.26, 10.52" or "52.26 10.52" as raw coordinates. */
export function parseCoordinates(q: string): LngLat | null {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(q);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

export async function suggest(q: string, bias: LngLat | null, signal: AbortSignal): Promise<Place[]> {
  const params = new URLSearchParams({ q, limit: '6', lang: photonLang() });
  if (bias) {
    params.set('lat', bias.lat.toFixed(4));
    params.set('lon', bias.lon.toFixed(4));
  }
  const res = await fetch(`${PHOTON}/api/?${params}`, { signal });
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
  const json = (await res.json()) as { features?: PhotonFeature[] };
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const f of json.features ?? []) {
    const [lon, lat] = f.geometry.coordinates;
    const { label, detail } = photonLabel(f.properties);
    const k = `${label}|${detail}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ label, detail, center: { lon, lat } });
  }
  return out;
}

export async function searchOnce(q: string, signal?: AbortSignal): Promise<Place | null> {
  const coords = parseCoordinates(q);
  if (coords) return { label: q.trim(), detail: '', center: coords };
  const params = new URLSearchParams({ q, format: 'jsonv2', limit: '1' });
  const res = await fetch(`${NOMINATIM}/search?${params}`, { signal, headers: { 'Accept-Language': navigator.language || 'en' } });
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
  const json = (await res.json()) as Array<{ lat: string; lon: string; name?: string; display_name: string }>;
  const hit = json[0];
  if (!hit) return null;
  const [first, ...rest] = hit.display_name.split(', ');
  return { label: hit.name || first, detail: rest.slice(0, 3).join(', '), center: { lat: Number(hit.lat), lon: Number(hit.lon) } };
}

/** Name for a coordinate (used when a model is opened from a shared link, which holds coordinates only). */
export async function reverse(c: LngLat, signal?: AbortSignal): Promise<Place | null> {
  try {
    const params = new URLSearchParams({ lat: c.lat.toFixed(5), lon: c.lon.toFixed(5), lang: photonLang(), limit: '1' });
    const res = await fetch(`${PHOTON}/reverse?${params}`, { signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { features?: PhotonFeature[] };
    const f = json.features?.[0];
    if (!f) return null;
    const p = f.properties;
    // Neighbourhood-level name: a shared link should not resolve back to a street address.
    const label = p.district || p.city || p.county || p.state || p.name || '';
    if (!label) return null;
    return { label, detail: [p.city !== label ? p.city : '', p.country].filter(Boolean).join(', '), center: c };
  } catch {
    return null;
  }
}
