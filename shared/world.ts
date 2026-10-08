// Chunk addressing + on-disk formats shared by the world build script, client
// and (later) server.

export const CHUNK_RES = 64; // height samples per side - 1 (1 m spacing)
export const CHUNK_SAMPLES = CHUNK_RES + 1;
export const HEIGHT_SCALE = 100; // int16 centimetres

export const chunkKey = (cx: number, cz: number) => `${cx}_${cz}`;
export function parseChunkKey(k: string): [number, number] {
  const [a, b] = k.split('_');
  return [parseInt(a, 10), parseInt(b, 10)];
}

export type PropType = 'pine' | 'broadleaf' | 'rock' | 'bush';

export interface PropInstance {
  t: PropType;
  /** chunk-local x, world y, chunk-local z */
  p: [number, number, number];
  /** yaw radians */
  r: number;
  s: number;
}

export interface ChunkJson {
  v: number;
  cx: number;
  cz: number;
  biome: string;
  props: PropInstance[];
  npcSpawns: Array<{ id: string; p: [number, number, number] }>;
  resourceNodes: Array<{ type: string; p: [number, number, number] }>;
  basePlots: Array<{ id: string; p: [number, number, number]; size: number }>;
}

export interface WorldManifest {
  version: string;
  generatedAt: string;
  chunkSize: number;
  worldChunks: number;
  /** min chunk index on each axis (world is centred on 0,0) */
  minChunk: number;
  maxChunk: number;
  heightFormat: 'int16-cm-65x65';
  /** key -> content hash (covers .bin and .json) */
  chunks: Record<string, string>;
}

export function decodeHeights(buf: ArrayBuffer): Float32Array {
  const i16 = new Int16Array(buf);
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / HEIGHT_SCALE;
  return out;
}
