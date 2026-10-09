// Resource nodes (Phase 9): timber, boulders, sand banks, ore veins, hot springs
// and ash piles. They are a pure function of the world seed and terrain, so the
// server, offline play and the renderer all agree without shipping a list.
// Each faction hub also gets a few starter nodes just outside its walls.
import worldData from '../data/world.json';
import matData from '../data/crafting/materials.json';
import { hash2 } from './noise';
import { TerrainSampler } from './terrain';
import { FACTIONS, CONTESTED_ZONES, terrainConfig } from './factions';

export type NodeType = 'timber' | 'boulder' | 'sand' | 'ore_node' | 'hot_spring' | 'ash_pile';
export interface ResourceNode {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  z: number;
}
export interface NodeDef {
  name: string;
  gather: Record<string, number> | null;
  cooldown: number;
}
export const NODE_DEFS = matData.nodes as Record<NodeType, NodeDef>;

const CHUNK = worldData.chunkSize;
const SEA = worldData.seaLevel;
const SAND_MAX = worldData.biomes.sandMaxHeight;
const SEED = worldData.seed;
/** Places where fire has burned for ages: ash piles gather around them. */
const ASH_SITES: Array<[number, number]> = [
  [-960, 320], [-1224, 280], ...FACTIONS.filter((f) => f.id === 'ash' || f.id === 'redfang').map((f) => [f.hub.x, f.hub.z] as [number, number]),
];

let sampler: TerrainSampler | null = null;
const terrain = () => (sampler ??= new TerrainSampler(terrainConfig()));

/** Keep nodes off hub plazas/walls and shrine platforms. */
function blocked(x: number, z: number): boolean {
  for (const f of FACTIONS) if (Math.hypot(x - f.hub.x, z - f.hub.z) < f.hub.radius + 6) return true;
  for (const c of CONTESTED_ZONES) if (Math.hypot(x - c.x, z - c.z) < 30) return true;
  return false;
}

/** Starter nodes outside every hub's gate, so new players find each type close to home. */
const HUB_NODES: ResourceNode[] = (() => {
  const out: ResourceNode[] = [];
  const kinds: NodeType[] = ['timber', 'timber', 'boulder', 'boulder', 'sand', 'ore_node', 'hot_spring', 'ash_pile'];
  for (const f of FACTIONS) {
    kinds.forEach((type, i) => {
      // A fan in front of the gate (+z), between the wall and the edge of the safe zone.
      const a = Math.PI / 2 + (i - (kinds.length - 1) / 2) * 0.32;
      const r = f.hub.radius + 16 + (i % 2) * 8;
      const x = Math.round(f.hub.x + Math.cos(a) * r);
      const z = Math.round(f.hub.z + Math.sin(a) * r);
      out.push({ id: `hub_${f.id}_${i}`, type, x, y: 0, z });
    });
  }
  return out;
})();

const cache = new Map<string, ResourceNode[]>();

/** All nodes whose position falls in chunk (cx, cz). */
export function nodesInChunk(cx: number, cz: number): ResourceNode[] {
  const key = `${cx}_${cz}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const t = terrain();
  const out: ResourceNode[] = [];
  for (let i = 0; i < 5; i++) {
    const x = (cx + 0.1 + hash2(cx * 7 + i, cz, SEED + 11) * 0.8) * CHUNK;
    const z = (cz + 0.1 + hash2(cx, cz * 7 + i, SEED + 23) * 0.8) * CHUNK;
    if (blocked(x, z)) continue;
    const h = t.height(x, z);
    if (h < SEA - 0.2) continue;
    const roll = hash2(cx * 31 + i, cz * 17 - i, SEED + 37);
    const ny = t.slopeY(x, z, 1.5);
    const ash = ASH_SITES.some(([ax, az]) => Math.hypot(x - ax, z - az) < 380);
    let type: NodeType | null = null;
    if (h < SEA + SAND_MAX) type = roll < 0.55 ? 'sand' : null;
    else if (roll < 0.03) type = 'hot_spring';
    else if (ash && roll < 0.25) type = 'ash_pile';
    else if (roll < 0.04) type = 'ash_pile';
    else if (ny < 0.8 || h > 42) type = roll < 0.45 ? 'ore_node' : roll < 0.7 ? 'boulder' : null;
    else if (t.grassiness(h, ny) > 0.5 && t.clusterNoise(x, z) > -0.1) type = roll < 0.5 ? 'timber' : roll < 0.65 ? 'boulder' : null;
    else type = roll < 0.3 ? 'boulder' : null;
    if (type) out.push({ id: `${key}_${i}`, type, x: Math.round(x * 10) / 10, y: h, z: Math.round(z * 10) / 10 });
  }
  for (const n of HUB_NODES) {
    if (Math.floor(n.x / CHUNK) === cx && Math.floor(n.z / CHUNK) === cz) out.push({ ...n, y: t.height(n.x, n.z) });
  }
  if (cache.size > 4000) cache.clear();
  cache.set(key, out);
  return out;
}

/** Nodes within `radius` metres of (x, z). */
export function nodesNear(x: number, z: number, radius: number): ResourceNode[] {
  const out: ResourceNode[] = [];
  const c0x = Math.floor((x - radius) / CHUNK);
  const c1x = Math.floor((x + radius) / CHUNK);
  const c0z = Math.floor((z - radius) / CHUNK);
  const c1z = Math.floor((z + radius) / CHUNK);
  for (let cx = c0x; cx <= c1x; cx++) {
    for (let cz = c0z; cz <= c1z; cz++) {
      for (const n of nodesInChunk(cx, cz)) if (Math.hypot(n.x - x, n.z - z) <= radius) out.push(n);
    }
  }
  return out;
}

/** Closest node (optionally of a type) within `radius`. */
export function nearestNode(x: number, z: number, radius: number, type?: NodeType): ResourceNode | null {
  let best: ResourceNode | null = null;
  let bd = radius;
  for (const n of nodesNear(x, z, radius)) {
    if (type && n.type !== type) continue;
    const d = Math.hypot(n.x - x, n.z - z);
    if (d <= bd) {
      bd = d;
      best = n;
    }
  }
  return best;
}

/** Look a node up by id (ids encode their chunk; hub starters are listed). */
export function nodeById(id: string): ResourceNode | null {
  const hub = HUB_NODES.find((n) => n.id === id);
  if (hub) return { ...hub, y: terrain().height(hub.x, hub.z) };
  const m = /^(-?\d+)_(-?\d+)_\d+$/.exec(id);
  if (!m) return null;
  return nodesInChunk(+m[1], +m[2]).find((n) => n.id === id) ?? null;
}
