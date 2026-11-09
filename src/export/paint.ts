/**
 * Colours for the colour print file (3MF): which filament each triangle gets. Slicers with
 * multi-material painting (Bambu Studio, OrcaSlicer, PrusaSlicer) print each painted surface in
 * its filament; what isn't painted takes the object's own, filament 1.
 *
 * Triangles record the part of the print they belong to; the filament for each part is chosen in
 * the share menu and only applied when the file is written.
 */

/** The parts of the print the colour file tells apart. */
export const PAINT = { ground: 0, buildings: 1, roads: 2, water: 3, green: 4 } as const;

/** Filament per part (indexed by PAINT): the ground is always 1; 1 for another part means "like the ground". */
export type Filaments = readonly number[];

/** Ground 1, buildings and the title 2, roads 3, water 4, parks and woods 5. */
export const DEFAULT_FILAMENTS: Filaments = [1, 2, 3, 4, 5];

/** How many filaments a part can be given. */
export const MAX_FILAMENTS = 5;

/** Whether two of a triangle's three grid points are in the mask. */
const most = (mask: ArrayLike<number> | undefined, a: number, b: number, c: number): boolean =>
  !!mask && (mask[a] >= 0.5 ? 1 : 0) + (mask[b] >= 0.5 ? 1 : 0) + (mask[c] >= 0.5 ? 1 : 0) >= 2;

/** Whether a triangle of the ground on these grid points is water: when two of its three are. */
export const wet = (water: ArrayLike<number> | undefined, a: number, b: number, c: number): boolean => most(water, a, b, c);

/** The part a triangle of the ground on these grid points belongs to: water, else parks and woods, else ground. */
export function groundPart(water: ArrayLike<number> | undefined, green: ArrayLike<number> | undefined, a: number, b: number, c: number): number {
  return most(water, a, b, c) ? PAINT.water : most(green, a, b, c) ? PAINT.green : PAINT.ground;
}

/**
 * A painted triangle in the slicers' own notation (PrusaSlicer's TriangleSelector, which Bambu
 * Studio and OrcaSlicer share): an unsplit triangle is 2 bits "no split", then its state, 2 bits
 * for states 1–2, or 0b11 and 4 more bits for state − 3. Read as hex digits, last nibble first.
 */
export function paintCode(filament: number): string {
  if (filament < 1 || filament > 17) throw new Error(`no paint code for filament ${filament}`);
  return filament < 3 ? String(filament * 4) : `${(filament - 3).toString(16).toUpperCase()}C`;
}
