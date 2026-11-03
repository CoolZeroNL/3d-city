/**
 * Geocoding for the prototype:
 *  - Photon (komoot, OSM-based) for type-ahead suggestions — it is built for autocomplete.
 *  - Nominatim for a single lookup when the user submits without picking a suggestion
 *    (Nominatim's usage policy forbids autocomplete traffic).
 * Production should move this behind the app's own server (spec: privacy).
 */

import type { LngLat } from './projection';

export type PlaceKind = 'city' | 'town' | 'village' | 'hamlet' | 'suburb' | 'postcode' | 'area' | 'street' | 'address' | 'poi';

export interface Place {
  label: string;
  detail: string;
  center: LngLat;
  kind?: PlaceKind;
  /** for postcode and area results: the town or village the geocoder associates with it */
  settlement?: string;
}

export const KIND_LABEL: Record<PlaceKind, string> = {
  city: 'City',
  town: 'Town',
  village: 'Village',
  hamlet: 'Hamlet',
  suburb: 'District',
  postcode: 'Postcode area',
  area: 'Area',
  street: 'Street',
  address: 'Address',
  poi: 'Place',
};

export const SETTLEMENT_KINDS = new Set<PlaceKind>(['city', 'town', 'village', 'hamlet', 'suburb']);

const PLACE_VALUE_KIND: Record<string, PlaceKind> = {
  city: 'city',
  town: 'town',
  village: 'village',
  hamlet: 'hamlet',
  isolated_dwelling: 'hamlet',
  locality: 'hamlet',
  farm: 'hamlet',
  suburb: 'suburb',
  quarter: 'suburb',
  neighbourhood: 'suburb',
  borough: 'suburb',
  city_district: 'suburb',
};

/**
 * What kind of thing a geocoder result is. Postcode and administrative areas
 * are geocoded to their area's middle, which is often open country — those get
 * resolved to their main settlement before a model is built.
 */
export function placeKind(p: { osm_key?: string; osm_value?: string; type?: string; housenumber?: string }): PlaceKind {
  if (p.osm_value === 'postal_code' || p.osm_value === 'postcode' || p.type === 'postcode') return 'postcode';
  if (p.osm_key === 'place' && p.osm_value && PLACE_VALUE_KIND[p.osm_value]) return PLACE_VALUE_KIND[p.osm_value];
  if (p.osm_key === 'boundary' || p.type === 'county' || p.type === 'state' || p.type === 'country') return 'area';
  if (p.housenumber) return 'address';
  if (p.osm_key === 'highway' || p.type === 'street') return 'street';
  if (p.type === 'city') return 'city';
  if (p.type === 'district') return 'suburb';
  if (p.type === 'locality') return 'hamlet';
  return 'poi';
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
    osm_key?: string;
    osm_value?: string;
    type?: string;
  };
}

export function photonLabel(p: PhotonFeature['properties']): { label: string; detail: string } {
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const label = p.name && p.name !== p.street ? p.name : street || p.name || p.city || p.state || 'Unnamed place';
  const cityPart = [p.postcode, p.city && p.city !== label ? p.city : ''].filter(Boolean).join(' ');
  const detailParts = [
    label !== street && street ? street : '',
    cityPart,
    // places without a town of their own (villages, towns): the state tells same-named ones apart
    cityPart || street ? '' : p.state && p.state !== label ? p.state : '',
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

export function photonPlace(f: PhotonFeature): Place {
  const [lon, lat] = f.geometry.coordinates;
  const { label, detail } = photonLabel(f.properties);
  const kind = placeKind(f.properties);
  const p = f.properties;
  const settlement = kind === 'postcode' || kind === 'area' ? p.city || (kind === 'area' ? p.name : undefined) : undefined;
  return { label, detail, center: { lon, lat }, kind, settlement };
}

async function photonSearch(q: string, bias: LngLat | null, signal: AbortSignal | undefined, extra: Record<string, string> = {}): Promise<Place[]> {
  const params = new URLSearchParams({ q, limit: '6', lang: photonLang(), ...extra });
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
    const place = photonPlace(f);
    // same name in the same region can still be two different places: include the position
    const k = `${place.label}|${place.detail}|${place.kind}|${place.center.lat.toFixed(2)},${place.center.lon.toFixed(2)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(place);
  }
  return out;
}

export function suggest(q: string, bias: LngLat | null, signal: AbortSignal): Promise<Place[]> {
  return photonSearch(q, bias, signal);
}

/** Great-circle distance in metres (haversine). */
export function distanceM(a: LngLat, b: LngLat): number {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A postcode or administrative area is geocoded to the middle of its area, which
 * for rural postcodes is usually fields between villages. Find the settlement the
 * geocoder named for it (nearest match within 20 km) and use that instead.
 */
export async function resolveToSettlement(p: Place, signal?: AbortSignal): Promise<Place | null> {
  if ((p.kind !== 'postcode' && p.kind !== 'area') || !p.settlement) return null;
  const hits = await photonSearch(p.settlement, p.center, signal, { osm_tag: 'place', limit: '8' });
  const best = hits
    .filter((h) => h.kind && SETTLEMENT_KINDS.has(h.kind) && h.label.toLowerCase() === p.settlement!.toLowerCase())
    .map((h) => ({ h, d: distanceM(h.center, p.center) }))
    .filter((x) => x.d < 20000)
    .sort((a, b) => a.d - b.d)[0];
  if (!best) return null;
  const context = p.kind === 'postcode' ? `Postcode ${p.label}` : p.label;
  const region = best.h.detail.split(', ').slice(-1)[0];
  return { ...best.h, detail: [context, region].filter(Boolean).join(' · ') };
}

export async function searchOnce(q: string, signal?: AbortSignal): Promise<Place | null> {
  const coords = parseCoordinates(q);
  if (coords) return { label: q.trim(), detail: '', center: coords };
  const params = new URLSearchParams({ q, format: 'jsonv2', limit: '1', addressdetails: '1' });
  const res = await fetch(`${NOMINATIM}/search?${params}`, { signal, headers: { 'Accept-Language': navigator.language || 'en' } });
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
  const json = (await res.json()) as Array<{
    lat: string;
    lon: string;
    name?: string;
    display_name: string;
    category?: string;
    type?: string;
    address?: Record<string, string>;
  }>;
  const hit = json[0];
  if (!hit) return null;
  const [first, ...rest] = hit.display_name.split(', ');
  const kind = placeKind({ osm_key: hit.category, osm_value: hit.type, housenumber: hit.address?.house_number });
  const a = hit.address ?? {};
  const settlement = kind === 'postcode' || kind === 'area' ? a.village || a.town || a.city || a.hamlet || a.suburb : undefined;
  return { label: hit.name || first, detail: rest.slice(0, 3).join(', '), center: { lat: Number(hit.lat), lon: Number(hit.lon) }, kind, settlement };
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
