import * as THREE from 'three/webgpu';
import { SLOTS, type Slot } from '@shared/combat';
import { keyLabel, type Settings } from '../engine/settings';
import type { PlayerAbilities } from '../game/combat/abilities';
import { center, type SimEntity, type SimEvent } from '@shared/sim/combatSim';

const SLOT_ACTION: Record<Slot, string> = { basic: 'basic', heavy: 'heavy', control: 'control', defense: 'defense', mobility: 'mobility', ultimate: 'ultimate' };
const ELEMENT_ICON: Record<string, string> = { fire: '🔥', water: '💧', earth: '⛰️', air: '🌀' };

interface Floater {
  el: HTMLDivElement;
  pos: THREE.Vector3;
  t: number;
  life: number;
}

/** Health/chi bars, ability bar with cooldowns, target frame and floating combat text. */
export class Hud {
  private root: HTMLDivElement;
  private hp: HTMLDivElement;
  private hpText: HTMLSpanElement;
  private chi: HTMLDivElement;
  private chiText: HTMLSpanElement;
  private slots = new Map<Slot, { el: HTMLDivElement; cd: HTMLDivElement; cdText: HTMLSpanElement; key: HTMLSpanElement; name: HTMLSpanElement }>();
  private target: HTMLDivElement;
  private targetName: HTMLSpanElement;
  private targetHp: HTMLDivElement;
  private status: HTMLDivElement;
  private element: HTMLDivElement;
  private floaters: Floater[] = [];
  private v = new THREE.Vector3();

  constructor(private settings: Settings) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-target hidden"><span class="t-name"></span><div class="bar"><div class="fill hp"></div></div></div>
      <div class="hud-status"></div>
      <div class="hud-bottom">
        <div class="hud-bars">
          <div class="element-badge"></div>
          <div class="bars">
            <div class="bar big"><div class="fill hp"></div><span class="txt hp-t"></span></div>
            <div class="bar"><div class="fill chi"></div><span class="txt chi-t"></span></div>
          </div>
        </div>
        <div class="hud-slots"></div>
      </div>`;
    document.body.appendChild(this.root);
    const q = <T extends HTMLElement>(s: string) => this.root.querySelector(s) as T;
    this.hp = q('.hud-bars .fill.hp');
    this.hpText = q('.hp-t');
    this.chi = q('.fill.chi');
    this.chiText = q('.chi-t');
    this.target = q('.hud-target');
    this.targetName = q('.t-name');
    this.targetHp = q('.hud-target .fill');
    this.status = q('.hud-status');
    this.element = q('.element-badge');
    const slotsEl = q('.hud-slots');
    for (const s of SLOTS) {
      const el = document.createElement('div');
      el.className = `slot slot-${s}`;
      el.innerHTML = `<span class="key"></span><span class="name"></span><div class="cd"></div><span class="cd-t"></span>`;
      slotsEl.appendChild(el);
      this.slots.set(s, { el, cd: el.querySelector('.cd')!, cdText: el.querySelector('.cd-t')!, key: el.querySelector('.key')!, name: el.querySelector('.name')! });
    }
  }

  onEvent(e: SimEvent, entities: Map<string, SimEntity>, playerId: string): void {
    let text = '';
    let cls = '';
    let target: SimEntity | undefined;
    if (e.t === 'hit') {
      target = entities.get(e.target);
      if (e.result === 'perfect') {
        text = 'COUNTER!';
        cls = 'counter';
      } else if (e.result === 'dodged') {
        text = 'Dodged';
        cls = 'info';
      } else {
        text = (e.result === 'blocked' ? 'Blocked ' : '') + e.amount;
        cls = e.target === playerId ? 'dmg-in' : e.dot ? 'dmg-dot' : e.result === 'blocked' ? 'info' : 'dmg-out';
      }
    } else if (e.t === 'status' && (e.status === 'stagger' || e.status === 'root' || e.status === 'slow')) {
      target = entities.get(e.target);
      text = e.status === 'stagger' ? 'Staggered' : e.status === 'root' ? 'Rooted' : 'Slowed';
      cls = 'info';
    }
    if (!target) return;
    const pos = center(target).add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.9, 0));
    if (!text) return;
    const el = document.createElement('div');
    el.className = `floater ${cls}`;
    el.textContent = text;
    document.body.appendChild(el);
    this.floaters.push({ el, pos, t: 0, life: cls === 'counter' ? 1.3 : 0.9 });
  }

  update(dt: number, camera: THREE.PerspectiveCamera, me: SimEntity, abilities: PlayerAbilities, target: SimEntity | null): void {
    this.hp.style.width = `${(me.hp / me.maxHp) * 100}%`;
    this.hpText.textContent = `${Math.ceil(me.hp)} / ${me.maxHp}`;
    this.chi.style.width = `${(me.chi / me.maxChi) * 100}%`;
    this.chiText.textContent = `${Math.floor(me.chi)} chi`;
    this.element.textContent = ELEMENT_ICON[abilities.element];
    this.element.title = abilities.element;
    this.element.className = `element-badge el-${abilities.element}`;

    const slots = abilities.slots();
    for (const [s, ui] of this.slots) {
      const st = slots[s];
      const keys = this.settings.data.bindings[SLOT_ACTION[s]] ?? [];
      ui.key.textContent = keys[0] ? keyLabel(keys[0]).replace(' click', '') : '—';
      ui.name.textContent = st.def.name;
      const frac = st.def.cooldown > 0 ? st.cooldown / st.def.cooldown : 0;
      ui.cd.style.background = frac > 0 ? `conic-gradient(rgba(0,0,0,0.65) ${frac * 360}deg, transparent 0)` : 'none';
      ui.cdText.textContent = st.cooldown > 0.95 ? Math.ceil(st.cooldown).toString() : '';
      ui.el.classList.toggle('nochi', !st.affordable);
      ui.el.title = `${st.def.name}: ${st.def.damage} dmg, ${st.def.chiCost} chi, ${st.def.cooldown}s cooldown`;
    }

    if (target && !target.dead) {
      this.target.classList.remove('hidden');
      this.targetName.textContent = `${target.name}${target.statuses.has('burn') ? ' 🔥' : ''}${target.statuses.has('root') ? ' ❄' : ''}${target.statuses.has('stagger') ? ' ✶' : ''}`;
      this.targetHp.style.width = `${(target.hp / target.maxHp) * 100}%`;
    } else this.target.classList.add('hidden');

    const st: string[] = [];
    if (me.blocking) st.push('Blocking');
    if (me.shield) st.push('Shielded');
    for (const s of me.statuses.keys()) st.push(s[0].toUpperCase() + s.slice(1));
    const fail = abilities.failMessage;
    this.status.textContent = fail || st.join(' · ');
    this.status.classList.toggle('warn', !!fail);

    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.t += dt;
      f.pos.y += dt * 1.2;
      this.v.copy(f.pos).project(camera);
      const visible = this.v.z < 1 && f.t < f.life;
      if (!visible) {
        f.el.remove();
        this.floaters.splice(i, 1);
        continue;
      }
      f.el.style.transform = `translate(${((this.v.x + 1) / 2) * innerWidth}px, ${((1 - this.v.y) / 2) * innerHeight}px) translate(-50%, -50%) scale(${1 + Math.max(0, 0.3 - f.t)})`;
      f.el.style.opacity = String(1 - Math.max(0, (f.t - f.life * 0.6) / (f.life * 0.4)));
    }
  }
}
