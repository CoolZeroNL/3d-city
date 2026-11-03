# Changelog

## 1.0.0 — 2026-11-03

First public release.

### What it does
- Type an address, street, village, postcode or `lat, lon` and get a 3D model of the 1, 2 or 4 km around it,
  built in the browser: real terrain underneath, every mapped building standing on top, roads, water and green areas on the ground.
- Terrain exaggeration from 1× to 5×, contour lines, white or height-coloured buildings, sea from OpenStreetMap coastlines.
- Turn, tilt, zoom and slide by touch, mouse or keyboard. Tap a building to pin it; "Centre here" rebuilds the square around it.
- Share links hold the coordinates, the view and the pin, never the typed address.
- Downloads: a poster image (PNG) with the place name and coordinates, and a watertight STL file for 3D printing
  (10, 15 or 20 cm wide, on a 3 mm base, terrain exaggeration as on screen).
- Postcode and county searches resolve to their village; an empty square offers the nearest village.
- Works on phones, installs as an app, dark mode, keyboard camera, a text description of the area.

### For search engines and link previews
- Page title, description, canonical link, Open Graph and Twitter preview image, structured data.
- A "How it works" page with 3D printing tips, privacy notes and data sources.
- `sitemap.xml` and `robots.txt`.

### Data
- Map data © OpenStreetMap contributors (ODbL), vector tiles from OpenFreeMap (© OpenMapTiles), terrain from the
  Mapzen terrain tiles on AWS Open Data, address search by Photon (komoot) and Nominatim. Overpass is the fallback for map data.
