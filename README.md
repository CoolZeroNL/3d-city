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

## Live site and deploys

**https://adam2kg.github.io/3d-city/**

`.github/workflows/pages.yml` runs the unit tests, builds, and publishes `dist/` to GitHub Pages on
every push to `main` (or manually from the Actions tab). One-time setup: **Settings → Pages →
Build and deployment → Source: GitHub Actions**.

## What's in the MVP

| Spec feature | Status |
| --- | --- |
| Address search with autocomplete, "use my location", raw `lat, lon` input | ✅ |
| Villages and postcodes: postcode areas resolve to their village; a (nearly) empty square offers the nearest village or town | ✅ |
| 3D terrain mesh, 1×–5× vertical exaggeration | ✅ |
| Extruded buildings: OSM `height` → `building:levels` × 3 m → neighbourhood median, estimated heights flagged | ✅ (no LiDAR step yet) |
| Roads, water, parks as colour-coded, toggleable layers | ✅ |
| Orbit / tilt (0–70°) / zoom / slide with touch, mouse and keyboard; compass resets north | ✅ |
| Pin a house: tap or click a building to move the pin onto it (marked in the accent colour); share links carry it; "Centre here" rebuilds the square around it | ✅ |
| Share link with the camera in the URL (coordinates only, never the typed address) | ✅ |
| PNG poster export with title, coordinates and attribution | ✅ |
| 3D print file: watertight binary STL in millimetres, 10 / 15 / 20 cm wide, terrain exaggeration as on screen | ✅ |
| Contour lines, interval auto-scaled to relief (5 / 10 / 20 m) | ✅ (v1.1 in the spec, cheap to include) |
| Area size 1 / 2 / 4 km, white-block or height-colour buildings | ✅ |
| Progressive loading: terrain → buildings → roads/water/vegetation, with retry | ✅ |
| Accessibility: keyboard camera, text description of the area, reduced motion, colour-blind-safe ramp | ✅ |
| Installable PWA (manifest + app-shell service worker), WebGL 2 check | ✅ |
| Elevation profile, poster PDF (A3/A2), multi-colour 3MF, imagery drape, compare, time slider | ⏳ later phases |
| Coloured or painted buildings, photos on buildings | ⏳ later (see "Ideas for later") |

## How it works

```
search ─▶ geocode (Photon / Nominatim)
            │
            ▼
   ┌── terrain tiles (Terrarium PNG, AWS) ──▶ N×N height grid ──▶ terrain mesh + plinth     ─┐
   ├── vector tiles (OpenFreeMap): buildings with heights ──▶ one merged extruded mesh      ├─▶ three.js scene
   └── vector tiles: roads/water/green/sea ──▶ canvas texture draped on the terrain         ─┘
                                           └▶ sea polygons → flatten to 0 m
       (Overpass API only when the tiles fail: raw OSM, height rule, coastline flood fill)
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
- **Rural searches land on the village, not in a field.** Geocoders place a postcode or
  administrative area at the middle of its area — for rural postcodes that is open country between
  villages. Such results are resolved to the settlement the geocoder names for them, and a square
  with fewer than 10 buildings offers the nearest village or town outside it ("Dorstadt is 2.0 km
  north-east — Go to Dorstadt").
- **The print is a union of closed shells.** The STL holds a terrain block (height grid on top,
  side walls, flat base) and one closed prism per building that starts inside the block. Slicers
  union overlapping shells, so a building on a slope is exactly "the part above ground" without any
  boolean geometry in the browser. Scale is the print width over the square (15 cm for 2 km is
  1:13,300); buildings keep their real height at that scale, the terrain uses the on-screen
  exaggeration, and the base is 3 mm under the lowest point.
- **Every shell is closed, and no two shells touch.** Map data is messy, so each footprint is
  cleaned (repeated points, points on straight walls, hairline spikes), checked (simple rings,
  courtyards clear of the outer wall, a roof triangulation whose boundary is exactly the walls'
  top edges) and repaired with a polygon union when needed. Buildings cut by tile edges are joined
  again, and every building is inset by about 0.01 mm so terraced houses and stacked building
  parts never share a point (slicers close gaps that small). An outline that cannot be repaired is
  left out, and the dialog says so. Checked with trimesh on live data for Stuttgart 2 and 4 km,
  Barcelona's Eixample, Berlin courtyards, Hong Kong and a village: 38,692 shells, all watertight
  and outward-facing; one Barcelona building was left out.
- **Renders on demand.** Frames are drawn only while the camera moves or something changes.

## Controls

| | Touch | Mouse | Keyboard (model focused) |
| --- | --- | --- | --- |
| Turn and tilt | one finger | drag | arrow keys |
| Slide | two fingers | right-drag or Shift-drag | Shift + arrow keys |
| Zoom | pinch | wheel | + / − |
| Move the pin | tap a building or the ground | click | — |
| North up / reset | compass / reset buttons | | N / 0 |

## Ideas for later

- **Colour the blocks.** The OpenMapTiles building layer has a `colour` field (from OSM
  `building:colour` / `building:material`) where mappers recorded one, so a "real colours" style is
  cheap. Letting people paint their own house builds on the pin, which already marks one building.
- **Photos on the buildings.** Aerial imagery on roofs and ground is the realistic first step —
  the hard part is an imagery licence that allows it. Street-level photos on façades are a much
  bigger job (coverage, licensing, matching photos to walls).
- **Multi-colour 3MF** (terrain, buildings, roads and water as separate parts for AMS-style printers),
  a name engraved in the base, and **poster styles** (title layouts, colours).

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
building-mesh winding and exaggeration, URL state, and the STL export (every shell closed and
outward-facing, volumes, binary format).

`npm run e2e` serves the build, answers Overpass and geocoding from a deterministic synthetic city
(`e2e/fixtures/synthetic-city.mjs`), uses real terrain tiles, and drives search, every control,
keyboard camera, pinning a building (click, drag, share-link round-trip, "Centre here"),
Shift-arrow and two-finger sliding, share link round-trip, poster download, STL download (size and
base checked), an Overpass outage with retry, a phone
viewport, and dark mode with reduced motion. It fails on any console error.

## Licence

The code is released under the [MIT Licence](LICENSE). Map data and terrain shown by the app keep
their own licences (see "Data and licences" above).
