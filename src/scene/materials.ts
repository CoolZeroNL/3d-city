/**
 * Shader patches for MeshStandardMaterial:
 *  - elevation-aware materials (terrain top + plinth walls) get contour lines computed
 *    per fragment from the real elevation, so they stay crisp at any zoom and follow
 *    the vertical exaggeration without rebuilding geometry;
 *  - building materials get a contact-shadow darkening near the ground.
 */

import { Color, MeshStandardMaterial, type IUniform } from 'three';

export interface ElevationUniforms {
  uEx: IUniform<number>;
  uMinElev: IUniform<number>;
  uInterval: IUniform<number>;
  uContourColor: IUniform<Color>;
}

export function makeElevationUniforms(): ElevationUniforms {
  return {
    uEx: { value: 1 },
    uMinElev: { value: 0 },
    uInterval: { value: 10 },
    uContourColor: { value: new Color('#6f6559') },
  };
}

interface ElevationOptions {
  /** strength of contour lines (0..1); the uniform lets the UI toggle them */
  contour: IUniform<number>;
  /** keep major lines only (every 5th), used for the plinth strata */
  majorOnly?: boolean;
}

export function patchElevationMaterial(mat: MeshStandardMaterial, u: ElevationUniforms, opts: ElevationOptions): void {
  const key = `elev-${opts.majorOnly ? 'm' : ''}`;
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u, { uContour: opts.contour });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uEx;\nuniform float uMinElev;\nvarying float vElev;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvElev = transformed.y / uEx + uMinElev;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uInterval;
uniform float uContour;
uniform vec3 uContourColor;
varying float vElev;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
if (uContour > 0.0) {
  float f = vElev / uInterval;
  float fw = max(fwidth(f), 1e-5);
  float d = abs(fract(f + 0.5) - 0.5);
  float k = floor(f + 0.5);
  float major = 1.0 - step(0.5, mod(k, 5.0));
  float halfW = mix(0.55, 1.0, major);
  float line = 1.0 - smoothstep(halfW * fw, (halfW + 1.0) * fw, d);
  ${opts.majorOnly ? 'line *= major;' : ''}
  diffuseColor.rgb = mix(diffuseColor.rgb, uContourColor, line * mix(0.42, 0.78, major) * uContour);
}`,
      );
  };
}

/** Darken building walls close to their base: a cheap stand-in for baked ambient occlusion. */
export function patchBuildingMaterial(mat: MeshStandardMaterial): void {
  mat.customProgramCacheKey = () => 'bldg-ao';
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aHag;\nvarying float vHag;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHag = aHag;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vHag;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(0.66, 1.0, smoothstep(0.0, 7.0, vHag));');
  };
}
