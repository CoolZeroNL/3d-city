/**
 * Everything that makes up one place's model: terrain + plinth, buildings,
 * the draped map layers and the address pin. Owns the update paths for the
 * controls in the bottom sheet.
 */

import { BufferGeometry, Color, CylinderGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry, type IUniform } from 'three';
import type { BuildingFeature, FeatureSet } from '../geo/osm';
import { pointInRing, type Polygon } from '../geo/polygon';
import { isEstimated, resolveHeights } from '../geo/heights';
import { computeSeaMask, isSea, seaShare, type SeaMask } from '../geo/sea';
import { contourInterval, sampleGrid, type HeightGrid } from '../geo/terrain';
import { centroid, type Pt } from '../geo/polygon';
import type { BuildingStyle, Layers } from '../state';
import { applyBuildingStyle, buildBuildings, setBuildingsExaggeration, type BuildingsBuild } from './buildingsMesh';
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

export class CityModel {
  readonly group = new Group();
  readonly uniforms: ElevationUniforms = makeElevationUniforms();
  readonly contour: IUniform<number> = { value: 0 };
  readonly terrain: TerrainModel;
  readonly overlay: Overlay;
  private buildings: { build: BuildingsBuild; mesh: Mesh<BufferGeometry, MeshStandardMaterial> } | null = null;
  private features: FeatureSet | null = null;
  private readonly pin: Group;
  private pinTop = 0;
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

  setBuildings(features: BuildingFeature[]): void {
    this.clearBuildings();
    const centroids = features.map((f) => centroid(f.poly.outer));
    const heights = resolveHeights(features.map((f, i) => ({ tags: f.tags, cx: centroids[i][0], cy: centroids[i][1] })));
    const specs = features.map((f, i) => ({
      poly: f.poly,
      height: heights[i].height,
      minHeight: heights[i].minHeight,
      estimated: isEstimated(heights[i].source),
    }));
    const lowest = (poly: Polygon) => {
      let m = Infinity;
      for (const [e, n] of poly.outer) m = Math.min(m, sampleGrid(this.grid, e, n));
      return m;
    };
    const build = buildBuildings(specs, lowest, this.grid.min, this.exaggeration);
    applyBuildingStyle(build, this.style);
    const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
    patchBuildingMaterial(mat);
    const mesh = new Mesh(build.geometry, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.buildings = { build, mesh };
    this.group.add(mesh);
    // the pin should clear the building it stands on
    const hit = specs.filter((s) => pointInRing([0, 0], s.poly.outer)).reduce((m, s) => Math.max(m, s.height), 0);
    this.pinTop = hit;
    this.placePin();
  }

  setFeatures(features: FeatureSet): void {
    this.features = features;
    const sea = this.seaFromCoastlines(features.coastlines);
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
    const mask = computeSeaMask(coastlines, this.grid.sizeM, 1024);
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
    if (this.buildings) applyBuildingStyle(this.buildings.build, style);
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
    const ground = this.terrain.y(sampleGrid(this.grid, 0, 0));
    const stem = Math.max(this.grid.sizeM * 0.04, this.pinTop + this.grid.sizeM * 0.02);
    this.pin.position.set(0, ground, 0);
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
