/**
 * Colours for the colour print file (3MF): which filament each triangle gets. Slicers with
 * multi-material painting (Bambu Studio, OrcaSlicer, PrusaSlicer) print each painted surface in
 * its filament; what isn't painted takes the object's own, filament 1.
 */

/**
 * The filament for each part of the print: 1 for the ground (left unpainted), then buildings, roads
 * and water. Four in all, as many as an AMS or AMS Lite holds.
 */
export const PAINT = { ground: 0, buildings: 2, roads: 3, water: 4 } as const;

/** Whether a triangle of the ground on these grid points is water: when two of its three are. */
export const wet = (water: ArrayLike<number> | undefined, a: number, b: number, c: number): boolean =>
  !!water && (water[a] >= 0.5 ? 1 : 0) + (water[b] >= 0.5 ? 1 : 0) + (water[c] >= 0.5 ? 1 : 0) >= 2;

/**
 * A painted triangle in the slicers' own notation (PrusaSlicer's TriangleSelector, which Bambu
 * Studio and OrcaSlicer share): an unsplit triangle is 2 bits "no split", then its state, 2 bits
 * for states 1–2, or 0b11 and 4 more bits for state − 3. Read as hex digits, last nibble first.
 */
export function paintCode(filament: number): string {
  if (filament < 1 || filament > 17) throw new Error(`no paint code for filament ${filament}`);
  return filament < 3 ? String(filament * 4) : `${(filament - 3).toString(16).toUpperCase()}C`;
}
