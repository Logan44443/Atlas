import * as THREE from 'three/webgpu';
import worldData from '@data/world.json';
import { mulberry32 } from '@shared/noise';
import { createGrassMaterial } from './materials';
import type { GrassData } from './grassScatter';

const g = worldData.grass;

/** One tuft = several crossed, tapered blades. uv.y = 0 root .. 1 tip. */
function createTuftGeometry(): THREE.BufferGeometry {
  const blades = g.bladesPerTuft;
  const segs = 2;
  const pos: number[] = [];
  const uvs: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const rand = mulberry32(7);
  for (let b = 0; b < blades; b++) {
    const ang = (b / blades) * Math.PI + rand() * 0.4;
    const ox = (rand() - 0.5) * 0.25;
    const oz = (rand() - 0.5) * 0.25;
    const lean = (rand() - 0.5) * 0.25;
    const hScale = 0.7 + rand() * 0.6;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const base = pos.length / 3;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const w = g.bladeWidth * (1 - t * 0.85);
      const y = t * hScale;
      const lx = lean * t * t;
      for (const side of [-1, 1]) {
        pos.push(ox + ca * w * side + lx * sa, y, oz + sa * w * side - lx * ca);
        uvs.push(side < 0 ? 0 : 1, t);
        nrm.push(0, 1, 0); // up-facing normals: soft, uniform lighting like painted grass
      }
    }
    const tip = pos.length / 3;
    pos.push(ox + lean * sa * 1.2, hScale * 1.12, oz - lean * ca * 1.2);
    uvs.push(0.5, 1);
    nrm.push(0, 1, 0);
    for (let s = 0; s < segs; s++) {
      const a = base + s * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    idx.push(base + segs * 2, base + segs * 2 + 1, tip);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  return geo;
}

let sharedGeo: THREE.BufferGeometry | null = null;
let sharedMat: THREE.MeshToonNodeMaterial | null = null;

export function createGrassMesh(data: GrassData): THREE.InstancedMesh | null {
  if (data.count === 0) return null;
  sharedGeo ??= createTuftGeometry();
  sharedMat ??= createGrassMaterial();
  const mesh = new THREE.InstancedMesh(sharedGeo, sharedMat, data.count);
  mesh.instanceMatrix = new THREE.InstancedBufferAttribute(data.matrices.subarray(0, data.count * 16), 16);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(data.colors.subarray(0, data.count * 3), 3);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.name = 'Grass';
  return mesh;
}
