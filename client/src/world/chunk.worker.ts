/// <reference lib="webworker" />
// Builds terrain LOD meshes and grass instances off the main thread.
import { TerrainSampler } from '@shared/terrain';
import { terrainConfig } from '@shared/factions';
import { buildChunkMesh, type ChunkMeshData } from '@shared/chunkMesh';
import { CHUNK_RES } from '@shared/world';
import { scatterGrass, type GrassData } from './grassScatter';

export interface BuildRequest {
  id: number;
  cx: number;
  cz: number;
  heights: Float32Array;
  res: number;
  grassDensity: number; // 0 = no grass
}

export interface BuildResult {
  id: number;
  cx: number;
  cz: number;
  res: number;
  mesh: ChunkMeshData;
  grass: GrassData | null;
  ms: number;
}

const sampler = new TerrainSampler(terrainConfig());

self.onmessage = (e: MessageEvent<BuildRequest>) => {
  const t0 = performance.now();
  const { id, cx, cz, heights, res, grassDensity } = e.data;
  const mesh = buildChunkMesh(sampler, cx, cz, res, 6, { heights, res: CHUNK_RES });
  const grass = grassDensity > 0 ? scatterGrass(sampler, cx, cz, mesh, res, grassDensity) : null;
  const result: BuildResult = { id, cx, cz, res, mesh, grass, ms: performance.now() - t0 };
  const transfer: Transferable[] = [mesh.positions.buffer, mesh.normals.buffer, mesh.colors.buffer, mesh.indices.buffer];
  if (grass) transfer.push(grass.matrices.buffer, grass.colors.buffer);
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(result, transfer);
};
