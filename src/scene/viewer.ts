/**
 * Renderer, camera, lights and interaction. Renders on demand: a frame is drawn
 * only when the camera moves or something in the scene changed.
 */

import {
  CanvasTexture,
  DirectionalLight,
  Group,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  TOUCH,
  MOUSE,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CameraState } from '../state';
import type { CityModel } from './cityModel';

export const MAX_TILT_DEG = 70;
export const DEFAULT_TILT_DEG = 20;

export function isWebGL2Available(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function isSmallDevice(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 900;
}

export class Viewer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(32, 1, 1, 100000);
  readonly controls: OrbitControls;
  private readonly sun = new DirectionalLight('#fff8ee', 2.4);
  private readonly hemi = new HemisphereLight('#ffffff', '#cfc6b6', 1.35);
  private readonly stage = new Group();
  private contactShadow: Mesh<PlaneGeometry, MeshBasicMaterial> | null = null;
  private model: CityModel | null = null;
  private dirty = true;
  private animation: { from: CameraState; to: CameraState; start: number; ms: number } | null = null;
  private readonly cameraListeners = new Set<() => void>();
  private reducedMotion = prefersReducedMotion();
  /** CSS px covered by UI on the left (desktop settings panel); the model is centred in the rest */
  private insetLeft = 0;
  readonly small = isSmallDevice();

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;

    this.sun.castShadow = true;
    const map = this.small ? 2048 : 4096;
    this.sun.shadow.mapSize.set(map, map);
    this.sun.shadow.radius = 2.5;
    this.scene.add(this.hemi, this.sun, this.sun.target, this.stage);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = !this.reducedMotion;
    this.controls.dampingFactor = 0.09;
    this.controls.rotateSpeed = 0.6;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = false;
    this.controls.minPolarAngle = 0;
    this.controls.maxPolarAngle = MathUtils.degToRad(MAX_TILT_DEG);
    this.controls.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_ROTATE };
    this.controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
    this.controls.addEventListener('change', () => {
      this.clampTarget();
      this.dirty = true;
      this.cameraListeners.forEach((fn) => fn());
    });
    this.controls.addEventListener('start', () => {
      this.animation = null;
    });

    canvas.addEventListener('keydown', (e) => this.onKey(e));
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas.parentElement ?? canvas);
    this.resize();
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', (e) => {
      this.reducedMotion = e.matches;
      this.controls.enableDamping = !e.matches;
    });
    this.renderer.setAnimationLoop((t) => this.tick(t));
  }

  onCameraChange(fn: () => void): () => void {
    this.cameraListeners.add(fn);
    return () => this.cameraListeners.delete(fn);
  }

  requestRender(): void {
    this.dirty = true;
  }

  setModel(model: CityModel | null): void {
    if (this.model) this.stage.remove(this.model.group);
    if (this.contactShadow) {
      this.stage.remove(this.contactShadow);
      this.contactShadow.geometry.dispose();
      this.contactShadow.material.map?.dispose();
      this.contactShadow.material.dispose();
      this.contactShadow = null;
    }
    this.model = model;
    if (model) {
      this.stage.add(model.group);
      this.contactShadow = makeContactShadow(model.sizeM, model.terrain.plinth);
      this.stage.add(this.contactShadow);
      this.updateSun();
      const s = model.sizeM;
      this.camera.near = s * 0.002;
      this.camera.far = s * 20;
      this.camera.updateProjectionMatrix();
      this.controls.minDistance = s * 0.06;
      this.controls.maxDistance = s * 4;
    }
    this.dirty = true;
  }

  /** Re-aim lights after the model's height changed (exaggeration). */
  updateSun(): void {
    if (!this.model) return;
    const s = this.model.sizeM;
    // Light from the north-west, the cartographic convention that makes relief read the right way up.
    const dir = new Vector3(-0.55, 0.78, -0.55).normalize();
    this.sun.position.copy(dir.multiplyScalar(s * 2));
    this.sun.target.position.set(0, 0, 0);
    const cam = this.sun.shadow.camera;
    const r = s * 0.78;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = s * 0.5;
    cam.far = s * 4;
    cam.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = (s / this.sun.shadow.mapSize.x) * 1.2;
    this.dirty = true;
  }

  setInsetLeft(px: number): void {
    if (Math.abs(px - this.insetLeft) < 1) return;
    this.insetLeft = px;
    this.resize();
  }

  /** Aspect ratio of the part of the canvas not covered by UI. */
  private visibleAspect(): number {
    const size = this.renderer.getSize(new Vector2());
    return Math.max(0.2, (size.x - this.insetLeft) / size.y);
  }

  /** Default framing: near top-down (~20° off vertical), north up, whole square in view. */
  defaultCamera(): CameraState {
    const s = this.model?.sizeM ?? 2000;
    const vfov = MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.visibleAspect());
    const half = s * 0.62;
    const distance = Math.max(half / Math.tan(vfov / 2), half / Math.tan(hfov / 2));
    return { azimuth: 0, tilt: DEFAULT_TILT_DEG, distance, targetE: 0, targetN: 0 };
  }

  getCameraState(): CameraState {
    const t = this.controls.target;
    return {
      azimuth: MathUtils.radToDeg(this.controls.getAzimuthalAngle()),
      tilt: MathUtils.radToDeg(this.controls.getPolarAngle()),
      distance: this.controls.getDistance(),
      targetE: t.x,
      targetN: -t.z,
    };
  }

  setCameraState(c: CameraState, animate = false): void {
    if (animate && !this.reducedMotion) {
      const from = this.getCameraState();
      // take the short way round
      let az = c.azimuth;
      while (az - from.azimuth > 180) az -= 360;
      while (az - from.azimuth < -180) az += 360;
      this.animation = { from, to: { ...c, azimuth: az }, start: performance.now(), ms: 650 };
      this.dirty = true;
      return;
    }
    this.applyCamera(c);
  }

  private applyCamera(c: CameraState): void {
    const tilt = MathUtils.degToRad(MathUtils.clamp(c.tilt, 0.01, MAX_TILT_DEG));
    const az = MathUtils.degToRad(c.azimuth);
    const y = this.model ? this.model.centerY() : 0;
    const target = new Vector3(c.targetE, y, -c.targetN);
    const d = MathUtils.clamp(c.distance, this.controls.minDistance, this.controls.maxDistance);
    this.controls.target.copy(target);
    this.camera.position.set(
      target.x + d * Math.sin(tilt) * Math.sin(az),
      target.y + d * Math.cos(tilt),
      target.z + d * Math.sin(tilt) * Math.cos(az),
    );
    this.camera.lookAt(target);
    this.controls.update();
    this.dirty = true;
    this.cameraListeners.forEach((fn) => fn());
  }

  /** Keep the camera aimed at the model's surface after the terrain height changed. */
  retarget(): void {
    const c = this.getCameraState();
    this.applyCamera(c);
  }

  resetNorth(): void {
    this.setCameraState({ ...this.getCameraState(), azimuth: 0 }, true);
  }

  resetView(): void {
    this.setCameraState(this.defaultCamera(), true);
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.model || e.altKey || e.ctrlKey || e.metaKey) return;
    // repeated presses accumulate: step from where a running animation is heading
    const c = this.animation ? { ...this.animation.to } : this.getCameraState();
    let next: CameraState | null = null;
    switch (e.key) {
      case 'ArrowLeft':
        next = { ...c, azimuth: c.azimuth - 10 };
        break;
      case 'ArrowRight':
        next = { ...c, azimuth: c.azimuth + 10 };
        break;
      case 'ArrowUp':
        next = { ...c, tilt: Math.max(0, c.tilt - 5) };
        break;
      case 'ArrowDown':
        next = { ...c, tilt: Math.min(MAX_TILT_DEG, c.tilt + 5) };
        break;
      case '+':
      case '=':
        next = { ...c, distance: c.distance * 0.85 };
        break;
      case '-':
      case '_':
        next = { ...c, distance: c.distance / 0.85 };
        break;
      case 'n':
      case 'N':
        next = { ...c, azimuth: 0 };
        break;
      case 'Home':
      case '0':
        next = this.defaultCamera();
        break;
      default:
        return;
    }
    e.preventDefault();
    this.setCameraState(next, true);
  }

  private clampTarget(): void {
    if (!this.model) return;
    const h = this.model.sizeM / 2;
    const t = this.controls.target;
    const cx = MathUtils.clamp(t.x, -h, h);
    const cz = MathUtils.clamp(t.z, -h, h);
    if (cx !== t.x || cz !== t.z) {
      const dx = cx - t.x;
      const dz = cz - t.z;
      t.x = cx;
      t.z = cz;
      this.camera.position.x += dx;
      this.camera.position.z += dz;
    }
  }

  private resize(): void {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // shift the projection centre into the uncovered area
    if (this.insetLeft > 0 && this.insetLeft < w * 0.6) this.camera.setViewOffset(w, h, -this.insetLeft / 2, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private tick(now: number): void {
    if (this.animation) {
      const { from, to, start, ms } = this.animation;
      const k = Math.min(1, (now - start) / ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
      const lerp = (a: number, b: number) => a + (b - a) * e;
      this.applyCamera({
        azimuth: lerp(from.azimuth, to.azimuth),
        tilt: lerp(from.tilt, to.tilt),
        distance: from.distance * (to.distance / from.distance) ** e,
        targetE: lerp(from.targetE, to.targetE),
        targetN: lerp(from.targetN, to.targetN),
      });
      if (k >= 1) this.animation = null;
    }
    const moved = this.controls.update();
    if (moved || this.dirty) {
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
    }
  }

  /** Render the current view at a fixed size, independent of the screen. */
  renderStill(width: number, height: number): HTMLCanvasElement {
    const gl = this.renderer.getContext();
    const maxSize = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, 4096);
    const scale = Math.min(1, maxSize / Math.max(width, height));
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    const prevRatio = this.renderer.getPixelRatio();
    const prevFov = this.camera.fov;
    // keep at least the horizontal field of view the user sees on screen
    const screenAspect = this.visibleAspect();
    const hTan = Math.tan(MathUtils.degToRad(prevFov) / 2) * screenAspect;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.camera.clearViewOffset();
    this.camera.aspect = w / h;
    if (w / h < screenAspect) this.camera.fov = MathUtils.radToDeg(2 * Math.atan(hTan / (w / h)));
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d')!.drawImage(this.renderer.domElement, 0, 0);
    this.renderer.setPixelRatio(prevRatio);
    this.camera.fov = prevFov;
    this.resize();
    return out;
  }
}

/** A soft, blurred rectangle under the base: the model "sits" on the page. */
function makeContactShadow(sizeM: number, plinth: number): Mesh<PlaneGeometry, MeshBasicMaterial> {
  const px = 256;
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  const ctx = c.getContext('2d')!;
  const inset = px * 0.2;
  ctx.shadowColor = 'rgba(40, 32, 20, 0.55)';
  ctx.shadowBlur = px * 0.09;
  ctx.shadowOffsetX = px * 2;
  ctx.fillRect(inset - px * 2, inset, px - inset * 2, px - inset * 2);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  const size = sizeM / (1 - 0.4);
  const mesh = new Mesh(new PlaneGeometry(size, size), new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(sizeM * 0.03, -plinth - sizeM * 0.004, sizeM * 0.03);
  mesh.renderOrder = -1;
  return mesh;
}
