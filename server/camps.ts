// The world's camps, shared by every shard in this process (they all show the
// same world). Loads from the store at startup, writes changes back in
// batches, and burns down camps whose owners stayed away too long.
import worldData from '../data/world.json';
import { TerrainSampler } from '../shared/terrain';
import { terrainConfig } from '../shared/factions';
import { Camps, type Structure } from '../shared/building';
import type { Store } from './db/store';

const sampler = new TerrainSampler(terrainConfig());
export const camps = new Camps((x, z) => sampler.height(x, z));

const dirty = new Map<string, Structure>();
const deleted = new Set<string>();
let store: Store | null = null;

/** Characters in any shard right now (set by WorldRoom). */
export const onlineChars = new Set<string>();

export async function initCamps(s: Store): Promise<void> {
  store = s;
  camps.load(await s.loadStructures());
  camps.listen((st, change) => {
    if (change === 'del') {
      dirty.delete(st.id);
      deleted.add(st.id);
    } else {
      dirty.set(st.id, st);
      deleted.delete(st.id);
    }
  });
  setInterval(() => void flushCamps(), 5000).unref();
  // Abandoned camps burn down (checked every minute).
  setInterval(() => {
    const now = Date.now();
    for (const id of onlineChars) camps.touch(id, now);
    const burnt = camps.burnAbandoned((id) => onlineChars.has(id), now);
    if (burnt.length) console.log(`[camps] ${burnt.length} pieces of abandoned camps burned down`);
  }, 60_000).unref();
  console.log(`[camps] ${camps.all.size} structures loaded (chunk size ${worldData.chunkSize} m)`);
}

export async function flushCamps(): Promise<void> {
  if (!store) return;
  const save = [...dirty.values()];
  const del = [...deleted];
  dirty.clear();
  deleted.clear();
  try {
    await store.saveStructures(save);
    await store.deleteStructures(del);
  } catch (e) {
    console.error('[camps] save failed', e);
    for (const s of save) dirty.set(s.id, s);
    for (const id of del) deleted.add(id);
  }
}

/** A character was deleted: their camp goes with them. */
export function removeOwner(charId: string): void {
  for (const s of camps.ofOwner(charId)) camps.delete(s.id);
}
