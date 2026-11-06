# Changelog

## 1.6.1 — 2026-11-06

- Clearer streets: roads have a darker, wider edge, so white roads no longer fade into the beige ground. On screen and on the poster; the 3D print is unchanged. Suggested on Reddit.

## 1.6.0 — 2026-11-06

- Your Place in Portuguese (Brazil) and German, as well as English. It follows the browser's language, or pick one under the settings or on the start page; the choice is remembered on that device. Numbers follow the language too (1,5 × 1,5 km, 1:13.300). Share links carry no language, so each visitor sees the app in their own. The "How it works" page stays in English for now.

## 1.5.0 — 2026-11-06

- Buildings in more colours: white, grey, sand or dark, or coloured by height, picked from a row of swatches. Share links keep the choice. Suggested on Reddit: white buildings blended into the streets.
- Height colours no longer use greens and blues, which looked like parks and water: they now run from yellow through orange and magenta to deep indigo. Suggested on Reddit.

## 1.4.0 — 2026-11-06

- Raised roads in the 3D print: roads, paths and railways stand 0.4 mm above the ground with sharp edges, as their own pieces that follow the terrain, so they're easy to paint. At small scales only the roads wide enough to print are kept. Off by default; tick it in the share dialog. Suggested on Reddit.
- Raised parks and woods: parks, gardens, pitches and woods stand 0.6 mm above the land (water inside them stays sunk). Off by default. Suggested on Reddit.
- Clearer wording for the title option: "Add the title in raised letters on a strip in front".

## 1.3.2 — 2026-11-06

- Water sinks 1 mm into the 3D print: lakes, rivers mapped as areas and the sea sit a little below the land, so they stand out and have an edge to paint along. The same 1 mm at any scale and exaggeration, in one piece or in tiles; untick it in the share dialog to keep the water level. Suggested on Reddit.

## 1.3.1 — 2026-11-05

- Prints in up to 8 × 8 tiles, for a model to hang on the wall: 64 tiles of 20 cm make 1.6 m across, and a 4 km area at that size is about 1:2,500. The tile choice is a slider now. Suggested on Reddit.

## 1.3.0 — 2026-11-05

Both suggested on Reddit.

### Any area, from 300 m to 4 km
- The area is a slider now, from 300 m to 4 km in 100 m steps, instead of 1, 2 or 4 km. Share links carry the exact size; older links still work.
- Small areas print with much bigger houses: 500 m on a 15 cm print is 1:3,330, so a 10 m house stands 3 mm tall.

### 3D prints in tiles
- Split the print into 2 × 2, 3 × 3 or 4 × 4 tiles that fit your print bed. Each tile is the print size you pick, so 3 × 3 tiles of 20 cm make a 60 cm model.
- The download is a ZIP: one STL per tile, named like a map grid (A1 is the north-west corner), the title ledge as its own piece, and a note on how they go together.
- The tiles fit edge to edge on one base, and buildings are cut exactly at the seams. Every tile is checked to print as closed solids.

## 1.2.0 — 2026-11-05

### Your own title
- Give the poster your own title and an optional second line ("Where we met · June 2019"). It starts as the place's name; the file is named after it.
- The 3D print can carry the same title in raised letters on a ledge in front of the model (on by default, untick it for a plain square). The letters scale to the print size, shrink to fit a long title, and every one of its 328 characters (Latin letters with their accents, digits, punctuation) is checked to print as a closed solid. Inter Bold, under the SIL Open Font License.

### Easier to move around
- Double-click (computer) or double-tap (phone) a spot to load the area around it in one go, instead of pinning it and pressing "Centre here".
- On a computer, a small hint shows the mouse controls until you close it: drag to turn, right-drag to slide, double-click to load the area there.

### Search takes you literally
- When the suggestions don't carry the house number you typed, the first row is now your address exactly as typed, above the type-ahead guesses ("10 St" for "10 Ave"). Picking it, or pressing Enter, searches the exact text.
- An address that isn't found as typed is tried again without its unit ("Apt 2", "Suite 300"), ZIP+4 and country, then by street and ZIP code. If the house number isn't in OpenStreetMap at all, which is common for rural addresses, the model opens on its street with a note to pin your house, instead of "Nothing found".

### Fewer hills that are really roofs
- Where the elevation data measured roofs (Anchorage, Singapore and others), buildings without a height in OpenStreetMap were still sitting inside hills of their own roofs: the map tiles give them 5 m, and a 24 m bump looked too tall to be their roof. They now come back out of the ground, and take their height from the roof the data measured. In downtown Anchorage, bumps over 8 m under large buildings go from 7 to none, and 59 buildings get a measured height.
- A building near a bluff is no longer mistaken for one on a hill: a real hill falls away in nearly every direction, a bluff on one side. Downtown Anchorage sits on one above Ship Creek.

## 1.1.3 — 2026-11-04

- Large buildings no longer sit on hills of their own making. In some regions the free elevation data comes from radar satellites that see roofs, not the ground, so big buildings showed up as smooth bumps up to tens of metres high, with the real building on top. Where many large buildings sit on such bumps, the ground under them is now lowered to street level around them. In Singapore's centre this removes 55 of 71 roof bumps. Real hills stay: a bump much higher than the buildings around it, or one where the ground keeps falling further out, is left alone, so Edinburgh's castle rock and Salzburg's fortress hill are untouched, as is everywhere with bare-ground data (Germany, the US).

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
