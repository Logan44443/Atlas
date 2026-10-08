// Grass placement for one chunk. Runs inside the chunk worker, so it only
// depends on three's math classes, not the renderer.
import { Matrix4, Quaternion, Vector3 } from 'three';
import worldData from '@data/world.json';
import { mulberry32 } from '@shared/noise';
import type { TerrainSampler } from '@shared/terrain';
import type { ChunkMeshData } from '@shared/chunkMesh';

const g = worldData.grass;

export interface GrassData {
  matrices: Float32Array;
  colors: Float32Array;
  count: number;
}

/** Instance matrices for one chunk's grass, sampled from its built mesh. */
export function scatterGrass(
  sampler: TerrainSampler,
  cx: number,
  cz: number,
  mesh: ChunkMeshData,
  res: number,
  density: number,
): GrassData {
  const size = sampler.cfg.chunkSize;
  const area = size * size;
  const max = Math.floor(area * g.tuftsPerSquareMeter * density);
  const matrices = new Float32Array(max * 16);
  const colors = new Float32Array(max * 3);
  const rand = mulberry32((cx * 73856093) ^ (cz * 19349663) ^ 0x5bd1e995);
  const n = res + 1;
  const step = size / res;
  const P = mesh.positions;
  const N = mesh.normals;
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const nrm = new Vector3();
  const sc = new Vector3();
  const pv = new Vector3();
  const [hMin, hMax] = g.bladeHeight;
  let count = 0;
  for (let k = 0; k < max; k++) {
    const lx = rand() * size;
    const lz = rand() * size;
    const r1 = rand();
    const r2 = rand();
    const r3 = rand();
    const i = Math.min(Math.floor(lx / step), res - 1);
    const j = Math.min(Math.floor(lz / step), res - 1);
    const tx = lx / step - i;
    const tz = lz / step - j;
    const a = j * n + i;
    const y =
      (P[a * 3 + 1] * (1 - tx) + P[(a + 1) * 3 + 1] * tx) * (1 - tz) +
      (P[(a + n) * 3 + 1] * (1 - tx) + P[(a + n + 1) * 3 + 1] * tx) * tz;
    nrm.set(N[a * 3], N[a * 3 + 1], N[a * 3 + 2]);
    const gr = sampler.grassiness(y, nrm.y) * (1 - sampler.plazaAmount(cx * size + lx, cz * size + lz));
    if (gr < 0.05 || r1 > gr) continue;
    q.setFromUnitVectors(up, nrm.lerp(up, 0.6).normalize());
    const yaw = new Quaternion().setFromAxisAngle(up, r2 * Math.PI * 2);
    q.multiply(yaw);
    const hs = (hMin + (hMax - hMin) * r3) * (0.6 + 0.4 * gr);
    sc.set(1, hs, 1);
    pv.set(lx, y - 0.03, lz);
    m.compose(pv, q, sc);
    m.toArray(matrices, count * 16);
    const v = 0.85 + r2 * 0.3;
    colors[count * 3] = v * (0.95 + r3 * 0.1);
    colors[count * 3 + 1] = v;
    colors[count * 3 + 2] = v * 0.9;
    count++;
  }
  return { matrices, colors, count };
}

