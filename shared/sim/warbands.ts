// War bands (Phase 11, DESIGN section 9): while a territory war is open, every
// shrine and outpost gets a few fighters from each side. They attack enemy
// players and the other side's war band, and go home when the war ends.
// Shared so the shard server and offline play raise the same bands.
import { Vector3 } from 'three';
import { mulberry32 } from '../noise';
import { FACTIONS, NPC_CFG, sideOf } from '../factions';
import { TERR, POINTS } from '../territory';
import { CombatSim, createEntity } from './combatSim';
import { updateNpc, type NpcBrain } from './npcs';
import type { ElementId } from '../combat';

const ELEMENTS: ElementId[] = ['fire', 'water', 'earth', 'air'];
const SIDES = ['order', 'outlaw'] as const;

export class WarBands {
  brains: NpcBrain[] = [];

  constructor(private sim: CombatSim, private groundAt: (x: number, z: number) => number) {}

  get up(): boolean {
    return this.brains.length > 0;
  }

  /** Raise the bands (each side flies the colours of the point's holder when it is theirs). */
  raise(ownerOf: (pointId: string) => string): void {
    if (this.up) return;
    const cfg = TERR.warband;
    for (const pt of POINTS) {
      const rand = mulberry32([...pt.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0);
      SIDES.forEach((side, si) => {
        const owner = ownerOf(pt.id);
        const mine = FACTIONS.filter((f) => f.side === side);
        const f = sideOf(owner) === side ? FACTIONS.find((x) => x.id === owner)! : mine[Math.floor(rand() * mine.length)];
        const names = [...NPC_CFG.names[side]];
        for (let i = 0; i < cfg.perSide; i++) {
          // Each side musters on its own half of the point.
          const a = (si ? Math.PI : 0) + (i - (cfg.perSide - 1) / 2) * 0.7;
          const home = new Vector3(pt.x + Math.cos(a) * cfg.patrolRadius, 0, pt.z + Math.sin(a) * cfg.patrolRadius);
          home.y = this.groundAt(home.x, home.z);
          const e = createEntity({
            id: `war_${pt.id}_${side}_${i}`, name: names.splice(Math.floor(rand() * names.length), 1)[0] ?? 'Soldier', kind: 'npc', team: side,
            faction: f.id, side, role: 'fighter', title: `${f.emblem} War band`, element: ELEMENTS[Math.floor(rand() * 4)], level: cfg.level,
            hp: cfg.health, maxHp: cfg.health, pos: home.clone(), radius: 0.45, height: 1.8,
          });
          this.sim.add(e);
          this.brains.push({
            entity: e, role: 'fighter', home, patrolRadius: cfg.patrolRadius, waypoint: home.clone(), target: null,
            thinkT: rand() * NPC_CFG.thinkEvery, respawnT: 0, vel: new Vector3(), grudges: new Map(), brawl: true,
          });
        }
      });
    }
  }

  /** The war is over: everyone goes home. */
  disband(): void {
    for (const b of this.brains) this.sim.remove(b.entity.id);
    this.brains = [];
  }

  update(dt: number): void {
    for (const b of this.brains) updateNpc(b, dt, this.sim, this.groundAt);
  }
}
