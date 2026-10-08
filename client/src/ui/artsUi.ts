import * as THREE from 'three/webgpu';
import { artsFor, artById, questStatus, questTarget, type ArtDef } from '@shared/arts';
import type { CombatHost } from '../game/combat/host';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Special Arts panel (J): every art your element can learn, its quest progress,
 * where to go next, and the Art slot (T) equip buttons. Also owns the quest
 * compass under the zone name.
 */
export class ArtsPanel {
  private el = document.createElement('div');
  private compass = document.createElement('div');
  private key = '';
  isOpen = false;
  /** Art whose next quest point the compass points at. */
  tracked: string | null = null;

  constructor(private host: () => CombatHost, private onOpenChange: (open: boolean) => void, private artKey: () => string) {
    this.el.className = 'mastery arts hidden';
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('mousedown', (e) => e.stopPropagation());
    this.compass.className = 'quest-compass hidden';
    document.body.append(this.el, this.compass);
  }

  toggle(open = !this.isOpen): void {
    this.isOpen = open;
    this.el.classList.toggle('hidden', !open);
    this.key = '';
    if (open && document.pointerLockElement) document.exitPointerLock();
    this.onOpenChange(open);
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-equip],[data-track],[data-close]');
    if (!t) {
      if (e.target === this.el) this.toggle(false);
      return;
    }
    if (t.dataset.close !== undefined) return this.toggle(false);
    if (t.dataset.track !== undefined) {
      this.tracked = this.tracked === t.dataset.track ? null : t.dataset.track!;
      this.key = '';
      return;
    }
    const id = t.dataset.equip!;
    const h = this.host();
    h.equipArt(h.progress.arts.equipped === id ? null : id);
  }

  private art(a: ArtDef): string {
    const h = this.host();
    const p = h.progress;
    const learned = p.arts.learned.includes(a.id) || (a.passive && p.level >= a.level);
    const equipped = p.arts.equipped === a.id;
    const target = questTarget(a, p.arts);
    const state = learned ? 'maxed' : p.arts.quests[a.id] ? 'open' : p.level >= a.level ? 'some' : 'idle';
    const btns = [
      learned && a.ability ? `<button class="${equipped ? '' : 'secondary'}" data-equip="${a.id}">${equipped ? `Equipped (${esc(this.artKey())})` : 'Equip'}</button>` : '',
      !learned && target ? `<button class="${this.tracked === a.id ? '' : 'secondary'}" data-track="${a.id}">${this.tracked === a.id ? 'Tracking' : 'Track'}</button>` : '',
    ].join('');
    const hint = !learned && a.master ? `<small class="a-hint">${esc(a.master.hint)}</small>` : '';
    return `<div class="a-art m-node ${state}" data-art="${a.id}">
      <div class="a-top"><b>${esc(a.name)}</b><span class="m-rank">Lv ${a.level}${a.element === 'any' ? ' · any element' : ''}</span></div>
      <small>${esc(a.text)}</small><small class="a-lim">${esc(a.limits)}</small>
      <div class="a-status">${esc(questStatus(a, p.arts, p.level))}</div>${hint}
      <div class="a-btns">${btns}</div></div>`;
  }

  update(camera: THREE.Camera, x: number, z: number): void {
    const h = this.host();
    const p = h.progress;
    const arts = artsFor(h.me.element);
    // Track the first quest in progress if nothing is tracked.
    if (!this.tracked || !artById(this.tracked) || p.arts.learned.includes(this.tracked)) {
      this.tracked = arts.find((a) => p.arts.quests[a.id])?.id ?? null;
    }
    this.updateCompass(camera, x, z);
    if (!this.isOpen) return;
    const key = JSON.stringify([h.me.element, p.level, p.arts, this.tracked]);
    if (key === this.key) return;
    this.key = key;
    const bounty = p.arts.bounty ? '<span class="a-bounty">Bounty: your faction hunts forbidden benders</span>' : '';
    this.el.innerHTML = `<div class="m-panel">
      <div class="m-head"><div><b>Special Arts</b><span>Level ${p.level} · faction rank ${p.rank} · equipped: ${esc(artById(p.arts.equipped)?.name ?? 'none')} (${esc(this.artKey())}) ${bounty}</span></div>
        <div class="m-btns"><button class="secondary" data-close>Close</button></div></div>
      <div class="a-list">${arts.map((a) => this.art(a)).join('')}</div>
      <div class="m-foot">Masters teach these arts once you reach their level. Find them, talk to them (interact) and finish their quest. Equip a learned art to use it with ${esc(this.artKey())}.</div>
    </div>`;
  }

  private updateCompass(camera: THREE.Camera, x: number, z: number): void {
    const h = this.host();
    const art = artById(this.tracked);
    const t = art ? questTarget(art, h.progress.arts) : null;
    this.compass.classList.toggle('hidden', !t);
    if (!t || !art) return;
    const dx = t.x - x;
    const dz = t.z - z;
    const dist = Math.hypot(dx, dz);
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    // Angle of the target relative to where the camera looks (clockwise, screen-up = ahead).
    const rel = Math.atan2(dx, dz) - Math.atan2(fwd.x, fwd.z);
    const deg = (-rel * 180) / Math.PI;
    this.compass.innerHTML = `<span class="arrow" style="transform: rotate(${deg.toFixed(0)}deg)">▲</span><span><b>${esc(art.name)}</b> · ${esc(t.label)} · ${dist < 1000 ? `${dist.toFixed(0)} m` : `${(dist / 1000).toFixed(1)} km`}</span>`;
  }
}
