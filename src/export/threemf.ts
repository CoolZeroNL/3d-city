/**
 * The colour print file: the same closed shells as the STL, as a 3MF (a ZIP of XML) whose
 * triangles carry the filament to print them in.
 *
 * It is one object, so slicers union its shells exactly as they do the STL's. Painted triangles
 * carry the slicers' own multi-material painting: `paint_color` for Bambu Studio and OrcaSlicer,
 * `slic3rpe:mmu_segmentation` for PrusaSlicer, the same code in both (see paintCode). Triangles
 * left unpainted, the ground, take the object's filament, 1.
 */

import { paintCode } from './paint';
import type { Triangles } from './stl';
import { deflateRaw, makeZip } from './zip';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A coordinate in mm, to a hundred-thousandth: far finer than any printer, and short. */
const num = (v: number) => String(Math.round(v * 1e5) / 1e5);

/**
 * The 3MF model XML. Points shared by triangles are written once (by their exact STL value), so
 * each shell stays closed by its indices; a triangle whose corners fall on one point is left out.
 */
export function modelXml(t: Triangles, title: string, description: string): string {
  const index = new Map<string, number>();
  const vertices: string[] = [];
  const triangles: string[] = [];
  const codes = new Map<number, string>();
  const d = t.data;
  for (let k = 0; k < t.count; k++) {
    const v = [0, 1, 2].map((c) => {
      const p = k * 9 + c * 3;
      const key = `${d[p]},${d[p + 1]},${d[p + 2]}`;
      let i = index.get(key);
      if (i === undefined) {
        i = vertices.length;
        index.set(key, i);
        vertices.push(`<vertex x="${num(d[p])}" y="${num(d[p + 1])}" z="${num(d[p + 2])}"/>`);
      }
      return i;
    });
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
    const f = t.paint[k];
    let paint = '';
    if (f) {
      let code = codes.get(f);
      if (!code) codes.set(f, (code = paintCode(f)));
      paint = ` paint_color="${code}" slic3rpe:mmu_segmentation="${code}"`;
    }
    triangles.push(`<triangle v1="${v[0]}" v2="${v[1]}" v3="${v[2]}"${paint}/>`);
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">',
    `<metadata name="Title">${esc(title)}</metadata>`,
    `<metadata name="Description">${esc(description)}</metadata>`,
    '<metadata name="Application">Your Place</metadata>',
    '<metadata name="Copyright">Map data © OpenStreetMap contributors (ODbL)</metadata>',
    '<resources>',
    `<object id="1" type="model" name="${esc(title)}">`,
    '<mesh>',
    '<vertices>',
    ...vertices,
    '</vertices>',
    '<triangles>',
    ...triangles,
    '</triangles>',
    '</mesh>',
    '</object>',
    '</resources>',
    '<build>',
    '<item objectid="1"/>',
    '</build>',
    '</model>',
    '',
  ].join('\n');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

/** The 3MF file's bytes: the model compressed where the browser can, stored otherwise. */
export async function to3mf(t: Triangles, title: string, description: string): Promise<Uint8Array<ArrayBuffer>> {
  const enc = new TextEncoder();
  const model = enc.encode(modelXml(t, title, description));
  return makeZip([
    { name: '[Content_Types].xml', data: enc.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: enc.encode(RELS) },
    { name: '3D/3dmodel.model', data: model, deflated: await deflateRaw(model) },
  ]);
}
