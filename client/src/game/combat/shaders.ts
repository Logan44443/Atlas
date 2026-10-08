import { Fn, normalView, positionViewDirection, dot, pow, float, vec4, color, abs } from 'three/tsl';
import type * as THREE from 'three/webgpu';

/** Rim-lit translucent shell (shields, bubbles). */
export function fresnel(c: THREE.Color, base: number) {
  return Fn(() => {
    const f = pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 2.5);
    const a = f.add(base);
    return vec4(color(c).mul(a.mul(1.6)), a);
  })();
}
