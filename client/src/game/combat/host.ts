import type * as THREE from 'three/webgpu';
import type { Slot } from '@shared/combat';
import { CombatSim, createEntity, type SimEntity, type SimEvent } from '@shared/sim/combatSim';
import { spawnDummies, updateDummy, type DummyBrain } from '@shared/sim/dummies';
import characterData from '@data/character.json';

/** Where combat rules run: in this tab (offline) or on the shard server (online). */
export interface CombatHost {
  readonly online: boolean;
  /** Everything that can be hit and that this client knows about. */
  readonly entities: Map<string, SimEntity>;
  readonly me: SimEntity;
  /** Authority clock (seconds). */
  readonly time: number;
  cast(slot: Slot, dir: THREE.Vector3): void;
  /** Called every frame after the local entity has been synced from the player controller. */
  update(dt: number, aim: THREE.Vector3): SimEvent[];
}

const CAP = characterData.capsule;
export const PLAYER_SHAPE = { radius: CAP.radius + 0.1, height: (CAP.halfHeight + CAP.radius) * 2 };

export function createPlayerEntity(id: string, name: string, element: SimEntity['element']): SimEntity {
  return createEntity({ id, name, kind: 'player', team: 'players', element, ...PLAYER_SHAPE });
}

/** Offline play: the shared sim and dummy AI run right here. */
export class LocalCombat implements CombatHost {
  readonly online = false;
  readonly sim: CombatSim;
  readonly me: SimEntity;
  readonly brains: DummyBrain[];
  private reviveT = -1;

  constructor(name: string, element: SimEntity['element'], spawn: { x: number; z: number }, private groundAt: (x: number, z: number) => number) {
    this.sim = new CombatSim(groundAt);
    this.me = createPlayerEntity('player', name, element);
    this.sim.add(this.me);
    this.brains = spawnDummies(this.sim, spawn, groundAt);
  }

  get entities() {
    return this.sim.entities;
  }
  get time() {
    return this.sim.time;
  }

  cast(slot: Slot, dir: THREE.Vector3): void {
    this.sim.cast(this.me, slot, dir);
  }

  update(dt: number, aim: THREE.Vector3): SimEvent[] {
    this.sim.updateAim(this.me, aim);
    this.sim.update(dt);
    for (const b of this.brains) updateDummy(b, dt, this.sim, this.groundAt);
    // No death penalty offline: get back up after a moment.
    if (this.me.dead && this.reviveT < 0) this.reviveT = 2;
    if (this.reviveT >= 0) {
      this.reviveT -= dt;
      if (this.reviveT < 0) this.sim.revive(this.me);
    }
    return this.sim.drain();
  }
}
