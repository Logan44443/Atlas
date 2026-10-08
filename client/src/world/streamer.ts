import * as THREE from 'three/webgpu';
import { chunkKey, CHUNK_RES } from '@shared/world';
import { gridHeightAt } from '@shared/chunkMesh';
import type { TerrainSampler } from '@shared/terrain';
import type { QualityPreset } from '../engine/quality';
import { ChunkStore, type ChunkData } from './chunkStore';
import type { BuildRequest, BuildResult } from './chunk.worker';
import { createTerrainMaterial } from './materials';
import { createGrassMesh } from './grass';
import { buildPropMeshes, type PropLod } from './props';

export type Lod = PropLod;
const LOD_RANK: Record<Lod, number> = { near: 0, mid: 1, far: 2 };

interface VisualChunk {
  key: string;
  cx: number;
  cz: number;
  lod: Lod | null;
  pendingLod: Lod | null;
  group: THREE.Group;
  data: ChunkData | null;
}

interface Job {
  key: string;
  cx: number;
  cz: number;
  lod: Lod;
  priority: number;
}

export interface StreamerHooks {
  /** Called when a chunk becomes near (full detail + physics). */
  onNear?(cx: number, cz: number, data: ChunkData): void;
  /** Called when a chunk stops being near. */
  onLeaveNear?(cx: number, cz: number): void;
}

/**
 * Keeps load rings of chunks around a focus point: near (full mesh, grass,
 * props, physics), mid (simplified mesh, props, no physics), far (low-poly
 * terrain + cheap tree impostors). Prefetches data along the direction of
 * travel and unloads chunks that fall well behind.
 */
export class ChunkStreamer {
  readonly group = new THREE.Group();
  readonly store: ChunkStore;
  private visuals = new Map<string, VisualChunk>();
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private jobs = new Map<number, Job>();
  private queue: Job[] = [];
  private results: BuildResult[] = [];
  private nextId = 1;
  private material = createTerrainMaterial();
  private q: QualityPreset;
  private focus = new THREE.Vector3();
  private velocity = new THREE.Vector3();
  private lastFocus = new THREE.Vector3();
  private dataQueue: Array<{ cx: number; cz: number; priority: number }> = [];
  private maxConcurrentFetches = 12;
  /** Finished builds uploaded per frame; raised behind the loading screen. */
  applyBudget = 3;
  private hooks: StreamerHooks;
  readonly counts = { near: 0, mid: 0, far: 0, building: 0, queued: 0, prefetch: 0 };
  readonly size: number;
  buildMsAvg = 0;
  private nearKeys = new Set<string>();

  constructor(private sampler: TerrainSampler, q: QualityPreset, hooks: StreamerHooks = {}) {
    this.q = q;
    this.hooks = hooks;
    this.size = sampler.cfg.chunkSize;
    this.store = new ChunkStore();
    this.group.name = 'World';
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./chunk.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<BuildResult>) => {
        this.results.push(e.data);
        this.idleWorkers.push(w);
      };
      w.onerror = (e) => console.error('chunk worker error', e.message);
      this.workers.push(w);
      // Two slots per worker so the next job is already queued when one finishes.
      this.idleWorkers.push(w, w);
    }
  }

  async init(): Promise<void> {
    await this.store.init();
  }

  setQuality(q: QualityPreset): void {
    this.q = q;
    // Rebuild everything at the new resolution/density.
    for (const v of this.visuals.values()) this.disposeVisual(v);
    this.visuals.clear();
    for (const k of this.nearKeys) {
      const [cx, cz] = k.split('_').map(Number);
      this.hooks.onLeaveNear?.(cx, cz);
    }
    this.nearKeys.clear();
    this.queue.length = 0;
  }

  /** Height at world x,z from streamed data when available. */
  heightAt(x: number, z: number): number {
    const cx = Math.floor(x / this.size);
    const cz = Math.floor(z / this.size);
    const d = this.store.peek(chunkKey(cx, cz));
    if (d) return gridHeightAt({ heights: d.heights, res: CHUNK_RES, size: this.size }, x - cx * this.size, z - cz * this.size);
    return this.sampler.height(x, z);
  }

  lodFor(dist: number, current: Lod | null): Lod | null {
    const r = this.q.rings;
    // Hysteresis: keep the current (finer) LOD until we're half a chunk past its edge.
    const pad = 0.5;
    const near = current === 'near' ? r.near + 0.5 + pad : r.near + 0.5;
    const mid = current && LOD_RANK[current] <= 1 ? r.mid + 0.5 + pad : r.mid + 0.5;
    const far = current ? r.far + 0.5 + pad : r.far + 0.5;
    if (dist <= near) return 'near';
    if (dist <= mid) return 'mid';
    if (dist <= far) return 'far';
    return null;
  }

  /** Are all near-ring chunks around the focus built? Used by the loading screen. */
  nearReady(): boolean {
    const r = this.q.rings.near;
    const pcx = Math.floor(this.focus.x / this.size);
    const pcz = Math.floor(this.focus.z / this.size);
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        if (!this.store.has(pcx + dx, pcz + dz)) continue;
        const v = this.visuals.get(chunkKey(pcx + dx, pcz + dz));
        if (!v || v.lod === null) return false;
      }
    return true;
  }

  update(focus: THREE.Vector3, dt: number): void {
    this.focus.copy(focus);
    if (dt > 0) {
      const inst = new THREE.Vector3().subVectors(focus, this.lastFocus).divideScalar(dt);
      inst.y = 0;
      if (inst.length() < 500) this.velocity.lerp(inst, Math.min(1, dt * 3));
    }
    this.lastFocus.copy(focus);

    const fx = focus.x / this.size;
    const fz = focus.z / this.size;
    const pcx = Math.floor(fx);
    const pcz = Math.floor(fz);
    const R = this.q.rings.far + 1;
    const dir = this.velocity.lengthSq() > 1 ? this.velocity.clone().normalize() : null;

    // 1. Desired LOD per chunk in range.
    const seen = new Set<string>();
    this.queue.length = 0;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        if (!this.store.has(cx, cz)) continue;
        const key = chunkKey(cx, cz);
        const dist = Math.hypot(cx + 0.5 - fx, cz + 0.5 - fz);
        const v = this.visuals.get(key);
        const want = this.lodFor(dist, v?.lod ?? null);
        if (!want) continue;
        seen.add(key);
        if (v && (v.lod === want || v.pendingLod === want)) continue;
        // Chunks ahead of us load first.
        let ahead = 0;
        if (dir) ahead = ((cx + 0.5 - fx) * dir.x + (cz + 0.5 - fz) * dir.z) / Math.max(dist, 0.001);
        this.queue.push({ key, cx, cz, lod: want, priority: dist - ahead * 1.5 + LOD_RANK[want] * 0.5 });
      }
    }
    this.queue.sort((a, b) => a.priority - b.priority);

    // 2. Unload visuals out of range.
    for (const [key, v] of this.visuals) {
      if (seen.has(key)) continue;
      const dist = Math.hypot(v.cx + 0.5 - fx, v.cz + 0.5 - fz);
      if (dist > this.q.rings.far + 1.5) {
        this.disposeVisual(v);
        this.visuals.delete(key);
      }
    }

    // 3. Prefetch data ahead of travel (no meshes, just warm the caches).
    this.dataQueue.length = 0;
    if (dir) {
      const reach = this.q.rings.far + 3;
      for (let s = R; s <= reach; s++) {
        for (let w = -2; w <= 2; w++) {
          const cx = Math.floor(fx + dir.x * s - dir.z * w);
          const cz = Math.floor(fz + dir.z * s + dir.x * w);
          if (!this.store.has(cx, cz)) continue;
          const key = chunkKey(cx, cz);
          if (this.store.peek(key) || this.store.isLoading(key)) continue;
          this.dataQueue.push({ cx, cz, priority: 100 + s });
        }
      }
    }
    this.counts.prefetch = this.dataQueue.length;

    // 4. Kick fetches + builds.
    let fetching = this.store.stats.inFlight;
    for (const job of this.queue) {
      const v = this.ensureVisual(job);
      if (v.pendingLod) continue;
      const data = this.store.peek(job.key);
      if (!data) {
        if (fetching < this.maxConcurrentFetches && !this.store.isLoading(job.key)) {
          fetching++;
          void this.store.get(job.cx, job.cz);
        }
        continue;
      }
      v.data = data;
      if (this.idleWorkers.length === 0) continue;
      this.dispatch(v, job.lod, data);
    }
    for (const p of this.dataQueue) {
      if (fetching >= this.maxConcurrentFetches) break;
      fetching++;
      void this.store.get(p.cx, p.cz);
    }

    // 5. Apply finished builds (bounded per frame to avoid hitches).
    let budget = this.applyBudget;
    while (this.results.length && budget-- > 0) this.apply(this.results.shift()!);

    this.counts.near = this.counts.mid = this.counts.far = 0;
    for (const v of this.visuals.values()) if (v.lod) this.counts[v.lod]++;
    this.counts.building = this.jobs.size;
    this.counts.queued = this.queue.length;
  }

  private ensureVisual(job: Job): VisualChunk {
    let v = this.visuals.get(job.key);
    if (!v) {
      v = { key: job.key, cx: job.cx, cz: job.cz, lod: null, pendingLod: null, group: new THREE.Group(), data: null };
      v.group.position.set(job.cx * this.size, 0, job.cz * this.size);
      v.group.name = `chunk ${job.key}`;
      this.group.add(v.group);
      this.visuals.set(job.key, v);
    }
    return v;
  }

  private dispatch(v: VisualChunk, lod: Lod, data: ChunkData): void {
    const w = this.idleWorkers.pop()!;
    const id = this.nextId++;
    v.pendingLod = lod;
    this.jobs.set(id, { key: v.key, cx: v.cx, cz: v.cz, lod, priority: 0 });
    const grassRange = this.q.grassRadius / this.size;
    const dist = Math.hypot(v.cx + 0.5 - this.focus.x / this.size, v.cz + 0.5 - this.focus.z / this.size);
    const req: BuildRequest = {
      id,
      cx: v.cx,
      cz: v.cz,
      heights: data.heights,
      res: this.q.terrainSegments[lod],
      grassDensity: lod === 'near' || (lod === 'mid' && dist <= grassRange + 0.7) ? this.q.grassDensity : 0,
    };
    w.postMessage(req);
  }

  private apply(r: BuildResult): void {
    const job = this.jobs.get(r.id);
    this.jobs.delete(r.id);
    if (!job) return;
    this.buildMsAvg = this.buildMsAvg * 0.9 + r.ms * 0.1;
    const v = this.visuals.get(job.key);
    if (!v || v.pendingLod !== job.lod) return; // unloaded or superseded meanwhile
    v.pendingLod = null;

    // Swap in the new LOD only once it's ready, so there are never holes.
    this.clearGroup(v.group);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(r.mesh.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(r.mesh.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(r.mesh.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(r.mesh.indices, 1));
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(0, r.mesh.minY, 0), new THREE.Vector3(this.size, r.mesh.maxY, this.size));
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    const terrain = new THREE.Mesh(geo, this.material);
    terrain.receiveShadow = job.lod !== 'far';
    terrain.castShadow = job.lod === 'near';
    terrain.name = 'terrain';
    v.group.add(terrain);
    if (r.grass) {
      const grass = createGrassMesh(r.grass);
      if (grass) v.group.add(grass);
    }
    if (v.data) for (const m of buildPropMeshes(v.data.json.props, job.lod, this.q.propDensity)) v.group.add(m);

    const wasNear = v.lod === 'near';
    v.lod = job.lod;
    if (job.lod === 'near' && !wasNear && v.data) {
      this.nearKeys.add(v.key);
      this.hooks.onNear?.(v.cx, v.cz, v.data);
    } else if (wasNear && job.lod !== 'near') {
      this.nearKeys.delete(v.key);
      this.hooks.onLeaveNear?.(v.cx, v.cz);
    }
  }

  private clearGroup(g: THREE.Group): void {
    for (const c of [...g.children]) {
      g.remove(c);
      if ((c as THREE.Mesh).isMesh && c.name === 'terrain') (c as THREE.Mesh).geometry.dispose();
      if ((c as THREE.InstancedMesh).isInstancedMesh) (c as THREE.InstancedMesh).dispose();
    }
  }

  private disposeVisual(v: VisualChunk): void {
    this.clearGroup(v.group);
    this.group.remove(v.group);
    if (this.nearKeys.delete(v.key)) this.hooks.onLeaveNear?.(v.cx, v.cz);
  }

  /** Snapshot for the debug minimap. */
  forEachState(cb: (cx: number, cz: number, state: 'near' | 'mid' | 'far' | 'building' | 'cached' | 'fetching') => void): void {
    for (const v of this.visuals.values()) {
      if (v.pendingLod) cb(v.cx, v.cz, 'building');
      else if (v.lod) cb(v.cx, v.cz, v.lod);
    }
  }

  stateOf(cx: number, cz: number): 'near' | 'mid' | 'far' | 'building' | 'cached' | 'fetching' | 'none' {
    const key = chunkKey(cx, cz);
    const v = this.visuals.get(key);
    if (v?.pendingLod) return 'building';
    if (v?.lod) return v.lod;
    if (this.store.isLoading(key)) return 'fetching';
    if (this.store.peek(key)) return 'cached';
    return 'none';
  }

  get velocityVec(): THREE.Vector3 {
    return this.velocity;
  }
}
