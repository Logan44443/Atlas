// Trees and rocks: the scatter rules used by the world build script, plus the
// solid parts of each prop (trunks, boulders) so the server, the offline sim
// and the client's physics agree on what bending and bodies bump into.
import propsData from '../data/props.json';
import worldData from '../data/world.json';
import { mulberry32 } from './noise';
import { FLATS } from './factions';
import type { TerrainSampler } from './terrain';
import type { PropInstance, PropType } from './world';

type PropRule = { type: PropType; perChunk: number; minHeight: number; maxHeight: number; minSlopeY: number; scale: [number, number]; clusterScale: number; clusterThreshold: number };
const RULES = propsData.rules as PropRule[];
const SOLID = propsData.solid as unknown as Record<string, { radius: number; height: number }>;

/** Deterministic props of one chunk (same on every machine for the same world.json). */
export function chunkProps(sampler: TerrainSampler, cx: number, cz: number, maxH?: number): PropInstance[] {
  const cfg = sampler.cfg;
  const size = cfg.chunkSize;
  const ox = cx * size;
  const oz = cz * size;
  const props: PropInstance[] = [];
  if (maxH !== undefined && maxH <= cfg.seaLevel) return props;
  const rand = mulberry32(((cx + 1000) * 92821) ^ ((cz + 1000) * 68917) ^ cfg.seed);
  for (const rule of RULES) {
    for (let k = 0; k < rule.perChunk; k++) {
      const lx = rand() * size;
      const lz = rand() * size;
      const r = rand();
      const sc = rand();
      const yaw = rand() * Math.PI * 2;
      const wx = ox + lx;
      const wz = oz + lz;
      const h = sampler.height(wx, wz);
      if (h < rule.minHeight || h > rule.maxHeight) continue;
      if (sampler.slopeY(wx, wz) < rule.minSlopeY) continue;
      // Cluster mask: forests and boulder fields instead of uniform noise.
      const cluster = sampler.clusterNoise(wx / rule.clusterScale, wz / rule.clusterScale);
      if (cluster < rule.clusterThreshold || r > (cluster - rule.clusterThreshold) * 3) continue;
      // Keep the spawn clearing open.
      if (Math.hypot(wx - worldData.spawn.x, wz - worldData.spawn.z) < 18) continue;
      // ...and the hub plazas and shrine platforms.
      if (FLATS.some((f) => Math.hypot(wx - f.x, wz - f.z) < f.radius + 10)) continue;
      props.push({ t: rule.type, p: [+lx.toFixed(2), +(h - 0.1).toFixed(2), +lz.toFixed(2)], r: +yaw.toFixed(3), s: +(rule.scale[0] + (rule.scale[1] - rule.scale[0]) * sc).toFixed(2) });
    }
  }
  return props;
}

/** The solid core of a prop: an upright cylinder in world space. */
export interface Obstacle {
  type: PropType;
  x: number;
  z: number;
  /** base height */
  y: number;
  radius: number;
  height: number;
}

/** Solid shape of a prop, or null for things you walk through (bushes). */
export function obstacleOf(p: PropInstance, cx: number, cz: number, size: number): Obstacle | null {
  const s = SOLID[p.t];
  if (!s) return null;
  return { type: p.t, x: cx * size + p.p[0], z: cz * size + p.p[2], y: p.p[1], radius: s.radius * p.s, height: s.height * p.s };
}

/**
 * Lazily generated obstacles per chunk, for the sim (projectiles stop on trunks
 * and boulders) and for placing bending marks. Keeps the most recent chunks.
 */
export class Obstacles {
  private cache = new Map<string, Obstacle[]>();
  private size: number;

  constructor(private sampler: TerrainSampler, private maxChunks = 512) {
    this.size = sampler.cfg.chunkSize;
  }

  chunk(cx: number, cz: number): Obstacle[] {
    const key = `${cx}_${cz}`;
    let list = this.cache.get(key);
    if (list) {
      // Refresh LRU order.
      this.cache.delete(key);
      this.cache.set(key, list);
      return list;
    }
    list = chunkProps(this.sampler, cx, cz).flatMap((p) => obstacleOf(p, cx, cz, this.size) ?? []);
    this.cache.set(key, list);
    if (this.cache.size > this.maxChunks) this.cache.delete(this.cache.keys().next().value!);
    return list;
  }

  /** Obstacles whose footprint comes within `r` of (x, z). */
  near(x: number, z: number, r: number, out: Obstacle[] = []): Obstacle[] {
    const s = this.size;
    const reach = r + 3;
    for (let cx = Math.floor((x - reach) / s); cx <= Math.floor((x + reach) / s); cx++) {
      for (let cz = Math.floor((z - reach) / s); cz <= Math.floor((z + reach) / s); cz++) {
        for (const o of this.chunk(cx, cz)) if (Math.hypot(o.x - x, o.z - z) < o.radius + r) out.push(o);
      }
    }
    return out;
  }

  /** The obstacle a sphere at (x, y, z) with radius r touches, if any. */
  hit(x: number, y: number, z: number, r: number): Obstacle | null {
    for (const o of this.near(x, z, r)) if (y > o.y - r && y < o.y + o.height + r) return o;
    return null;
  }
}
