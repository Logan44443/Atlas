// Builds terrain chunk geometry as plain typed arrays so it can run in a Web
// Worker (client) or a build script (Node) and be transferred without copies.
import type { TerrainSampler } from './terrain';

export interface ChunkMeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  minY: number;
  maxY: number;
}

export interface HeightGrid {
  /** (res+1)^2 heights, row-major by z then x, local to the chunk origin. */
  heights: Float32Array;
  res: number;
  size: number;
}

export function sampleHeightGrid(s: TerrainSampler, cx: number, cz: number, res: number): HeightGrid {
  const size = s.cfg.chunkSize;
  const n = res + 1;
  const heights = new Float32Array(n * n);
  const step = size / res;
  const ox = cx * size;
  const oz = cz * size;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[j * n + i] = s.height(ox + i * step, oz + j * step);
  return { heights, res, size };
}

/**
 * Grid mesh for chunk (cx, cz) with `res` quads per side, in chunk-local space
 * (origin at the chunk's min corner). A skirt hangs down around the edge to
 * hide cracks between neighbouring LODs.
 */
export function buildChunkMesh(
  s: TerrainSampler,
  cx: number,
  cz: number,
  res: number,
  skirt = 6,
  grid?: { heights: Float32Array; res: number },
): ChunkMeshData {
  const size = s.cfg.chunkSize;
  const step = size / res;
  const ox = cx * size;
  const oz = cz * size;
  const n = res + 1;
  // Sample with a 1-cell border so normals at edges are seamless. Interior
  // samples come from the streamed height grid when given; the border (which
  // lies in neighbouring chunks) comes from the deterministic generator.
  const bn = n + 2;
  const h = new Float32Array(bn * bn);
  const gStride = grid ? grid.res / res : 0;
  const gn = grid ? grid.res + 1 : 0;
  for (let j = 0; j < bn; j++) {
    for (let i = 0; i < bn; i++) {
      const inside = i >= 1 && j >= 1 && i <= n && j <= n;
      h[j * bn + i] =
        grid && inside
          ? grid.heights[(j - 1) * gStride * gn + (i - 1) * gStride]
          : s.height(ox + (i - 1) * step, oz + (j - 1) * step);
    }
  }

  const vCount = n * n + 4 * n;
  const positions = new Float32Array(vCount * 3);
  const normals = new Float32Array(vCount * 3);
  const colors = new Float32Array(vCount * 3);
  const col: [number, number, number] = [0, 0, 0];
  let minY = Infinity;
  let maxY = -Infinity;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const v = j * n + i;
      const y = h[(j + 1) * bn + (i + 1)];
      const nx = h[(j + 1) * bn + i] - h[(j + 1) * bn + (i + 2)];
      const nz = h[j * bn + (i + 1)] - h[(j + 2) * bn + (i + 1)];
      const ny = 2 * step;
      const inv = 1 / Math.hypot(nx, ny, nz);
      positions[v * 3] = i * step;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = j * step;
      normals[v * 3] = nx * inv;
      normals[v * 3 + 1] = ny * inv;
      normals[v * 3 + 2] = nz * inv;
      s.color(ox + i * step, oz + j * step, y, ny * inv, col);
      colors[v * 3] = col[0];
      colors[v * 3 + 1] = col[1];
      colors[v * 3 + 2] = col[2];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  // Skirt vertices: copies of the 4 edges, dropped by `skirt` metres.
  const edges: number[][] = [[], [], [], []];
  for (let k = 0; k < n; k++) {
    edges[0].push(k); // z = 0
    edges[1].push((n - 1) * n + k); // z = max
    edges[2].push(k * n); // x = 0
    edges[3].push(k * n + (n - 1)); // x = max
  }
  let sv = n * n;
  const skirtIdx: number[][] = [];
  for (const e of edges) {
    const row: number[] = [];
    for (const src of e) {
      positions[sv * 3] = positions[src * 3];
      positions[sv * 3 + 1] = positions[src * 3 + 1] - skirt;
      positions[sv * 3 + 2] = positions[src * 3 + 2];
      for (let c = 0; c < 3; c++) {
        normals[sv * 3 + c] = normals[src * 3 + c];
        colors[sv * 3 + c] = colors[src * 3 + c] * 0.8;
      }
      row.push(sv++);
    }
    skirtIdx.push(row);
  }

  const quadCount = res * res + 4 * res;
  const indices = new Uint32Array(quadCount * 6);
  let p = 0;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // Alternate diagonals for less directional artefacts.
      if ((i + j) & 1) {
        indices[p++] = a; indices[p++] = c; indices[p++] = b;
        indices[p++] = b; indices[p++] = c; indices[p++] = d;
      } else {
        indices[p++] = a; indices[p++] = c; indices[p++] = d;
        indices[p++] = a; indices[p++] = d; indices[p++] = b;
      }
    }
  }
  // Skirt quads, wound to face outward.
  for (let e = 0; e < 4; e++) {
    const top = edges[e];
    const bot = skirtIdx[e];
    for (let k = 0; k < res; k++) {
      const a = top[k];
      const b = top[k + 1];
      const c = bot[k];
      const d = bot[k + 1];
      if (e === 0 || e === 3) {
        indices[p++] = a; indices[p++] = b; indices[p++] = c;
        indices[p++] = b; indices[p++] = d; indices[p++] = c;
      } else {
        indices[p++] = a; indices[p++] = c; indices[p++] = b;
        indices[p++] = b; indices[p++] = c; indices[p++] = d;
      }
    }
  }
  return { positions, normals, colors, indices, minY: minY - skirt, maxY };
}

/** Bilinear height lookup inside a HeightGrid (local coords in metres). */
export function gridHeightAt(g: HeightGrid, lx: number, lz: number): number {
  const n = g.res + 1;
  const fx = Math.min(Math.max((lx / g.size) * g.res, 0), g.res - 1e-4);
  const fz = Math.min(Math.max((lz / g.size) * g.res, 0), g.res - 1e-4);
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const h00 = g.heights[j * n + i];
  const h10 = g.heights[j * n + i + 1];
  const h01 = g.heights[(j + 1) * n + i];
  const h11 = g.heights[(j + 1) * n + i + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}
