/**
 * Everything that makes up one place's model: terrain + plinth, buildings,
 * the draped map layers and the address pin. Owns the update paths for the
 * controls in the bottom sheet.
 */

import { BufferGeometry, Color, CylinderGeometry, Group, MathUtils, Mesh, MeshStandardMaterial, SphereGeometry, type IUniform, type Object3D, type Raycaster, type Vector3 } from 'three';
import type { BuildingFeature, FeatureSet } from '../geo/osm';
import { centroid, pointInRing, type Polygon, type Pt } from '../geo/polygon';
import { isEstimated, resolveHeights } from '../geo/heights';
import { computeSeaMask, isSea, seaMaskFromPolygons, seaShare, type SeaMask } from '../geo/sea';
import { contourInterval, sampleGrid, type HeightGrid } from '../geo/terrain';
import type { BuildingStyle, Layers } from '../state';
import {
  applyBuildingStyle,
  buildBuildings,
  buildingOfVertex,
  buildingsAt,
  paintBuildings,
  setBuildingsExaggeration,
  type BuildingSpec,
  type BuildingsBuild,
} from './buildingsMesh';
import { makeElevationUniforms, patchBuildingMaterial, type ElevationUniforms } from './materials';
import { Overlay } from './overlay';
import { TerrainModel } from './terrainMesh';

export interface ModelStats {
  minElev: number;
  maxElev: number;
  buildings: number;
  tallest: number;
  estimatedShare: number;
  contourInterval: number;
  /** share of the square that is sea (from coastlines) */
  seaShare: number;
}

/** Where a tap landed, in metres from the centre; `building` when it hit one. */
export interface PinHit {
  e: number;
  n: number;
  building: boolean;
}

/** Buildings up to this size (m) get the pin in their middle; bigger ones where they were tapped. */
const PIN_MIDDLE_MAX_M = 40;

export class CityModel {
  readonly group = new Group();
  readonly uniforms: ElevationUniforms = makeElevationUniforms();
  readonly contour: IUniform<number> = { value: 0 };
  readonly terrain: TerrainModel;
  readonly overlay: Overlay;
  private buildings: { build: BuildingsBuild; mesh: Mesh<BufferGeometry, MeshStandardMaterial> } | null = null;
  private specs: BuildingSpec[] = [];
  private features: FeatureSet | null = null;
  private readonly pin: Group;
  private readonly accent: Color;
  /** pin position, metres from the centre (E, N) */
  private pinAt: Pt = [0, 0];
  /** the buildings the pin stands on */
  private pinned: number[] = [];
  /** paint the pinned building: only for a pin the user placed, not the search result */
  private markPinned = false;
  private style: BuildingStyle = 'white';
  private seaFraction = 0;
  private layers: Layers = { roads: true, water: true, green: true };

  constructor(
    readonly grid: HeightGrid,
    overlayPx: number,
    accent: string,
  ) {
    this.overlay = new Overlay(overlayPx);
    this.overlay.draw(null, grid.sizeM, this.layers);
    this.terrain = new TerrainModel(grid, this.overlay.texture, this.uniforms, this.contour);
    this.uniforms.uInterval.value = contourInterval(grid.max - grid.min);
    this.accent = new Color(accent);
    this.pin = makePin(grid.sizeM, accent);
    this.group.add(this.terrain.group, this.pin);
    this.placePin();
  }

  get sizeM(): number {
    return this.grid.sizeM;
  }

  get exaggeration(): number {
    return this.terrain.exaggeration;
  }

  /** Top of the model at the centre (scene y), used to aim the camera. */
  centerY(): number {
    return this.terrain.y(sampleGrid(this.grid, 0, 0));
  }

  /** Buildings from raw OSM tags (Overpass fallback): apply the spec's height rule first. */
  setBuildings(features: BuildingFeature[]): void {
    const centroids = features.map((f) => centroid(f.poly.outer));
    const heights = resolveHeights(features.map((f, i) => ({ tags: f.tags, cx: centroids[i][0], cy: centroids[i][1] })));
    this.setBuildingSpecs(
      features.map((f, i) => ({
        poly: f.poly,
        height: heights[i].height,
        minHeight: heights[i].minHeight,
        estimated: isEstimated(heights[i].source),
      })),
    );
  }

  /** Buildings with heights already decided (vector tiles carry them). */
  setBuildingSpecs(specs: BuildingSpec[]): void {
    this.clearBuildings();
    const lowest = (poly: Polygon) => {
      let m = Infinity;
      for (const [e, n] of poly.outer) m = Math.min(m, sampleGrid(this.grid, e, n));
      return m;
    };
    const build = buildBuildings(specs, lowest, this.grid.min, this.exaggeration);
    this.specs = specs;
    const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
    patchBuildingMaterial(mat);
    const mesh = new Mesh(build.geometry, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.buildings = { build, mesh };
    this.group.add(mesh);
    this.refreshPin();
  }

  /** Move the pin (metres from the centre). `mark` paints the building it lands on. */
  setPin(e: number, n: number, mark = true): void {
    const h = this.grid.sizeM / 2;
    this.pinAt = [MathUtils.clamp(e, -h, h), MathUtils.clamp(n, -h, h)];
    this.markPinned = mark;
    this.refreshPin();
  }

  pinInfo(): { e: number; n: number; buildings: number; marked: boolean } {
    return { e: this.pinAt[0], n: this.pinAt[1], buildings: this.pinned.length, marked: this.markPinned && this.pinned.length > 0 };
  }

  /** What a ray from the camera hits: a building (pin goes inside it) or open ground. */
  pick(ray: Raycaster): PinHit | null {
    const targets: Object3D[] = [this.terrain.surface];
    if (this.buildings) targets.push(this.buildings.mesh);
    const hit = ray.intersectObjects(targets, false)[0];
    if (!hit) return null;
    const tapped: Pt = [hit.point.x, -hit.point.z];
    const h = this.grid.sizeM / 2;
    if (Math.abs(tapped[0]) > h || Math.abs(tapped[1]) > h) return null;
    if (this.buildings && hit.object === this.buildings.mesh && hit.face) {
      const [e, n] = this.spotIn(buildingOfVertex(this.buildings.build, hit.face.a), tapped, hit.face.normal);
      return { e, n, building: true };
    }
    return { e: tapped[0], n: tapped[1], building: false };
  }

  /** A point inside building i for the pin: the middle of a house, else where the tap landed. */
  private spotIn(i: number, tapped: Pt, normal: Vector3): Pt {
    const { outer, holes } = this.specs[i].poly;
    const inside = (p: Pt) => pointInRing(p, outer) && !holes.some((r) => pointInRing(p, r));
    const bb = this.buildings!.build.bounds;
    const k = i * 4;
    if (bb[k + 2] - bb[k] <= PIN_MIDDLE_MAX_M && bb[k + 3] - bb[k + 1] <= PIN_MIDDLE_MAX_M) {
      const c = centroid(outer);
      if (inside(c)) return c;
    }
    // a wall hit lies on the outline: step inside, against the wall's outward normal (scene z = -N)
    const step: Pt = [tapped[0] - normal.x * 0.75, tapped[1] + normal.z * 0.75];
    return inside(step) ? step : tapped;
  }

  private refreshPin(): void {
    this.pinned = this.buildings ? buildingsAt(this.buildings.build, this.specs, this.pinAt) : [];
    this.paint();
    this.placePin();
  }

  private paint(): void {
    if (!this.buildings) return;
    applyBuildingStyle(this.buildings.build, this.style);
    if (this.markPinned && this.pinned.length) paintBuildings(this.buildings.build, this.pinned, this.accent);
  }

  setFeatures(features: FeatureSet): void {
    this.features = features;
    // vector tiles carry the sea as polygons; raw OSM only as coastlines
    const sea = features.sea?.length
      ? this.checkSea(seaMaskFromPolygons(features.sea, this.grid.sizeM, 1024))
      : this.seaFromCoastlines(features.coastlines);
    this.overlay.setSea(sea);
    if (sea) {
      this.seaFraction = seaShare(sea);
      this.flattenSea(sea);
    }
    this.overlay.draw(features, this.grid.sizeM, this.layers);
  }

  setExaggeration(ex: number): void {
    this.terrain.setExaggeration(ex);
    if (this.buildings) setBuildingsExaggeration(this.buildings.build, ex, this.grid.min);
    this.placePin();
  }

  /**
   * Sea from coastlines, with a sanity check against the terrain: if the "sea"
   * side is clearly above sea level the coastline data is unusable here (e.g. a
   * mis-oriented way), and we fall back to no sea layer rather than flooding land.
   */
  private seaFromCoastlines(coastlines: Pt[][]): SeaMask | null {
    if (!coastlines.length) return null;
    return this.checkSea(computeSeaMask(coastlines, this.grid.sizeM, 1024));
  }

  private checkSea(mask: SeaMask | null): SeaMask | null {
    if (!mask) return null;
    const { n, sizeM, elev } = this.grid;
    const step = sizeM / (n - 1);
    const h = sizeM / 2;
    const under: number[] = [];
    for (let j = 0; j < n; j += 2)
      for (let i = 0; i < n; i += 2) if (isSea(mask, -h + i * step, -h + j * step)) under.push(elev[j * n + i]);
    if (under.length === 0) return null;
    under.sort((a, b) => a - b);
    const median = under[under.length >> 1];
    return median <= 3 ? mask : null;
  }

  /** Put sea areas at sea level, then re-evaluate everything that depends on the minimum elevation. */
  private flattenSea(mask: SeaMask): void {
    const g = this.grid;
    const step = g.sizeM / (g.n - 1);
    const h = g.sizeM / 2;
    let min = Infinity;
    let max = -Infinity;
    for (let j = 0; j < g.n; j++) {
      for (let i = 0; i < g.n; i++) {
        const k = j * g.n + i;
        if (isSea(mask, -h + i * step, -h + j * step)) g.elev[k] = 0;
        min = Math.min(min, g.elev[k]);
        max = Math.max(max, g.elev[k]);
      }
    }
    g.min = min;
    g.max = max;
    this.uniforms.uInterval.value = contourInterval(max - min);
    this.setExaggeration(this.exaggeration);
  }

  setStyle(style: BuildingStyle): void {
    this.style = style;
    this.paint();
  }

  setLayers(layers: Layers): void {
    this.layers = { ...layers };
    this.overlay.draw(this.features, this.grid.sizeM, this.layers);
  }

  setContours(on: boolean): void {
    this.contour.value = on ? 1 : 0;
  }

  stats(): ModelStats {
    const b = this.buildings?.build;
    return {
      minElev: this.grid.min,
      maxElev: this.grid.max,
      buildings: b?.count ?? 0,
      tallest: b?.maxHeight ?? 0,
      estimatedShare: b && b.count ? b.estimatedCount / b.count : 0,
      contourInterval: this.uniforms.uInterval.value,
      seaShare: this.seaFraction,
    };
  }

  get hasBuildings(): boolean {
    return !!this.buildings;
  }

  private placePin(): void {
    const [e, n] = this.pinAt;
    const ground = this.terrain.y(sampleGrid(this.grid, e, n));
    // the head should clear the roof it stands on
    let top = ground;
    const b = this.buildings?.build;
    if (b) for (const i of this.pinned) top = Math.max(top, (b.buildingGround[i] - this.grid.min) * this.exaggeration + this.specs[i].height);
    const stem = Math.max(this.grid.sizeM * 0.04, top - ground + this.grid.sizeM * 0.02);
    this.pin.position.set(e, ground, -n);
    const [stemMesh, head] = this.pin.children as Mesh[];
    stemMesh.scale.set(1, stem, 1);
    stemMesh.position.y = stem / 2;
    head.position.y = stem;
  }

  private clearBuildings(): void {
    if (!this.buildings) return;
    this.group.remove(this.buildings.mesh);
    this.buildings.mesh.geometry.dispose();
    this.buildings.mesh.material.dispose();
    this.buildings = null;
    this.specs = [];
    this.pinned = [];
  }

  dispose(): void {
    this.clearBuildings();
    this.terrain.dispose();
    this.overlay.dispose();
    for (const c of this.pin.children as Mesh[]) {
      c.geometry.dispose();
      (c.material as MeshStandardMaterial).dispose();
    }
  }
}

function makePin(sizeM: number, accent: string): Group {
  const g = new Group();
  const color = new Color(accent);
  const mat = new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25, roughness: 0.5 });
  const r = sizeM * 0.0011;
  const stem = new Mesh(new CylinderGeometry(r, r, 1, 10), mat);
  const head = new Mesh(new SphereGeometry(sizeM * 0.0065, 24, 16), mat.clone());
  stem.castShadow = true;
  head.castShadow = true;
  g.add(stem, head);
  g.name = 'pin';
  return g;
}
