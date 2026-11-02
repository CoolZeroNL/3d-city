# Your Place — 3D city topography model

Type an address, get a tilt-and-orbit miniature of the surrounding 1, 2 or 4 km: the real terrain
underneath, every mapped building extruded on top, roads, water and green areas draped over the
ground. It looks like a physical architectural model — matte, soft shadows, a plinth whose side
walls show the terrain cross-section.

This is the MVP of the spec "Your Place: 3D City Topography Model" (Claude Docs), built as a
mobile-first TypeScript web app on three.js.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ — host it anywhere (relative paths)
npm test           # unit tests (vitest)
npm run e2e        # build + headless-browser smoke test (needs Playwright), screenshots in e2e/out/
```

## What's in the MVP

| Spec feature | Status |
| --- | --- |
| Address search with autocomplete, "use my location", raw `lat, lon` input | ✅ |
| 3D terrain mesh, 1×–5× vertical exaggeration | ✅ |
| Extruded buildings: OSM `height` → `building:levels` × 3 m → neighbourhood median, estimated heights flagged | ✅ (no LiDAR step yet) |
| Roads, water, parks as colour-coded, toggleable layers | ✅ |
| Orbit / tilt (0–70°) / zoom with touch, mouse and keyboard; compass resets north | ✅ |
| Share link with the camera in the URL (coordinates only, never the typed address) | ✅ |
| PNG poster export with title, coordinates and attribution | ✅ |
| Contour lines, interval auto-scaled to relief (5 / 10 / 20 m) | ✅ (v1.1 in the spec, cheap to include) |
| Area size 1 / 2 / 4 km, white-block or height-colour buildings | ✅ |
| Progressive loading: terrain → buildings → roads/water/vegetation, with retry | ✅ |
| Accessibility: keyboard camera, text description of the area, reduced motion, colour-blind-safe ramp | ✅ |
| Installable PWA (manifest + app-shell service worker), WebGL 2 check | ✅ |
| Elevation profile, poster PDF (A3/A2), STL/3MF export, imagery drape, compare, time slider | ⏳ later phases |

## How it works

```
search ─▶ geocode (Photon / Nominatim)
            │
            ▼
   ┌── terrain tiles (Terrarium PNG, AWS) ──▶ N×N height grid ──▶ terrain mesh + plinth  ─┐
   ├── Overpass: buildings ──▶ footprints ─▶ height rule ─▶ one merged extruded mesh        ├─▶ three.js scene
   └── Overpass: roads/water/green/coastline ─▶ canvas texture draped on the terrain        ─┘
                                              └▶ sea mask from coastlines → flatten to 0 m
```

- `src/geo/` — data: projection, polygon utilities, terrain tiles, Overpass queries and parsing,
  the height rule, coastline sea fill, geocoding, an IndexedDB cache for Overpass responses.
- `src/scene/` — rendering: terrain + plinth, merged building mesh, the draped map-layer texture,
  shader patches (contour lines, contact darkening), the viewer (camera, lights, controls, export).
- `src/ui/` — search combobox, loading status, poster composition. `src/main.ts` wires it together.

Design notes:

- **Exaggeration applies to terrain only.** Each building vertex keeps its ground elevation and its
  height above ground, so moving the slider re-evaluates `y = (ground − ref) × ex + height` without
  rebuilding geometry; contour lines are computed per fragment from the real elevation.
- **Map layers are a texture, not geometry.** Rasterising roads/water/green into one canvas keeps
  them glued to the terrain at any exaggeration and costs no triangles; toggling a layer is a redraw.
- **The sea comes from coastlines, not elevation.** Terrain tiles report harbour water as ~0 m while
  polders sit below sea level, so elevation can't tell them apart. OSM coastlines (land on the left)
  are rasterised and the sea side flood-filled, then checked against the terrain before use.
- **Renders on demand.** Frames are drawn only while the camera moves or something changes.

## Decisions against the spec's open questions

- **Renderer:** three.js, not MapLibre — the physical-model look (plinth walls, contact shadow,
  poster renders, later STL export) needs full control of the geometry.
- **Data path:** the spec's production design builds tiles on a server and serves them from a CDN.
  This prototype fetches public APIs straight from the browser, behind small interfaces
  (`loadHeightGrid`, `overpass`, `suggest`) that a tile server can replace.
- **Elevation:** Mapzen/AWS Terrarium tiles (worldwide, CORS, no key; ~10–30 m sources incl.
  SRTM, EU-DEM, 3DEP) instead of Copernicus GLO-30 GeoTIFFs, which need server-side processing.

## Data and licences

- Map data © OpenStreetMap contributors, ODbL — attribution is shown in the app and on posters.
- Terrain: Mapzen terrain tiles on AWS Open Data — see the
  [attribution list](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
- Geocoding: [Photon](https://photon.komoot.io) (type-ahead) and
  [Nominatim](https://nominatim.org) (single lookups only, per its usage policy).
- Public Overpass, Photon and Nominatim instances are shared community services with rate limits.
  Fine for a prototype; production should use the planned tile server and a paid geocoder.

## Known limitations

- No LiDAR surface model yet, so many heights are estimates (the app says how many).
- Building parts follow Simple 3D Buildings only partly: roofs are flat, outlines hosting
  `building:part`s are dropped.
- Terrain sea-floor values are clamped at −30 m until coastlines arrive; places far below sea level
  (Dead Sea, Death Valley) are flattened by that clamp.
- No level of detail yet; the 4 km area at full density can be heavy on older phones.

## Testing

`npm test` covers projection, terrain decoding/resampling, polygon clipping and ring assembly,
OSM parsing (multipolygons, courtyards, building parts, clipping), the height rule, the sea fill,
building-mesh winding and exaggeration, and URL state.

`npm run e2e` serves the build, answers Overpass and geocoding from a deterministic synthetic city
(`e2e/fixtures/synthetic-city.mjs`), uses real terrain tiles, and drives search, every control,
keyboard camera, share link round-trip, poster download, an Overpass outage with retry, a phone
viewport, and dark mode with reduced motion. It fails on any console error.
