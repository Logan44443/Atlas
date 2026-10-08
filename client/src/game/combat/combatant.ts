import * as THREE from 'three/webgpu';
import combatData from '@data/combat.json';
import type { CombatConfig, ElementId, StatusType } from '@shared/combat';

export const CFG = combatData as unknown as CombatConfig;

export type Team = 'player' | 'enemy';

export interface ActiveStatus {
  type: StatusType;
  remaining: number;
  dps: number;
  amount: number;
  tickAcc: number;
  source: Combatant | null;
}

export interface ShieldState {
  remaining: number;
  reduction: number;
  blocksProjectiles: boolean;
  reflects: boolean;
  radius: number;
  element: ElementId;
  mesh: THREE.Mesh | null;
}

/** Anything that can be hit: the player, dummies, later NPCs and other players. */
export abstract class Combatant {
  hp: number;
  chi: number;
  lastCombat = -1e9;
  statuses = new Map<StatusType, ActiveStatus>();
  shield: ShieldState | null = null;
  blocking = false;
  blockStart = -1e9;
  dead = false;
  level = 1;

  constructor(
    readonly id: string,
    public name: string,
    public team: Team,
    public element: ElementId | null,
    public maxHp: number,
    public maxChi = CFG.chi.max,
  ) {
    this.hp = maxHp;
    this.chi = maxChi;
  }

  /** Centre of mass used for hit tests and aiming. */
  abstract get center(): THREE.Vector3;
  /** Feet position. */
  abstract get feet(): THREE.Vector3;
  abstract get radius(): number;
  abstract get height(): number;
  abstract knockback(impulse: THREE.Vector3): void;
  isInvulnerable(): boolean {
    return false;
  }
  get grounded(): boolean {
    return true;
  }

  inCombat(now: number): boolean {
    return now - this.lastCombat < CFG.chi.combatTimeout;
  }

  has(t: StatusType): boolean {
    return this.statuses.has(t);
  }

  /** Movement multiplier from slows (strongest wins). */
  get moveScale(): number {
    const s = this.statuses.get('slow');
    return s ? 1 - s.amount : 1;
  }

  /** Distance from point to this combatant's vertical capsule (<= 0 means inside). */
  distanceTo(p: THREE.Vector3): number {
    const f = this.feet;
    const y = THREE.MathUtils.clamp(p.y, f.y + this.radius, f.y + this.height - this.radius);
    return Math.hypot(p.x - f.x, p.y - y, p.z - f.z) - this.radius;
  }
}
