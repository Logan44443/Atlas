import * as THREE from 'three/webgpu';
import { canBend, type AbilityDef, type ElementContext, type ElementId, type ElementKit, type Slot } from '@shared/combat';
import { CFG, KITS, center, canHarm, kitOf, type SimEntity } from '@shared/sim/combatSim';
import type { Controls } from '../../engine/settings';
import type { Player } from '../player';
import { gestureFor, type GestureStyle } from './combatView';

export { KITS };

export interface SlotState {
  def: AbilityDef;
  cooldown: number;
  ready: boolean;
  affordable: boolean;
}

/** Where cast requests go: the local sim offline, the shard server online. */
export type CastSink = (slot: Slot, dir: THREE.Vector3) => void;

/**
 * Turns the local player's input into cast requests. Aim comes from the camera
 * with soft target assist toward the enemy closest to the crosshair.
 * Cooldowns are predicted here; the authority (sim or server) has the final
 * say and a 'castFail' event resets the prediction.
 */
export class PlayerAbilities {
  element: ElementId;
  private cooldowns = new Map<Slot, number>();
  private gestureT = 0;
  private gestureDur = 0.3;
  private gestureStyle: GestureStyle = 'push';
  target: SimEntity | null = null;
  private targetLockT = 0;
  lastFail = '';
  private failT = 0;
  private aimDir = new THREE.Vector3(0, 0, 1);

  constructor(
    private me: () => SimEntity,
    private entities: () => Iterable<SimEntity>,
    private controls: Controls,
    private camera: THREE.PerspectiveCamera,
    private player: Player,
    private context: () => ElementContext,
    public sink: CastSink,
  ) {
    this.element = me().element ?? 'fire';
    this.setElement(this.element);
  }

  setElement(el: ElementId): void {
    this.element = el;
    const me = this.me();
    me.element = el;
    // Offline the sim keeps its own cooldowns on the same entity; online the server clears them.
    me.cooldowns.clear();
    this.cooldowns.clear();
  }

  /** Abilities with the player's mastery applied (same numbers the authority uses). */
  get kit(): ElementKit {
    return kitOf(this.me());
  }

  slots(): Partial<Record<Slot, SlotState>> {
    const out = {} as Partial<Record<Slot, SlotState>>;
    const me = this.me();
    for (const d of this.kit.abilities) {
      const cd = this.cooldowns.get(d.slot) ?? 0;
      out[d.slot] = { def: d, cooldown: cd, ready: cd <= 0, affordable: me.chi >= d.chiCost };
    }
    return out;
  }

  get feedback(): { gesture: number; style: GestureStyle } {
    return { gesture: this.gestureT > 0 ? 1 - this.gestureT / this.gestureDur : 0, style: this.gestureStyle };
  }

  get failMessage(): string {
    return this.failT > 0 ? this.lastFail : '';
  }

  /** Latest aim direction (cones follow it while channelled). */
  get aim(): THREE.Vector3 {
    return this.aimDir;
  }

  private enemies(): SimEntity[] {
    const me = this.me();
    const out: SimEntity[] = [];
    for (const e of this.entities()) if (!e.dead && canHarm(me, e)) out.push(e);
    return out;
  }

  /** Camera ray -> aim direction from the caster's chest, with target assist. */
  private computeAim(): { dir: THREE.Vector3; target: SimEntity | null } {
    const origin = center(this.me());
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const ta = CFG.targetAssist;
    let best: SimEntity | null = null;
    let bestDot = Math.cos(THREE.MathUtils.degToRad(ta.angleDegrees));
    const c = new THREE.Vector3();
    for (const e of this.enemies()) {
      const to = center(e, c).sub(this.camera.position);
      if (to.length() > ta.range + 8) continue;
      const dot = to.normalize().dot(camDir);
      // A locked target gets a wider cone.
      const bonus = e === this.target && this.targetLockT > 0 ? 0.06 : 0;
      if (dot + bonus > bestDot) {
        bestDot = dot + bonus;
        best = e;
      }
    }
    if (best) return { dir: center(best).sub(origin).normalize(), target: best };
    // No target: aim at whatever is 40 m down the crosshair.
    const p = this.camera.position.clone().addScaledVector(camDir, 40);
    return { dir: p.sub(origin).normalize(), target: null };
  }

  cycleTarget(): void {
    const me = this.me();
    const enemies = this.enemies().sort((a, b) => a.pos.distanceTo(me.pos) - b.pos.distanceTo(me.pos));
    if (!enemies.length) return;
    const i = this.target ? enemies.indexOf(this.target) : -1;
    this.target = enemies[(i + 1) % enemies.length];
    this.targetLockT = 6;
  }

  private fail(msg: string): false {
    this.lastFail = msg;
    this.failT = 1.2;
    return false;
  }

  /** The authority rejected a cast we predicted. */
  onCastFail(slot: Slot, reason: string): void {
    this.cooldowns.set(slot, 0);
    if (reason !== 'cooldown') this.fail(reason);
  }

  update(dt: number, blockingHeld: boolean): void {
    for (const [k, v] of this.cooldowns) this.cooldowns.set(k, Math.max(0, v - dt));
    this.gestureT = Math.max(0, this.gestureT - dt);
    this.failT = Math.max(0, this.failT - dt);
    this.targetLockT = Math.max(0, this.targetLockT - dt);
    if (this.target?.dead) this.target = null;
    if (this.controls.pressed('target')) this.cycleTarget();

    const a = this.computeAim();
    this.aimDir.copy(a.dir);
    // Keep an "assist" target for the HUD even when not locked.
    if (this.targetLockT <= 0) this.target = a.target;

    if (this.me().dead || blockingHeld) return;
    const order: Slot[] = ['art', 'ultimate', 'mobility', 'defense', 'control', 'heavy', 'basic'];
    for (const slot of order) {
      const want = slot === 'basic' ? this.controls.down('basic') : this.controls.pressed(slot);
      if (want && this.tryCast(slot)) break;
    }
  }

  tryCast(slot: Slot): boolean {
    const def = this.kit.abilities.find((a) => a.slot === slot);
    if (!def) return false;
    // Flight and Spirit Projection end early when cast again.
    const toggleOff = (def.kind === 'flight' && this.player.flying) || (def.kind === 'spirit' && this.player.frozen);
    if (toggleOff) {
      this.sink(slot, this.aimDir.clone());
      return true;
    }
    if ((this.cooldowns.get(slot) ?? 0) > 0) return false;
    const me = this.me();
    if (me.statuses.has('stagger')) return this.fail('Staggered');
    if (!canBend(CFG, this.kit, this.context())) return this.fail('Earth needs solid ground');
    if (me.chi < def.chiCost) return this.fail('Not enough chi');
    if (def.kind === 'dash' && me.statuses.has('root')) return this.fail('Rooted');

    this.cooldowns.set(slot, def.cooldown);
    let dir = this.aimDir.clone();
    if (def.kind === 'dash') {
      // Dash where you're moving; straight ahead if standing still.
      const move = new THREE.Vector3(this.player.velocity.x, 0, this.player.velocity.z);
      dir = move.lengthSq() > 1 ? move.normalize() : dir.setY(0).normalize();
    } else this.player.faceFor(Math.atan2(dir.x, dir.z), Math.max(0.35, def.duration ?? 0));
    const g = gestureFor(def);
    this.gestureT = this.gestureDur = g.duration;
    this.gestureStyle = g.style;
    this.sink(slot, dir);
    return true;
  }
}
