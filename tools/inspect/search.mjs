// Shows what the two search services make of addresses, for reports like "my address isn't found".
// Photon gives the type-ahead suggestions, Nominatim the exact search on Enter (src/geo/geocode.ts).
// Runs on GitHub Actions through .github/workflows/search-check.yml, which prints to the log.
// Nominatim allows one request a second: this waits between them.

const UA = 'YourPlace address check (+https://github.com/yourplace3d/3d-city)';
const queries = (process.env.SEARCH_QUERIES || '').split('|').map((q) => q.trim()).filter(Boolean);
if (!queries.length) {
  console.error('Set SEARCH_QUERIES to addresses separated by |');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return res.json();
}

async function photon(q) {
  const json = await get(`https://photon.komoot.io/api/?${new URLSearchParams({ q, limit: '5', lang: 'en' })}`);
  if (json.error) return [json.error];
  return (json.features ?? []).map(({ properties: p }) =>
    [p.housenumber, p.street ?? p.name, p.city ?? p.county, p.state, p.postcode, `${p.osm_key}=${p.osm_value}`].filter(Boolean).join(' · '),
  );
}

let lastNominatim = 0;
async function nominatim(params) {
  const wait = lastNominatim + 1200 - Date.now();
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  const json = await get(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ format: 'jsonv2', limit: '2', addressdetails: '1', ...params })}`);
  if (json.error) return [json.error];
  return json.map((h) => `${h.address?.house_number ? '[house] ' : ''}${h.display_name} (${h.category}=${h.type})`);
}

/** The variants the app could try when the address as typed finds nothing. */
function variants(q) {
  const out = [];
  const cleaned = q
    .replace(/\b(apt|apartment|unit|suite|ste|lot|#)\s*[\w-]+/gi, '')
    .replace(/\b(\d{5})-\d{4}\b/, '$1')
    .replace(/,?\s*(usa|united states( of america)?)\s*$/i, '')
    .replace(/\s+,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (cleaned !== q) out.push(['without unit / ZIP+4 / country', { q: cleaned }]);
  // "123 Main St, Town, TN 37000" → structured
  const m = /^(\d+[a-z]?\s+[^,]+),\s*([^,]+?),\s*([a-z]{2}|[a-z ]+?)\s*(\d{5})?$/i.exec(cleaned);
  if (m) {
    const [, street, city, state, zip] = m;
    out.push(['structured', { street, city, state, ...(zip ? { postalcode: zip } : {}), countrycodes: 'us' }]);
    out.push(['structured, no town', { street, state, ...(zip ? { postalcode: zip } : {}), countrycodes: 'us' }]);
    if (zip) out.push(['street and ZIP only', { q: `${street}, ${zip}` }]);
  }
  return out;
}

for (const q of queries) {
  console.log(`\n=== ${q}`);
  console.log('  Photon (suggestions):');
  for (const line of await photon(q)) console.log(`    ${line}`);
  console.log('  Nominatim (Enter):');
  for (const line of await nominatim({ q })) console.log(`    ${line}`);
  for (const [label, params] of variants(q)) {
    console.log(`  Nominatim, ${label}: ${JSON.stringify(params)}`);
    const hits = await nominatim(params);
    for (const line of hits.length ? hits : ['(nothing)']) console.log(`    ${line}`);
  }
}
