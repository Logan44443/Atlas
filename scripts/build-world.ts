// Generates the streamed world: client/public/world/manifest.json plus one
// .bin (heights) and .json (props, spawns, nodes, plots) per 64 m chunk.
// Real art will later replace .bin with .glb; the manifest/hash/caching flow stays.
//   npx tsx scripts/build-world.ts [--force]
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import worldData from '../data/world.json' with { type: 'json' };
import propsData from '../data/props.json' with { type: 'json' };
import factionData from '../data/factions.json' with { type: 'json' };
import zoneData from '../data/zones.json' with { type: 'json' };
import { TerrainSampler } from '../shared/terrain';
import { terrainConfig } from '../shared/factions';
import { chunkProps } from '../shared/props';
import { CHUNK_SAMPLES, CHUNK_RES, HEIGHT_SCALE, chunkKey, type ChunkJson, type WorldManifest } from '../shared/world';

const GENERATOR_VERSION = 3;
const outDir = join(import.meta.dirname, '..', 'client', 'public', 'world');
const chunkDir = join(outDir, 'chunks');
const cfg = terrainConfig();
const configHash = createHash('sha1')
  .update(JSON.stringify(worldData) + JSON.stringify(propsData) + JSON.stringify(factionData.factions.map((f) => f.hub)) + JSON.stringify(zoneData.contested) + GENERATOR_VERSION)
  .digest('hex')
  .slice(0, 12);

const manifestPath = join(outDir, 'manifest.json');
if (!process.argv.includes('--force') && existsSync(manifestPath)) {
  const old = JSON.parse(readFileSync(manifestPath, 'utf8')) as WorldManifest;
  if (old.version === configHash) {
    console.log(`world up to date (${configHash}, ${Object.keys(old.chunks).length} chunks)`);
    process.exit(0);
  }
}

mkdirSync(chunkDir, { recursive: true });
const sampler = new TerrainSampler(cfg);
const size = cfg.chunkSize;
const half = cfg.worldChunks / 2;
const minChunk = -half;
const maxChunk = half - 1;
const step = size / CHUNK_RES;
const chunks: Record<string, string> = {};
const t0 = Date.now();


for (let cz = minChunk; cz <= maxChunk; cz++) {
  for (let cx = minChunk; cx <= maxChunk; cx++) {
    const ox = cx * size;
    const oz = cz * size;
    const heights = new Int16Array(CHUNK_SAMPLES * CHUNK_SAMPLES);
    let minH = Infinity;
    let maxH = -Infinity;
    for (let j = 0; j < CHUNK_SAMPLES; j++) {
      for (let i = 0; i < CHUNK_SAMPLES; i++) {
        const h = sampler.height(ox + i * step, oz + j * step);
        heights[j * CHUNK_SAMPLES + i] = Math.round(h * HEIGHT_SCALE);
        minH = Math.min(minH, h);
        maxH = Math.max(maxH, h);
      }
    }

    const props = chunkProps(sampler, cx, cz, maxH);

    const json: ChunkJson = {
      v: GENERATOR_VERSION,
      cx,
      cz,
      biome: maxH < cfg.seaLevel ? 'ocean' : maxH > cfg.biomes.grassMaxHeight ? 'highlands' : 'meadow',
      props,
      npcSpawns: [],
      resourceNodes: [],
      basePlots: [],
    };
    const bin = Buffer.from(heights.buffer);
    const js = JSON.stringify(json);
    const key = chunkKey(cx, cz);
    writeFileSync(join(chunkDir, `${key}.bin`), bin);
    writeFileSync(join(chunkDir, `${key}.json`), js);
    chunks[key] = createHash('sha1').update(bin).update(js).digest('hex').slice(0, 10);
  }
}

const manifest: WorldManifest = {
  version: configHash,
  generatedAt: new Date().toISOString(),
  chunkSize: size,
  worldChunks: cfg.worldChunks,
  minChunk,
  maxChunk,
  heightFormat: 'int16-cm-65x65',
  chunks,
};
writeFileSync(manifestPath, JSON.stringify(manifest));
console.log(`built ${Object.keys(chunks).length} chunks in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${outDir} (version ${configHash})`);
