// Training dummy AI, shared so the server (and offline client) run the same logic.
import { Vector3 } from 'three';
import combatData from '../../data/combat.json';
import type { AbilityDef } from '../combat';
import { CombatSim, createEntity, center, type SimEntity } from './combatSim';

export interface DummyDef {
  id: string;
  name: string;
  hp: number;
  offset: number[];
  attacks: boolean;
  attackEvery?: number;
  attackDamage?: number;
  attackSpeed?: number;
}

export interface DummyBrain {
  entity: SimEntity;
  def: DummyDef;
  home: Vector3;
  vel: Vector3;
  attackT: number;
  respawnT: number;
  /** 0..1 wind-up glow, replicated so clients can see the telegraph. */
  windup: number;
  yaw: number;
}

export const DUMMIES = combatData.dummies as DummyDef[];

export function spawnDummies(sim: CombatSim, origin: { x: number; z: number }, groundAt: (x: number, z: number) => number, prefix = ''): DummyBrain[] {
  return DUMMIES.map((def) => {
    const home = new Vector3(origin.x + def.offset[0], 0, origin.z + def.offset[1]);
    home.y = groundAt(home.x, home.z);
    const entity = createEntity({ id: prefix + def.id, name: def.name, kind: 'dummy', team: 'dummies', hp: def.hp, maxHp: def.hp, radius: 0.4, height: 2.2, pos: home.clone() });
    sim.add(entity);
    return { entity, def, home, vel: new Vector3(), attackT: def.attackEvery ?? 3, respawnT: 0, windup: 0, yaw: 0 };
  });
}

export function updateDummy(b: DummyBrain, dt: number, sim: CombatSim, groundAt: (x: number, z: number) => number): void {
  const e = b.entity;
  if (e.dead) {
    b.respawnT += dt;
    e.windup = b.windup = 0;
    if (b.respawnT >= combatData.dummyRespawnSeconds) {
      b.respawnT = 0;
      e.pos.copy(b.home);
      b.vel.set(0, 0, 0);
      sim.revive(e);
    }
    return;
  }
  // Knockback/pull then drift back to the post's home spot.
  b.vel.addScaledVector(e.pendingImpulse.setY(0), 0.6);
  e.pendingImpulse.set(0, 0, 0);
  if (!e.statuses.has('root')) e.pos.addScaledVector(b.vel, dt);
  b.vel.multiplyScalar(Math.exp(-dt * 4));
  e.pos.lerp(b.home, 1 - Math.exp(-dt * 0.8));
  e.pos.y = groundAt(e.pos.x, e.pos.z);

  if (!b.def.attacks || e.statuses.has('stagger') || e.statuses.has('root')) {
    e.windup = b.windup = 0;
    return;
  }
  // Nearest living enemy (player) in range.
  let target: SimEntity | null = null;
  let best = 30;
  for (const o of sim.enemiesOf(e)) {
    const d = o.pos.distanceTo(e.pos);
    if (d < best && o.kind === 'player') {
      best = d;
      target = o;
    }
  }
  if (!target) {
    e.windup = b.windup = 0;
    return;
  }
  e.yaw = b.yaw = Math.atan2(target.pos.x - e.pos.x, target.pos.z - e.pos.z);
  b.attackT -= dt;
  const windup = 0.7;
  e.windup = b.windup = b.attackT < windup ? 1 - b.attackT / windup : 0;
  if (b.attackT <= 0) {
    b.attackT = b.def.attackEvery ?? 3;
    const from = center(e).add(new Vector3(0, 0.2, 0));
    const dir = center(target).sub(from).normalize();
    const bolt: AbilityDef = { slot: 'basic', id: 'dummy_bolt', name: 'Dummy Bolt', kind: 'projectile', damage: b.def.attackDamage ?? 10, chiCost: 0, cooldown: 0, range: 34, speed: b.def.attackSpeed ?? 18, radius: 0.35, vfx: 'fire_bolt', anim: '' };
    sim.spawnProjectile(e, bolt, 'fire', from, dir, 1);
  }
}
