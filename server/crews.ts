// Crews, shared by every shard in this process (members may be in different
// shards). Loads from the store at startup, writes changed crews back in
// batches, and pushes each change to the crew's online members.
import { CREW, Crews, type Crew } from '../shared/crews';
import { directory, sendTo } from './online';
import type { Store } from './db/store';

export const crews = new Crews();
const dirty = new Map<string, Crew>();
const deleted = new Set<string>();
/** crews whose members should see a fresh view soon (XP ticks up on every kill) */
const lazy = new Set<Crew>();
let store: Store | null = null;

export async function initCrews(s: Store): Promise<void> {
  store = s;
  crews.load(await s.loadCrews());
  setInterval(() => void flushCrews(), 5000).unref();
  setInterval(() => {
    for (const c of lazy) if (crews.byId.has(c.id)) pushCrew(c);
    lazy.clear();
  }, 3000).unref();
  console.log(`[crews] ${crews.byId.size} crews loaded`);
}

/** A crew changed: save it soon and show its online members. */
export function crewChanged(c: Crew): void {
  if (!crews.byId.has(c.id)) return;
  dirty.set(c.id, c);
  pushCrew(c);
}

const disbandListeners = new Set<(c: Crew) => void>();
/** Something else goes when a crew does (its base, its territory income). */
export function onDisband(fn: (c: Crew) => void): void {
  disbandListeners.add(fn);
}

/** A character leaves their crew (or is removed, or deleted). Returns the crew, if they had one. */
export function leaveCrew(charId: string): { crew: Crew; disbanded: boolean } | null {
  const r = crews.remove(charId);
  if (!r) return null;
  sendTo(charId, 'crew', null);
  if (r.disbanded) {
    dirty.delete(r.crew.id);
    deleted.add(r.crew.id);
    for (const fn of disbandListeners) fn(r.crew);
  } else crewChanged(r.crew);
  return r;
}

/** A member gained XP: the crew gets its share. */
export function crewXp(c: Crew, memberXp: number): void {
  const up = crews.addXp(c, memberXp * CREW.xpShare);
  dirty.set(c.id, c);
  if (up) {
    pushCrew(c);
    for (const m of c.members) sendTo(m.charId, 'announce', `[${c.tag}] ${c.name} reached crew level ${up}!`);
  } else lazy.add(c);
}

/** Send the crew panel's view to every online member. */
export function pushCrew(c: Crew): void {
  const view = crews.view(c, (id) => directory.has(id));
  for (const m of c.members) sendTo(m.charId, 'crew', view);
}

export async function flushCrews(): Promise<void> {
  if (!store) return;
  const save = [...dirty.values()];
  const del = [...deleted];
  dirty.clear();
  deleted.clear();
  try {
    await store.deleteCrews(del);
    await store.saveCrews(save);
  } catch (e) {
    console.error('[crews] save failed', e);
    for (const c of save) dirty.set(c.id, c);
    for (const id of del) deleted.add(id);
  }
}
