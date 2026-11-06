/**
 * Every text the app shows, in English. The other languages have the same keys and the same
 * function signatures (TypeScript checks it), so nothing can be left out.
 *
 * Numbers arrive already formatted for the language (decimal comma, grouping), so messages only
 * place them.
 */

export const en = {
  // the page
  homeTitle: 'Your Place · 3D city model of any address, free STL export',
  docTitle: (place: string) => `${place} in 3D · Your Place`,
  language: 'Language',
  canvasLabel: '3D model of the selected area. Arrow keys orbit and tilt, plus and minus zoom, N faces north, 0 resets the view.',
  unsupportedTitle: 'This browser can’t show the 3D model',
  unsupportedText: 'Your Place needs WebGL 2. Try a current version of Safari, Chrome, Firefox or Edge, or turn on hardware acceleration in your browser settings.',

  // search
  searchPlaceholder: 'Search an address or place',
  useLocation: 'Use my location',
  suggestions: 'Suggestions',
  exactAddress: 'Exact address',
  searchAsTyped: 'search it as typed',
  linkNoPosition: 'This link doesn’t show its position. Open it, copy the coordinates and paste those instead.',
  streetOnly: 'That house number isn’t in OpenStreetMap, so this opens on its street. Slide the model and tap your building to pin it.',
  closestMatch: 'That exact address isn’t in OpenStreetMap, so this is the closest match. Slide the model and tap your building to pin it.',
  nothingFound: (q: string) => `Nothing found for “${q}”`,
  searchUnavailable: 'Search is unavailable right now. Check your connection and try again.',
  noMatches: 'No matches — try a street and town',
  suggestionsUnavailable: 'Suggestions unavailable — press Enter to search',
  postcodeOf: (code: string) => `Postcode ${code}`,
  unnamedPlace: 'Unnamed place',
  fromMapLink: 'From a map link',
  kind: {
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
  },
  /** a place kind inside a sentence: "Kleinfelde (village)" */
  kindInSentence: {
    city: 'city',
    town: 'town',
    village: 'village',
    hamlet: 'hamlet',
    suburb: 'district',
    postcode: 'postcode area',
    area: 'area',
    street: 'street',
    address: 'address',
    poi: 'place',
  },

  // the landing page
  welcomeTitle: 'The street you grew up on, in 3D',
  welcomeLede: 'Your first home, where you met, the town you left. Type the address and get it as a model on its real terrain, every building standing on top. Share it, hang it as a poster, or 3D print it.',
  presetsLabel: 'Or explore a place with dramatic terrain',
  aboutLink: 'How it works, 3D printing tips and data sources',
  presets: {
    stuttgart: 'City in a valley basin',
    heidelberg: 'Old town on the Neckar',
    edinburgh: 'Castle Rock & Arthur’s Seat',
    lisbon: 'Seven hills on the Tagus',
    sanFrancisco: 'Nob Hill to the Bay',
    hongKong: 'Central under the Peak',
  },

  // buttons on the model
  faceNorth: 'Face north',
  faceNorthKey: 'Face north (N)',
  resetView: 'Reset view',
  resetViewKey: 'Reset view (0)',
  shareOrExport: 'Share or export',
  dismiss: 'Dismiss',
  close: 'Close',
  mouseHint: 'Drag to turn · right-drag to slide · ',
  mouseHintStrong: 'double-click to load the area there',
  hideHint: 'Hide this hint',
  gestureTouch: 'Tap a building to pin it · two fingers slide and zoom · double-tap loads the area there',
  gestureMouse: 'Click a building to pin it · right-drag or Shift-drag slides the model · double-click loads the area there',
  loadingHere: 'Loading the area around this spot',

  // loading
  stepTerrain: 'Terrain',
  stepBuildings: 'Buildings',
  stepLayers: 'Roads & water',
  stepFailed: (step: string) => `${step} unavailable`,
  retry: 'Retry',
  findingVillage: (place: string) => `Finding the village for ${place}…`,
  noGeolocation: 'Location is not available in this browser.',
  findingLocation: 'Finding your location…',
  yourLocation: 'Your location',
  locationDenied: 'Location permission was denied.',
  locationFailed: 'Couldn’t get your location.',

  // an empty square
  noBuildingsHere: 'No buildings are mapped here',
  fewBuildingsHere: (n: string, count: number) => `Only ${n} building${count === 1 ? ' is' : 's are'} mapped here`,
  fewAround: (here: string, place: string) => `${here} — OpenStreetMap has few buildings mapped around ${place} so far.`,
  noVillageWithin: (here: string, km: string) => `${here}, and there’s no village or town within ${km} km.`,
  nearest: (here: string, place: string, kind: string, distance: string, direction: string) => `${here}. ${place} (${kind}) is ${distance} ${direction}.`,
  compass: ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'],
  show4km: 'Show 4 × 4 km',
  goTo: (place: string) => `Go to ${place}`,
  near: (place: string) => `Near ${place}`,

  // a shared model, the pin
  sharedInvite: 'This place was shared with you. Make one of your own: your street, your first home, where you met.',
  makeMyPlace: 'Make my place',
  pinOnBuilding: 'Pin moved to this building. Share links now show it.',
  pinOnSpot: 'Pin moved here. Share links now show this spot.',
  centreHere: 'Centre here',
  resetPin: 'Reset pin',

  // the settings panel
  settings: 'Model settings',
  exaggeration: 'Terrain exaggeration',
  contours: 'Contour lines',
  contourEvery: (m: string) => `every ${m} m`,
  buildings: 'Buildings',
  style: { white: 'White', grey: 'Grey', sand: 'Sand', dark: 'Dark', ramp: 'By height' },
  legendTop: (m: string) => `${m}+ m`,
  area: 'Area',
  mapLayers: 'Map layers',
  layer: { roads: 'Roads', water: 'Water', green: 'Green' },
  terrainTimes: (x: string) => `terrain ×${x}`,
  attribution: 'Map data © OpenStreetMap contributors (ODbL), map tiles © OpenMapTiles via OpenFreeMap. Terrain: Mapzen, AWS Terrain Tiles.',
  footerContributors: 'contributors',
  footerTerrain: 'Terrain:',

  // the description under the settings, also read out by screen readers
  aroundPlace: (area: string, place: string) => `${area} around ${place}.`,
  nearPlace: (area: string, place: string) => `${area} near ${place}.`,
  thisPoint: 'this point',
  ground: (low: string, high: string, relief: string) => `Ground from ${low} m to ${high} m above sea level (${relief} m of relief).`,
  buildingCount: (n: string, tallest: string) => `${n} buildings; the tallest is about ${tallest} m.`,
  noBuildingsSquare: 'No buildings are mapped in this square.',
  estimated: (pct: string) => `Heights estimated for ${pct}% of buildings — OpenStreetMap has no height or floor count for them.`,
  sceneDescription: (summary: string) =>
    `3D model. ${summary} Arrow keys orbit and tilt, Shift and arrow keys slide, plus and minus zoom, N faces north, 0 resets the view. Click a building to move the pin there.`,

  // the share dialog
  shareTitle: 'Share this model',
  shareNote: 'The link holds the coordinates, your view and the pin, never the address you typed. With a pin, it shows exactly that building.',
  shareLink: 'Share link',
  copyLink: 'Copy link',
  shareNative: 'Share…',
  linkCopied: 'Link copied.',
  selectLink: 'Select the link above and copy it.',
  shareInApp: (place: string) => `${place} in 3D`,
  shareText: (place: string) => `${place} in 3D. Make one of your own place:`,
  thisPlace: 'This place',
  titleField: 'Title on the poster and print',
  secondLine: 'Second line',
  optional: 'optional',
  secondLineExample: 'Where we met · June 2019',
  posterButton: 'Download poster (PNG)',
  renderingPoster: 'Rendering poster…',
  posterSaved: 'Poster saved',
  posterFailed: 'Couldn’t render the poster on this device.',

  // 3D printing
  printSize: '3D print size',
  tileSize: 'Size of each tile',
  tilesNote: (count: string, totalCm: string, scale: string) => `${count} tiles, ${totalCm} × ${totalCm} cm in all · ${scale}`,
  tilesLabel: 'Split into tiles that fit your print bed',
  onePiece: 'One piece',
  tilesOut: (n: number) => `${n} × ${n} tiles`,
  titleStrip: 'Add the title in raised letters on a strip in front',
  paintEdges: 'Edges to paint along',
  sinkWater: 'Sink water 1 mm',
  raiseRoads: 'Raise roads 0.4 mm',
  raiseGreen: 'Raise parks and woods 0.6 mm',
  stlButton: 'Download 3D print file (STL)',
  stlTilesButton: 'Download 3D print tiles (ZIP of STL files)',
  stillLoading: 'Still loading the buildings — try again in a moment.',
  buildingPrint: 'Building the 3D print file…',
  printFailed: 'Couldn’t build the 3D print file on this device.',
  printSquare: (cm: string) => `${cm} × ${cm} cm`,
  printWithStrip: (cm: string, deepCm: string) => `${cm} × ${deepCm} cm with the title strip`,
  saved: (size: string, scale: string, triangles: string, mb: string) => `Saved: ${size} at ${scale}, ${triangles} triangles (${mb} MB).`,
  savedTiles: (count: string, tileCm: string, totalCm: string, strip: boolean, scale: string, triangles: string, mb: string) =>
    `Saved: ${count} tiles of ${tileCm} cm, ${totalCm} × ${totalCm} cm in all${strip ? ', and the title strip as its own piece' : ''}, at ${scale}, ${triangles} triangles (${mb} MB).`,
  waterSunk: (mm: string) => ` Water sunk ${mm} mm.`,
  greenRaised: (mm: string) => ` Parks and woods raised ${mm} mm.`,
  roadsRaised: (mm: string) => ` Roads raised ${mm} mm.`,
  brokenLeftOut: (n: string, count: number) => ` ${n} building${count === 1 ? '' : 's'} with a broken outline in the map data left out.`,
  brokenInTile: ' A building with a broken outline in the map data was left out.',
  fontMissing: (chars: string, count: number) => ` The font has no ${chars}, so ${count === 1 ? 'it was' : 'they were'} left off the title.`,

  // the note in the tiles' ZIP
  readmeSize: (area: string, count: string, n: number, tileCm: string, totalCm: string, scale: string, ex: string) =>
    `${area}, ${count} tiles (${n} x ${n}) of ${tileCm} cm, ${totalCm} x ${totalCm} cm in all, ${scale}, terrain x${ex}.`,
  readmeGrid: 'Tiles are named by row and column like a map grid: row A is the north edge (the back), column 1 the west (left).',
  readmeCorners: (last: string) => `A1 is the north-west corner, ${last} the south-east. Print each tile flat, base down, at 100%; they fit edge to edge.`,
  readmeStrip: 'title.stl is the title strip: put it in front of the bottom row, in the middle.',
  readmeWater: (mm: string) => `Water (lakes, rivers mapped as areas, the sea) sits ${mm} mm below the land, with an edge to paint along.`,
  readmeGreen: (mm: string) => `Parks, gardens and woods stand ${mm} mm above the land.`,
  readmeRoads: (mm: string) => `Roads, paths and railways stand ${mm} mm above the ground, with sharp edges.`,
  readmeCredit: 'Map data © OpenStreetMap contributors (ODbL). Terrain: Mapzen terrain tiles on AWS Open Data.',
};

export type Messages = typeof en;
