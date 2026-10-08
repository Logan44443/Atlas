import * as THREE from 'three/webgpu';
import {
  Fn, uniform, positionLocal, normalize, max, pow, mix, dot, smoothstep, vec3, vec4, float, floor, fract, sin,
  mrt, step, abs, time,
} from 'three/tsl';
import { registerBloomSource } from '../engine/renderer';

/**
 * Painterly gradient sky dome with sun and moon discs and a star field.
 * All colours/directions are uniforms driven by DayNight.
 */
export class Sky {
  readonly mesh: THREE.Mesh;
  readonly top = uniform(new THREE.Color('#3d86e8'));
  readonly horizon = uniform(new THREE.Color('#bfe0ff'));
  readonly sunDir = uniform(new THREE.Vector3(0, 1, 0));
  readonly moonDir = uniform(new THREE.Vector3(0, -1, 0));
  readonly sunColor = uniform(new THREE.Color('#fff4e0'));
  readonly night = uniform(0);
  readonly moonPhase = uniform(1); // 0 new .. 1 full

  constructor(radius = 3800) {
    const geo = new THREE.SphereGeometry(radius, 32, 16);
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });

    const skyColor = Fn(() => {
      const dir = normalize(positionLocal);
      const h = dir.y;
      const up = pow(max(h, 0.0), 0.45);
      const base = mix(this.horizon, this.top, up).toVar();
      // Warm haze toward the sun near the horizon.
      const sunAmt = max(dot(dir, this.sunDir), 0.0);
      const haze = pow(sunAmt, 6.0).mul(float(1).sub(up)).mul(0.6);
      base.addAssign(this.sunColor.mul(haze).mul(float(1).sub(this.night)));
      // Below the horizon fade to the horizon colour (hidden by fog/ocean anyway).
      base.assign(mix(base, this.horizon.mul(0.8), smoothstep(0.0, -0.15, h)));

      // Stars: hashed cells on the dome, only at night and above the horizon.
      const g = dir.mul(260.0);
      const cell = floor(g);
      const rnd = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
      const centre = fract(g).sub(0.5).length();
      const twinkle = sin(rnd.mul(500.0).add(time.mul(rnd.mul(3.0).add(1.0)))).mul(0.3).add(0.7);
      const star = step(0.996, rnd).mul(smoothstep(0.3, 0.05, centre)).mul(twinkle);
      base.addAssign(vec3(star.mul(this.night.mul(this.night)).mul(smoothstep(0.02, 0.25, h))));
      return base;
    })();

    const discs = Fn(() => {
      const dir = normalize(positionLocal);
      const sd = dot(dir, this.sunDir);
      const sunDisc = smoothstep(0.9993, 0.9997, sd);
      const sunGlow = pow(max(sd, 0.0), 300.0).mul(0.6);
      const sun = this.sunColor.mul(sunDisc.mul(3.0).add(sunGlow)).mul(float(1).sub(this.night.mul(0.95)));
      const md = dot(dir, this.moonDir);
      const moonDisc = smoothstep(0.9990, 0.9994, md);
      // Cheap phase: darken one side of the disc by offsetting along the sky's x.
      const phaseCut = smoothstep(0.0, 0.002, md.sub(0.9990).sub(abs(dir.x.sub(this.moonDir.x)).mul(float(1).sub(this.moonPhase)).mul(0.02)));
      const moon = vec3(0.85, 0.9, 1.0).mul(moonDisc.mul(phaseCut).mul(1.6));
      return sun.add(moon);
    })();

    mat.colorNode = vec4(skyColor.add(discs), 1);
    registerBloomSource(mat, mrt({ emissive: discs.mul(0.6) }));
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'Sky';
  }

  follow(camera: THREE.Camera): void {
    this.mesh.position.copy(camera.position);
  }
}
