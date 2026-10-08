import * as THREE from 'three/webgpu';
import {
  uniform, time, positionLocal, positionWorld, uv, sin, cos, vec3, mix, float, mx_noise_float, smoothstep,
  color, vec2,
} from 'three/tsl';
import worldData from '@data/world.json';

/** 3-band toon ramp: the core of the painterly, cel-ish look. */
function toonRamp(): THREE.DataTexture {
  const data = new Uint8Array([90, 170, 225, 255]);
  const tex = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
export const TOON_RAMP = toonRamp();

export function createTerrainMaterial(): THREE.MeshToonNodeMaterial {
  const mat = new THREE.MeshToonNodeMaterial({ vertexColors: true, gradientMap: TOON_RAMP });
  // Low-frequency painterly variation so large slopes don't read as flat fills.
  const n = mx_noise_float(positionWorld.xz.mul(0.045)).mul(0.07);
  // vertexColors: true multiplies this by the baked biome colour.
  mat.colorNode = vec3(float(1).add(n));
  mat.name = 'Terrain';
  return mat;
}

const gcfg = worldData.grass;
export const wind = {
  strength: uniform(gcfg.windStrength),
  speed: uniform(gcfg.windSpeed),
  scale: uniform(gcfg.windScale),
};

export function createGrassMaterial(): THREE.MeshToonNodeMaterial {
  const mat = new THREE.MeshToonNodeMaterial({ side: THREE.DoubleSide, gradientMap: TOON_RAMP });
  const h = uv().y; // 0 at root .. 1 at tip
  const bend = h.mul(h);
  // positionLocal is already instance-transformed here (mesh sits at chunk origin).
  const p = positionLocal;
  const t = time.mul(wind.speed);
  const gust = sin(p.x.mul(wind.scale).add(t)).add(cos(p.z.mul(wind.scale.mul(0.7)).add(t.mul(1.3)))).mul(0.5);
  const flutter = sin(t.mul(3.1).add(p.x.mul(1.7)).add(p.z.mul(1.3))).mul(0.15);
  const sway = gust.add(flutter).add(0.4).mul(wind.strength).mul(bend);
  mat.positionNode = p.add(vec3(sway, sway.abs().mul(-0.25), sway.mul(0.6)));
  mat.colorNode = mix(color(gcfg.baseColor), color(gcfg.tipColor), smoothstep(0.0, 1.0, h));
  mat.name = 'Grass';
  return mat;
}

export function createWaterMaterial(): THREE.MeshToonNodeMaterial {
  const w = worldData.water;
  const mat = new THREE.MeshToonNodeMaterial({ transparent: true, gradientMap: TOON_RAMP, depthWrite: false });
  const xz = positionWorld.xz;
  const t = time.mul(0.25);
  const ripple = mx_noise_float(vec3(xz.mul(0.08), t)).mul(0.5).add(0.5);
  const sparkle = smoothstep(0.78, 0.86, mx_noise_float(vec3(xz.mul(0.35).add(vec2(t.mul(2), 0)), t.mul(3))));
  mat.colorNode = mix(color(w.deepColor), color(w.shallowColor), ripple).add(vec3(sparkle.mul(0.6)));
  mat.opacityNode = float(w.opacity);
  mat.name = 'Water';
  return mat;
}
