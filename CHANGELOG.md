# Changelog

## 1.1.2 — 2026-11-04

- No more needles in browsers with fingerprinting protection (Orion, Brave, Safari private windows and others). Those browsers add tiny random noise to images a page reads back, and the elevation tiles store height in their colours (one step of red is 256 m), so the whole terrain turned into spikes. The tiles are now decoded from their bytes instead of through a canvas, which gives exact heights in every browser.
- A tool for diagnosing odd-looking models: the "Inspect a place" workflow renders any place from live data and lists its tallest, thinnest and malformed buildings.

## 1.1.1 — 2026-11-04

- No more spikes in the terrain. The elevation data has small holes in a few places (Hong Kong's and New York's waterfronts drop thousands of metres in patches of a few pixels), which showed as deep needles at any exaggeration. Small patches far below sea level and ringed by land are now filled with the height around them; real cliffs, gorges and open water are left as they are.

## 1.1.0 — 2026-11-04

From the first feedback after launch.

### Search finds the right house
- Enter only takes the top suggestion when it carries the house number you typed. Otherwise the full address goes to Nominatim, which handles exact addresses (and numbered avenues and streets) better. If it isn't in OpenStreetMap either, the closest match opens with a note to pin your building by hand.
- Paste a map link from Google Maps, Apple Maps, OpenStreetMap or Bing, or a `geo:` link, and the model opens at that spot. Links and coordinates are no longer sent for suggestions.

### A model to share
- The start screen leads with the places that matter to people: the street you grew up on, where you met, the town you left.
- Someone who opens a shared model is invited to make one of their own place.
- Sharing from a phone adds "Make one of your own place" to the message, and the share dialog says plainly that a pinned link shows exactly that building.

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
