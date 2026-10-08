import { chunkKey, decodeHeights, type ChunkJson, type WorldManifest } from '@shared/world';

export interface ChunkData {
  key: string;
  heights: Float32Array;
  json: ChunkJson;
  bytes: number;
}

export interface StoreStats {
  memoryEntries: number;
  fetched: number;
  swHits: number;
  networkFetches: number;
  bytes: number;
  inFlight: number;
  failed: number;
}

/**
 * Chunk data source: in-memory LRU -> fetch (which the Service Worker answers
 * from the Cache API when it has the same version) -> CDN/static server.
 */
export class ChunkStore {
  manifest!: WorldManifest;
  private lru = new Map<string, ChunkData>();
  private inflight = new Map<string, Promise<ChunkData | null>>();
  readonly stats: StoreStats = { memoryEntries: 0, fetched: 0, swHits: 0, networkFetches: 0, bytes: 0, inFlight: 0, failed: 0 };

  constructor(private base = '/world', private capacity = 900) {}

  async init(): Promise<void> {
    const res = await fetch(`${this.base}/manifest.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`world manifest missing (${res.status}); run "npm run world"`);
    this.manifest = await res.json();
  }

  has(cx: number, cz: number): boolean {
    return this.manifest.chunks[chunkKey(cx, cz)] !== undefined;
  }

  peek(key: string): ChunkData | undefined {
    return this.lru.get(key);
  }

  isLoading(key: string): boolean {
    return this.inflight.has(key);
  }

  get(cx: number, cz: number): Promise<ChunkData | null> {
    const key = chunkKey(cx, cz);
    const hit = this.lru.get(key);
    if (hit) {
      this.lru.delete(key);
      this.lru.set(key, hit);
      return Promise.resolve(hit);
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const hash = this.manifest.chunks[key];
    if (!hash) return Promise.resolve(null);
    const p = this.load(key, hash).finally(() => {
      this.inflight.delete(key);
      this.stats.inFlight = this.inflight.size;
    });
    this.inflight.set(key, p);
    this.stats.inFlight = this.inflight.size;
    return p;
  }

  private async load(key: string, hash: string): Promise<ChunkData | null> {
    try {
      const [binRes, jsonRes] = await Promise.all([
        fetch(`${this.base}/chunks/${key}.bin?v=${hash}`),
        fetch(`${this.base}/chunks/${key}.json?v=${hash}`),
      ]);
      if (!binRes.ok || !jsonRes.ok) throw new Error(`HTTP ${binRes.status}/${jsonRes.status}`);
      for (const r of [binRes, jsonRes]) {
        if (r.headers.get('x-fw-cache') === 'hit') this.stats.swHits++;
        else this.stats.networkFetches++;
      }
      const buf = await binRes.arrayBuffer();
      const json = (await jsonRes.json()) as ChunkJson;
      const data: ChunkData = { key, heights: decodeHeights(buf), json, bytes: buf.byteLength };
      this.stats.fetched++;
      this.stats.bytes += buf.byteLength;
      this.lru.set(key, data);
      while (this.lru.size > this.capacity) this.lru.delete(this.lru.keys().next().value!);
      this.stats.memoryEntries = this.lru.size;
      return data;
    } catch (err) {
      this.stats.failed++;
      console.warn(`chunk ${key} failed`, err);
      return null;
    }
  }
}
