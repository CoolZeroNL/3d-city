/**
 * Geocoding for the prototype:
 *  - Photon (komoot, OSM-based) for type-ahead suggestions — it is built for autocomplete.
 *  - Nominatim for a single lookup when the user submits without picking a suggestion
 *    (Nominatim's usage policy forbids autocomplete traffic).
 * Production should move this behind the app's own server (spec: privacy).
 */

import { t } from '../i18n';
import type { LngLat } from './projection';

export type PlaceKind = 'city' | 'town' | 'village' | 'hamlet' | 'suburb' | 'postcode' | 'area' | 'street' | 'address' | 'poi';

export interface Place {
  label: string;
  detail: string;
  center: LngLat;
  kind?: PlaceKind;
  /** for postcode and area results: the town or village the geocoder associates with it */
  settlement?: string;
  /** the house number, when the result is an address */
  housenumber?: string;
  /** the house number wasn't found, so this is its street */
  streetOnly?: boolean;
}

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
const formatLinkLabel = (c: LngLat) => `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`;
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
  const label = p.name && p.name !== p.street ? p.name : street || p.name || p.city || p.state || t.unnamedPlace;
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
  return { label, detail, center: { lon, lat }, kind, settlement, housenumber: p.housenumber };
}

const validLatLon = (lat: number, lon: number) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180;

/**
 * Coordinates from a pasted map link: Google Maps (the place's own pin, a ?q= or the view centre),
 * Apple Maps (ll, q, coordinate), OpenStreetMap (marker or #map view), Bing (cp) and geo: URIs.
 * Short links (maps.app.goo.gl and similar) hide the position and return null.
 */
export function parseMapLink(q: string): LngLat | null {
  const s = q.trim();
  if (!/^(https?:\/\/|geo:)/i.test(s)) return null;
  let t = s;
  try {
    t = decodeURIComponent(s);
  } catch {
    /* keep it as typed */
  }
  const n = '(-?\\d{1,3}(?:\\.\\d+)?)';
  const patterns = [
    `!3d${n}!4d${n}`, // Google: the place itself
    `[?&](?:q|query|ll|sll|coordinate|center|daddr|destination)=${n},\\s*\\+?${n}`, // Google and Apple queries
    `[?&]mlat=${n}&mlon=${n}`, // OpenStreetMap marker
    `#map=\\d+(?:\\.\\d+)?/${n}/${n}`, // OpenStreetMap view
    `/(?:search|place|dir)/${n},\\s*\\+?${n}`, // Google paths
    `@${n},${n}`, // Google view centre
    `^geo:${n},${n}`, // geo: URI
    `[?&]cp=${n}~${n}`, // Bing
  ];
  for (const p of patterns) {
    const m = new RegExp(p, 'i').exec(t);
    if (!m) continue;
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (validLatLon(lat, lon)) return { lat, lon };
  }
  return null;
}

/** House-number-like tokens in a typed address ("12", "12a"); ordinals such as "5th" are street names. */
export function typedNumbers(q: string): string[] {
  return (q.match(/(?<![\p{L}\d])\d{1,6}[a-z]?(?![\p{L}\d])/giu) ?? []).map((x) => x.toLowerCase());
}

/**
 * Whether the top suggestion fits what was typed well enough to take it on Enter. When the
 * typed text has a number and the suggestion doesn't carry it (a street instead of the house,
 * "10 St" for "10 Ave"), it doesn't: the full address goes to Nominatim instead.
 */
export function suggestionFits(q: string, p: Place): boolean {
  const numbers = typedNumbers(q);
  if (!numbers.length) return true;
  if (!/\p{L}{2,}/u.test(q.replace(/\d+[a-z]?/gi, ''))) return true; // a bare postcode
  const own = [p.housenumber, p.kind === 'postcode' ? p.label : undefined].filter(Boolean).map((x) => x!.toLowerCase().replace(/\s+/g, ''));
  return own.some((x) => numbers.includes(x));
}

/**
 * Whether to offer the typed text itself as the first choice: an address with a house number
 * that the top suggestion doesn't carry (or no suggestion at all). Enter searches it then.
 */
export function offerTyped(q: string, top: Place | undefined): boolean {
  if (!typedNumbers(q).length || !/\p{L}{2,}/u.test(q.replace(/\d+[a-z]?/gi, ''))) return false;
  return !top || !suggestionFits(q, top);
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
  const context = p.kind === 'postcode' ? t.postcodeOf(p.label) : p.label;
  const region = best.h.detail.split(', ').slice(-1)[0];
  return { ...best.h, detail: [context, region].filter(Boolean).join(' · ') };
}

/** An address without what trips the search up: unit numbers, ZIP+4, a trailing country. */
export function cleanAddress(q: string): string {
  return q
    // a unit is a designator and a number or a single letter ("Apt 2", "Suite 300", "Unit B");
    // not "United", "Ste-Foy" or "FL 32801"
    .replace(/[,\s]*\b(apt|apartment|unit|suite|ste|lot|bldg|building|floor|rm|room)\b\.?\s*#?\s*(?:[\w-]*\d[\w-]*|[a-z])\b/gi, '')
    .replace(/[,\s]*#\s*[\w-]+/g, '')
    .replace(/\b(\d{5})-\d{4}\b/, '$1')
    .replace(/[,\s]*\b(usa|u\.s\.a\.|united states( of america)?)\s*$/i, '')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * What to ask Nominatim, in order, until something is found: the address as typed; without unit,
 * ZIP+4 and country; the street with only its ZIP code (US postal towns often aren't the town
 * the map puts the house in); then the street without the house number, when the number isn't in
 * the data (common for rural addresses).
 */
export function searchVariants(q: string): { q: string; streetOnly: boolean }[] {
  const out: { q: string; streetOnly: boolean }[] = [];
  const add = (v: string, streetOnly = false) => {
    if (v && /\p{L}{2,}/u.test(v) && !out.some((o) => o.q.toLowerCase() === v.toLowerCase())) out.push({ q: v, streetOnly });
  };
  add(q.trim());
  if (!typedNumbers(q).length) return out; // a place name: nothing to take apart
  const clean = cleanAddress(q);
  add(clean);
  const parts = clean.split(',').map((x) => x.trim()).filter(Boolean);
  const zip = /\b(\d{5})\s*$/.exec(clean)?.[1];
  if (zip && parts.length > 2) add(`${parts[0]}, ${zip}`);
  // the street: the house number leads ("350 5th Avenue") or trails ("Hauptstraße 12")
  const first = parts[0] ?? '';
  const street = /^\d+[a-z]?\s+(?=\S)/i.test(first) ? first.replace(/^\d+[a-z]?\s+/i, '') : first.replace(/\s+\d+[a-z]?$/i, '');
  if (street !== first) add([street, ...parts.slice(1)].join(', '), true);
  return out;
}

/** Nominatim allows a request a second; a search may try a few variants in a row. */
let lastNominatim = 0;
async function nominatimSearch(q: string, signal?: AbortSignal) {
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  signal?.throwIfAborted();
  lastNominatim = Date.now();
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
  return json[0] ?? null;
}

export async function searchOnce(q: string, signal?: AbortSignal): Promise<Place | null> {
  const coords = parseCoordinates(q);
  if (coords) return { label: q.trim(), detail: '', center: coords };
  const linked = parseMapLink(q);
  if (linked) return { label: formatLinkLabel(linked), detail: t.fromMapLink, center: linked };
  for (const v of searchVariants(q)) {
    const hit = await nominatimSearch(v.q, signal);
    if (!hit) continue;
    const [first, ...rest] = hit.display_name.split(', ');
    const kind = placeKind({ osm_key: hit.category, osm_value: hit.type, housenumber: hit.address?.house_number });
    const a = hit.address ?? {};
    const settlement = kind === 'postcode' || kind === 'area' ? a.village || a.town || a.city || a.hamlet || a.suburb : undefined;
    const place: Place = { label: hit.name || first, detail: rest.slice(0, 3).join(', '), center: { lat: Number(hit.lat), lon: Number(hit.lon) }, kind, settlement };
    return v.streetOnly ? { ...place, streetOnly: true } : place;
  }
  return null;
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
    // County and state names are too vague to title a model with; the app names it after
    // the nearest village instead (from the map tiles).
    const label = p.district || p.city || '';
    if (!label) return null;
    return { label, detail: [p.city !== label ? p.city : '', p.country].filter(Boolean).join(', '), center: c };
  } catch {
    return null;
  }
}
