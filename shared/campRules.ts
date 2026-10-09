// Camp effects shared by the shard server and offline play: building XP
// milestones, the element shrine's XP bonus, steam vents and campfire respawns.
import { BUILD, pieceById, type Camps, type Structure } from './building';
import type { Progress } from './progression';
import type { CombatSim, SimEntity } from './sim/combatSim';
import { zoneAt } from './factions';

/** One-time XP for building milestones reached by placing `placed`. */
export function milestoneXp(p: Progress, camps: Camps, charId: string, placed: Structure): Array<{ amount: number; reason: string }> {
  const out: Array<{ amount: number; reason: string }> = [];
  const reach = (id: keyof typeof BUILD.milestones, reason: string) => {
    if (p.milestones.includes(id)) return;
    p.milestones.push(id);
    out.push({ amount: BUILD.milestones[id], reason });
  };
  if (placed.piece === 'campfire') reach('firstCamp', 'made your first camp');
  if (camps.ofOwner(charId).length >= 10) reach('pieces10', 'camp of 10 pieces');
  if (pieceById(placed.piece)?.tier === 'metal') reach('firstMetal', 'first metal wall');
  return out;
}

/** XP multiplier from an element shrine of your side within camp range. */
export function shrineBonus(camps: Camps, e: SimEntity): number {
  if (!e.side) return 1;
  const s = camps.effectNear(e.pos.x, e.pos.z, 'shrine', BUILD.campRadius, (x) => x.side === e.side);
  return s ? 1 + BUILD.shrineXpBonus : 1;
}

/** Steam vents puff every few seconds and blind enemies of their side standing on them. */
export function ventTick(camps: Camps, sim: CombatSim): void {
  const v = BUILD.vent;
  for (const s of camps.all.values()) {
    if (pieceById(s.piece)?.effect !== 'vent') continue;
    for (const e of sim.entities.values()) {
      if (e.dead || e.kind !== 'player' || !e.side || e.side === s.side) continue;
      if (Math.hypot(e.pos.x - s.x, e.pos.z - s.z) > v.radius || zoneAt(e.pos.x, e.pos.z).kind === 'safe') continue;
      sim.applyStatus(e.id, null, { type: 'blind', duration: v.blindSeconds });
    }
  }
}

/** Where to come back after dying: beside your campfire if you have one, else at your crew's hall. */
export function campRespawn(camps: Camps, charId: string, crew?: string | null): { x: number; z: number } | null {
  const f = camps.campfireOf(charId);
  if (f) return { x: f.x + 2, z: f.z + 2 };
  const h = crew ? camps.hallOf(crew) : undefined;
  return h ? { x: h.x + 5, z: h.z + 5 } : null;
}
