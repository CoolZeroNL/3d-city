/**
 * Terrain top surface + plinth: a regular grid mesh draped with the map-layer
 * texture, four side walls that show the terrain cross-section, and a flat base —
 * the look of a physical architectural model.
 */

import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial, type IUniform, type Texture } from 'three';
import type { HeightGrid } from '../geo/terrain';
import { patchElevationMaterial, type ElevationUniforms } from './materials';

export class TerrainModel {
  readonly group = new Group();
  readonly surface: Mesh<BufferGeometry, MeshStandardMaterial>;
  readonly walls: Mesh<BufferGeometry, MeshStandardMaterial>;
  readonly base: Mesh<BufferGeometry, MeshStandardMaterial>;
  readonly plinth: number;
  private readonly wallTopIndex: Uint32Array;
  private ex = 1;

  constructor(
    readonly grid: HeightGrid,
    texture: Texture,
    private readonly uniforms: ElevationUniforms,
    contour: IUniform<number>,
  ) {
    const { n, sizeM } = grid;
    this.plinth = Math.max(sizeM * 0.025, 20);

    // ---- surface
    const pos = new Float32Array(n * n * 3);
    const uv = new Float32Array(n * n * 2);
    const h = sizeM / 2;
    const step = sizeM / (n - 1);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        pos[k * 3] = -h + i * step;
        pos[k * 3 + 2] = h - j * step; // z = -north
        uv[k * 2] = i / (n - 1);
        uv[k * 2 + 1] = j / (n - 1);
      }
    }
    const idx = new Uint32Array((n - 1) * (n - 1) * 6);
    let t = 0;
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        idx[t++] = a; idx[t++] = b; idx[t++] = c;
        idx[t++] = b; idx[t++] = d; idx[t++] = c;
      }
    }
    const surfGeo = new BufferGeometry();
    surfGeo.setAttribute('position', new BufferAttribute(pos, 3));
    surfGeo.setAttribute('uv', new BufferAttribute(uv, 2));
    surfGeo.setIndex(new BufferAttribute(idx, 1));
    const surfMat = new MeshStandardMaterial({ map: texture, roughness: 0.96, metalness: 0 });
    patchElevationMaterial(surfMat, uniforms, { contour });
    this.surface = new Mesh(surfGeo, surfMat);
    this.surface.castShadow = true;
    this.surface.receiveShadow = true;

    // ---- walls: for each side, a strip of quads from the terrain edge down to the plinth bottom
    const sides: Array<{ cells: number[]; normal: [number, number, number] }> = [
      { cells: range(n).map((i) => i), normal: [0, 0, 1] }, // south edge (j = 0), faces +z
      { cells: range(n).map((i) => (n - 1) * n + i), normal: [0, 0, -1] }, // north edge
      { cells: range(n).map((j) => j * n), normal: [-1, 0, 0] }, // west edge
      { cells: range(n).map((j) => j * n + n - 1), normal: [1, 0, 0] }, // east edge
    ];
    const quads = sides.length * (n - 1);
    const wPos = new Float32Array(quads * 4 * 3);
    const wNorm = new Float32Array(quads * 4 * 3);
    const wIdx = new Uint32Array(quads * 6);
    this.wallTopIndex = new Uint32Array(quads * 4).fill(0xffffffff);
    let v = 0;
    let wi = 0;
    for (const side of sides) {
      for (let s = 0; s < n - 1; s++) {
        const ga = side.cells[s];
        const gb = side.cells[s + 1];
        const ax = pos[ga * 3], az = pos[ga * 3 + 2];
        const bx = pos[gb * 3], bz = pos[gb * 3 + 2];
        // vertices: a-top, b-top, b-bottom, a-bottom
        const verts: Array<[number, number, number, number]> = [
          [ax, 0, az, ga],
          [bx, 0, bz, gb],
          [bx, -this.plinth, bz, -1],
          [ax, -this.plinth, az, -1],
        ];
        const base = v;
        for (const [x, y, z, g] of verts) {
          wPos[v * 3] = x; wPos[v * 3 + 1] = y; wPos[v * 3 + 2] = z;
          wNorm.set(side.normal, v * 3);
          if (g >= 0) this.wallTopIndex[v] = g;
          v++;
        }
        // Winding: (aTop, bTop, aBottom) has face normal (bTop - aTop) × (aBottom - aTop)
        // = (dx, 0, dz) × (0, -p, 0) = (dz·p, 0, -dx·p). Keep it if that points outward.
        const dx = bx - ax;
        const dz = bz - az;
        const outward = dz * this.plinth * side.normal[0] - dx * this.plinth * side.normal[2] > 0;
        if (outward) {
          wIdx.set([base, base + 1, base + 3, base + 1, base + 2, base + 3], wi);
        } else {
          wIdx.set([base, base + 3, base + 1, base + 1, base + 3, base + 2], wi);
        }
        wi += 6;
      }
    }
    const wallGeo = new BufferGeometry();
    wallGeo.setAttribute('position', new BufferAttribute(wPos, 3));
    wallGeo.setAttribute('normal', new BufferAttribute(wNorm, 3));
    wallGeo.setIndex(new BufferAttribute(wIdx, 1));
    const wallMat = new MeshStandardMaterial({ color: '#c2b49e', roughness: 1, metalness: 0 });
    patchElevationMaterial(wallMat, uniforms, { contour: { value: 0.55 } });
    this.walls = new Mesh(wallGeo, wallMat);
    this.walls.castShadow = true;
    this.walls.receiveShadow = true;

    // ---- base plate (bottom face, facing down)
    const baseGeo = new BufferGeometry();
    const y = -this.plinth;
    baseGeo.setAttribute('position', new BufferAttribute(new Float32Array([-h, y, -h, h, y, -h, h, y, h, -h, y, h]), 3));
    baseGeo.setAttribute('normal', new BufferAttribute(new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0]), 3));
    baseGeo.setIndex([0, 1, 2, 0, 2, 3]);
    this.base = new Mesh(baseGeo, new MeshStandardMaterial({ color: '#8c7f6c', roughness: 1 }));

    this.group.add(this.surface, this.walls, this.base);
    this.setExaggeration(1);
  }

  /** Scene y of an elevation (metres above sea level). */
  y(elev: number): number {
    return (elev - this.grid.min) * this.ex;
  }

  get exaggeration(): number {
    return this.ex;
  }

  /** Re-evaluate heights; also call after `grid.elev` / `grid.min` changed (sea flattening). */
  setExaggeration(ex: number): void {
    this.ex = ex;
    this.uniforms.uEx.value = ex;
    this.uniforms.uMinElev.value = this.grid.min;
    const { elev, min } = this.grid;
    const pos = this.surface.geometry.getAttribute('position') as BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let k = 0; k < elev.length; k++) arr[k * 3 + 1] = (elev[k] - min) * ex;
    pos.needsUpdate = true;
    this.surface.geometry.computeVertexNormals();
    this.surface.geometry.computeBoundingSphere();
    this.surface.geometry.computeBoundingBox();

    const wPos = this.walls.geometry.getAttribute('position') as BufferAttribute;
    const wArr = wPos.array as Float32Array;
    for (let v = 0; v < this.wallTopIndex.length; v++) {
      const g = this.wallTopIndex[v];
      if (g !== 0xffffffff) wArr[v * 3 + 1] = (elev[g] - min) * ex;
    }
    wPos.needsUpdate = true;
    this.walls.geometry.computeBoundingSphere();
  }

  dispose(): void {
    for (const m of [this.surface, this.walls, this.base]) {
      m.geometry.dispose();
      m.material.dispose();
    }
  }
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
