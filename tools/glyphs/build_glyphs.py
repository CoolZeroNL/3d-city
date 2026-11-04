"""Builds src/export/glyphs/inter-bold.json: Inter Bold glyph outlines as flat polygons.

The 3D print raises the model's title on a ledge, and the letters go through the same
watertight prism builder as the buildings, so each glyph is stored as polygons (outer ring plus
holes) in font units scaled to 1000 per em, with curves already flattened. No font parser is
needed in the browser.

Run once when the character set changes:  python3 tools/glyphs/build_glyphs.py [path/to/Inter-Bold.otf]
Needs fontTools and skia-pathops (pip install fonttools skia-pathops): some glyphs (#, æ, ...) are
drawn as overlapping pieces, which are merged first so every outline is a clean, simple polygon.
Inter is © The Inter Project Authors, SIL Open Font License 1.1 (see src/export/glyphs/OFL.txt).
"""
import json, math, sys
import pathops
from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen

FONT = sys.argv[1] if len(sys.argv) > 1 else '/usr/share/fonts/opentype/inter/Inter-Bold.otf'
OUT = 'src/export/glyphs/inter-bold.json'
CHARS = ''.join(chr(c) for c in range(0x20, 0x7f))                      # ASCII
CHARS += ''.join(chr(c) for c in range(0xa1, 0x100) if c != 0xad)        # Latin-1 letters and signs
CHARS += ''.join(chr(c) for c in range(0x100, 0x180))                    # Latin Extended-A (Polish, Czech, Turkish, ...)
CHARS += '–—‘’‚“”„•…€·′″'

class FlatPen(BasePen):
    """Flattens curves into polylines: a few segments per curve, more for long ones."""
    def __init__(self, glyphset, scale):
        super().__init__(glyphset)
        self.scale = scale
        self.contours = []
        self.cur = None
    def _pt(self, p):
        return (p[0] * self.scale, p[1] * self.scale)
    def _moveTo(self, p):
        self.cur = [self._pt(p)]
        self.contours.append(self.cur)
    def _lineTo(self, p):
        self.cur.append(self._pt(p))
    def _curveToOne(self, p1, p2, p3):
        p0 = self._getCurrentPoint()
        a, b, c, d = (self._pt(q) for q in (p0, p1, p2, p3))
        length = math.dist(a, b) + math.dist(b, c) + math.dist(c, d)
        n = max(2, min(10, math.ceil(length / 60)))
        for i in range(1, n + 1):
            t = i / n
            mt = 1 - t
            self.cur.append((mt**3 * a[0] + 3 * mt * mt * t * b[0] + 3 * mt * t * t * c[0] + t**3 * d[0],
                             mt**3 * a[1] + 3 * mt * mt * t * b[1] + 3 * mt * t * t * c[1] + t**3 * d[1]))
    def _qCurveToOne(self, p1, p2):
        p0 = self._getCurrentPoint()
        a, b, c = (self._pt(q) for q in (p0, p1, p2))
        n = max(2, min(8, math.ceil((math.dist(a, b) + math.dist(b, c)) / 60)))
        for i in range(1, n + 1):
            t = i / n
            mt = 1 - t
            self.cur.append((mt * mt * a[0] + 2 * mt * t * b[0] + t * t * c[0], mt * mt * a[1] + 2 * mt * t * b[1] + t * t * c[1]))
    def _closePath(self):
        self.cur = None
    def _endPath(self):
        self.cur = None

def area(r):
    return sum(r[i][0] * r[(i + 1) % len(r)][1] - r[(i + 1) % len(r)][0] * r[i][1] for i in range(len(r))) / 2

def inside(p, r):
    x, y = p
    c = False
    j = len(r) - 1
    for i in range(len(r)):
        xi, yi = r[i]
        xj, yj = r[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            c = not c
        j = i
    return c

def clean(r):
    out = []
    for p in r:
        q = (round(p[0]), round(p[1]))
        if not out or q != out[-1]:
            out.append(q)
    while len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out

font = TTFont(FONT)
upm = font['head'].unitsPerEm
scale = 1000 / upm
cmap = font.getBestCmap()
gs = font.getGlyphSet()
hmtx = font['hmtx']
os2 = font['OS/2']
glyphs = {}
missing = []
for ch in CHARS:
    name = cmap.get(ord(ch))
    if name is None:
        missing.append(ch)
        continue
    # merge overlapping pieces (non-zero fill, as fonts are drawn), then flatten the result
    path = pathops.Path()
    gs[name].draw(path.getPen(glyphSet=gs))
    path.simplify(fix_winding=True)
    pen = FlatPen(gs, scale)
    path.draw(pen)
    rings = [clean(c) for c in pen.contours]
    rings = [r for r in rings if len(r) >= 3 and abs(area(r)) > 1]
    # nesting decides outer rings and holes: inside an even number of others = outer
    depth = [sum(1 for j, o in enumerate(rings) if j != i and inside(r[0], o)) for i, r in enumerate(rings)]
    polys = []
    for i, r in enumerate(rings):
        if depth[i] % 2 == 0:
            polys.append({'i': i, 'outer': r, 'holes': []})
    for i, r in enumerate(rings):
        if depth[i] % 2 == 1:
            # the smallest outer ring that contains it
            owners = [p for p in polys if inside(r[0], p['outer'])]
            if owners:
                min(owners, key=lambda p: abs(area(p['outer'])))['holes'].append(r)
    glyphs[ch] = {
        'a': round(hmtx[name][0] * scale),
        'p': [[[v for pt in p['outer'] for v in pt]] + [[v for pt in h for v in pt] for h in p['holes']] for p in polys],
    }

data = {
    'name': 'Inter Bold (flattened outlines)',
    'license': 'SIL Open Font License 1.1, © The Inter Project Authors; see OFL.txt',
    'unitsPerEm': 1000,
    'capHeight': round(getattr(os2, 'sCapHeight', 0) * scale) or 727,
    'ascender': round(os2.sTypoAscender * scale),
    'descender': round(os2.sTypoDescender * scale),
    'glyphs': glyphs,
}
with open(OUT, 'w') as f:
    json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
print(f'{len(glyphs)} glyphs, capHeight {data["capHeight"]}, missing {"".join(missing)!r}')
