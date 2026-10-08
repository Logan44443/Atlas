import * as THREE from 'three/webgpu';
import fireKit from '@data/abilities/fire.json';
import waterKit from '@data/abilities/water.json';
import earthKit from '@data/abilities/earth.json';
import airKit from '@data/abilities/air.json';
import { elementPower, canBend, levelPower, type AbilityDef, type ElementId, type ElementKit, type Slot, type ElementContext } from '@shared/combat';
import type { Controls } from '../../engine/settings';
import { CFG, type Combatant } from './combatant';
import type { CombatSystem } from './combatSystem';
import type { PlayerCombatant } from './actors';
import { paletteFor } from './combatSystem';
import type { Vfx } from './vfx';

export const KITS: Record<ElementId, ElementKit> = {
  fire: fireKit as ElementKit,
  water: waterKit as ElementKit,
  earth: earthKit as ElementKit,
  air: airKit as ElementKit,
};

export interface SlotState {
  def: AbilityDef;
  cooldown: number;
  ready: boolean;
  affordable: boolean;
}

export interface CastFeedback {
  /** 0..1 cast gesture progress for the avatar */
  gesture: number;
  style: 'push' | 'stomp' | 'spin' | 'breath';
}

const STYLE: Record<string, CastFeedback['style']> = { stomp: 'stomp', spin: 'spin', breath: 'breath', surge: 'breath' };

/**
 * Turns the local player's input into casts. Aim comes from the camera with
 * soft target assist toward the enemy closest to the crosshair.
 */
export class PlayerAbilities {
  element: ElementId;
  kit!: ElementKit;
  private cooldowns = new Map<Slot, number>();
  private combo = 0;
  private comboT = 0;
  private gestureT = 0;
  private gestureDur = 0.3;
  private gestureStyle: CastFeedback['style'] = 'push';
  private pending: Array<{ t: number; fn: () => void }> = [];
  target: Combatant | null = null;
  private targetLockT = 0;
  lastFail = '';
  private failT = 0;
  power = 1;

  constructor(
    private me: PlayerCombatant,
    private combat: CombatSystem,
    private controls: Controls,
    private camera: THREE.PerspectiveCamera,
    private vfx: Vfx,
    private context: () => ElementContext,
  ) {
    this.element = me.element ?? 'fire';
    this.setElement(this.element);
  }

  setElement(el: ElementId): void {
    this.element = el;
    this.me.element = el;
    this.kit = KITS[el];
    this.cooldowns.clear();
    this.combo = 0;
  }

  slots(): Record<Slot, SlotState> {
    const out = {} as Record<Slot, SlotState>;
    for (const d of this.kit.abilities) {
      const cd = this.cooldowns.get(d.slot) ?? 0;
      out[d.slot] = { def: d, cooldown: cd, ready: cd <= 0, affordable: this.me.chi >= d.chiCost };
    }
    return out;
  }

  get feedback(): CastFeedback {
    return { gesture: this.gestureT > 0 ? 1 - this.gestureT / this.gestureDur : 0, style: this.gestureStyle };
  }

  get failMessage(): string {
    return this.failT > 0 ? this.lastFail : '';
  }

  /** Camera ray -> aim direction from the caster's hand, with target assist. */
  private aim(origin: THREE.Vector3): { dir: THREE.Vector3; target: Combatant | null } {
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const ta = CFG.targetAssist;
    const cosA = Math.cos(THREE.MathUtils.degToRad(ta.angleDegrees));
    let best: Combatant | null = null;
    let bestDot = cosA;
    const candidates = this.target && !this.target.dead ? [this.target, ...this.combat.enemiesOf(this.me)] : this.combat.enemiesOf(this.me);
    for (const e of candidates) {
      const to = e.center.clone().sub(this.camera.position);
      const d = to.length();
      if (d > ta.range + 8) continue;
      const dot = to.normalize().dot(camDir);
      // A locked target gets a wider cone.
      const bonus = e === this.target && this.targetLockT > 0 ? 0.06 : 0;
      if (dot + bonus > bestDot) {
        bestDot = dot + bonus;
        best = e;
      }
    }
    if (best) return { dir: best.center.clone().sub(origin).normalize(), target: best };
    // No target: aim at whatever is 40 m down the crosshair.
    const p = this.camera.position.clone().addScaledVector(camDir, 40);
    return { dir: p.sub(origin).normalize(), target: null };
  }

  cycleTarget(): void {
    const enemies = this.combat.enemiesOf(this.me).sort((a, b) => a.center.distanceTo(this.me.center) - b.center.distanceTo(this.me.center));
    if (!enemies.length) return;
    const i = this.target ? enemies.indexOf(this.target) : -1;
    this.target = enemies[(i + 1) % enemies.length];
    this.targetLockT = 6;
  }

  private fail(msg: string): void {
    this.lastFail = msg;
    this.failT = 1.2;
  }

  update(dt: number, blockingHeld: boolean): void {
    for (const [k, v] of this.cooldowns) this.cooldowns.set(k, Math.max(0, v - dt));
    this.gestureT = Math.max(0, this.gestureT - dt);
    this.failT = Math.max(0, this.failT - dt);
    this.targetLockT = Math.max(0, this.targetLockT - dt);
    this.comboT -= dt;
    if (this.comboT <= 0) this.combo = 0;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      this.pending[i].t -= dt;
      if (this.pending[i].t <= 0) {
        const p = this.pending.splice(i, 1)[0];
        p.fn();
      }
    }
    if (this.target?.dead) this.target = null;
    if (this.controls.pressed('target')) this.cycleTarget();

    // Keep an "assist" target for the HUD even when not locked.
    if (this.targetLockT <= 0) this.target = this.aim(this.me.center).target;

    if (this.me.dead || blockingHeld) return;
    const order: Slot[] = ['ultimate', 'mobility', 'defense', 'control', 'heavy', 'basic'];
    for (const slot of order) {
      const want = slot === 'basic' ? this.controls.down('basic') : this.controls.pressed(slot);
      if (want && this.tryCast(slot)) break;
    }
  }

  tryCast(slot: Slot): boolean {
    const def = this.kit.abilities.find((a) => a.slot === slot);
    if (!def) return false;
    if ((this.cooldowns.get(slot) ?? 0) > 0) return false;
    if (this.me.has('stagger')) return this.fail('Staggered'), false;
    const ctx = this.context();
    if (!canBend(CFG, this.kit, ctx)) return this.fail('Earth needs solid ground'), false;
    if (this.me.chi < def.chiCost) return this.fail('Not enough chi'), false;
    if (def.kind === 'dash' && this.me.has('root')) return this.fail('Rooted'), false;

    this.me.chi -= def.chiCost;
    this.cooldowns.set(slot, def.cooldown);
    this.power = elementPower(CFG, this.element, ctx) * levelPower(this.me.level);
    this.cast(def);
    return true;
  }

  private hand(): THREE.Vector3 {
    const p = this.me.player;
    const yaw = p.facing;
    return this.me.center.clone().add(new THREE.Vector3(Math.cos(yaw) * -0.3 + Math.sin(yaw) * 0.5, 0.35, -Math.sin(yaw) * -0.3 + Math.cos(yaw) * 0.5));
  }

  private gesture(def: AbilityDef, dur = 0.3): void {
    this.gestureT = this.gestureDur = dur;
    this.gestureStyle = STYLE[def.anim] ?? 'push';
  }

  private cast(def: AbilityDef): void {
    const player = this.me.player;
    const el = this.element;
    const power = this.power;
    const { dir } = this.aim(this.me.center);
    player.faceFor(Math.atan2(dir.x, dir.z), Math.max(0.35, def.duration ?? 0));
    this.gesture(def, def.kind === 'cone' ? def.duration ?? 0.3 : def.kind === 'ring' ? 0.5 : 0.3);
    this.me.lastCombat = this.combat.time;

    switch (def.kind) {
      case 'projectile': {
        let mul = 1;
        if (def.combo) {
          this.combo = (this.combo % def.combo) + 1;
          this.comboT = 1.0;
          if (this.combo === def.combo) mul = 1 + (def.comboBonus ?? 0);
        }
        const release = () => {
          const origin = this.hand();
          const a = this.aim(origin);
          const n = def.count ?? 1;
          for (let i = 0; i < n; i++) {
            const d = a.dir.clone();
            if (n > 1) d.applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad((i - (n - 1) / 2) * (def.spread ?? 6)));
            if (def.gravity) d.y += (def.gravity * (def.range ?? 20)) / (2 * (def.speed ?? 30) ** 2);
            this.combat.spawnProjectile(this.me, def, el, origin, d, power * mul);
          }
          this.vfx.burst(paletteFor(el), origin, 8, 3, 0.4, 0.25);
        };
        if (def.windup) {
          this.pending.push({ t: def.windup, fn: release });
          this.vfx.burst(paletteFor(el), this.hand(), 20, 1.5, 0.5, def.windup);
        } else release();
        break;
      }
      case 'melee': {
        let mul = 1;
        if (def.combo) {
          this.combo = (this.combo % def.combo) + 1;
          this.comboT = 1.0;
          if (this.combo === def.combo) mul = 1 + (def.comboBonus ?? 0);
        }
        this.combat.melee(this.me, def, el, dir, power, mul);
        break;
      }
      case 'dash': {
        const move = new THREE.Vector3(player.velocity.x, 0, player.velocity.z);
        const d = move.lengthSq() > 1 ? move.normalize() : dir.clone().setY(0).normalize();
        player.dash(d, def.distance ?? 8, def.duration ?? 0.3, def.lift ?? 0);
        const pal = paletteFor(el);
        const dur = def.duration ?? 0.3;
        // Trail for the dash duration.
        let t = 0;
        const step = () => {
          t += 1 / 60;
          this.vfx.trail(pal, this.me.feet.clone().setY(this.me.feet.y + 0.4), d, 0.8, 1 / 60, 400);
          if (t < dur) this.pending.push({ t: 1 / 60, fn: step });
        };
        step();
        if (def.lift) this.vfx.ring(pal, this.me.feet, 1.2, 40, 6, 0.9);
        break;
      }
      case 'shield':
        this.combat.shield(this.me, def, el);
        break;
      case 'ring':
        this.combat.spawnArea(this.me, def, el, this.me.feet, power, false);
        break;
      case 'cone': {
        this.combat.spawnArea(
          this.me,
          def,
          el,
          this.me.feet,
          power,
          true,
          () => this.aim(this.me.center).dir,
          () => this.hand(),
        );
        if (def.selfHeal) {
          this.me.hp = Math.min(this.me.maxHp, this.me.hp + def.selfHeal);
        }
        break;
      }
    }
  }
}
