import { PET_RULES, petDef, fedNow, type TrustGame } from '@shared/pets';
import { speciesById } from '@shared/sim/wildlife';
import type { SimEntity } from '@shared/sim/combatSim';
import { materialName } from '@shared/building';
import type { CombatHost } from '../game/combat/host';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const TIER_COLOR: Record<string, string> = { common: '#cfd6e6', rare: '#7fb7ff', legendary: '#ffb35a' };

/**
 * Pets panel (O): your stable, who's out with you, hunger, feeding, and which
 * pets you can ride (H). Reuses the mastery panel's look.
 */
export class PetsPanel {
  private el = document.createElement('div');
  private key = '';
  isOpen = false;

  constructor(private host: () => CombatHost, private onOpenChange: (open: boolean) => void, private keys: () => { mount: string; pets: string; interact: string }) {
    this.el.className = 'mastery pets hidden';
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('mousedown', (e) => e.stopPropagation());
    document.body.append(this.el);
  }

  toggle(open = !this.isOpen): void {
    this.isOpen = open;
    this.el.classList.toggle('hidden', !open);
    this.key = '';
    if (open && document.pointerLockElement) document.exitPointerLock();
    this.onOpenChange(open);
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-out],[data-stable],[data-feed],[data-close]');
    if (!t) {
      if (e.target === this.el) this.toggle(false);
      return;
    }
    const h = this.host();
    if (t.dataset.close !== undefined) return this.toggle(false);
    if (t.dataset.out) h.setPet(t.dataset.out);
    if (t.dataset.stable !== undefined) h.setPet(null);
    if (t.dataset.feed) h.feedPet(t.dataset.feed);
    this.key = '';
  }

  update(): void {
    if (!this.isOpen) return;
    const h = this.host();
    const st = h.progress.pets;
    const now = Date.now();
    const k = this.keys();
    const key = JSON.stringify([st, h.progress.level, Math.floor(now / 20000), h.progress.inv.berries, h.progress.inv.meat]);
    if (key === this.key) return;
    this.key = key;
    const food = Object.keys(PET_RULES.food).map((f) => `${materialName(f)} ${h.progress.inv[f] ?? 0}`).join(' · ');
    const cards = st.owned.map((p) => {
      const d = petDef(p.kind)!;
      const fed = Math.round(fedNow(p, now));
      const out = st.active === p.uid;
      const hungry = fed < PET_RULES.hungry;
      const extras = [d.mount ? `Rideable (${esc(k.mount)})${d.mount.fly ? ', flies' : d.mount.swim ? ', swims' : ''}` : '', d.element ? `${d.element}` : ''].filter(Boolean).join(' · ');
      return `<div class="a-art m-node ${out ? 'maxed' : 'some'}">
        <div class="a-top"><b style="color:${TIER_COLOR[d.tier]}">${esc(p.name)}</b><span class="m-rank">${d.tier} · Lv ${h.progress.level}</span></div>
        <small>${esc(d.perk)}</small>${extras ? `<small class="a-lim">${esc(extras)}</small>` : ''}
        <div class="p-fed"><span style="width:${fed}%;background:${hungry ? '#e2503c' : '#6bbf5f'}"></span></div>
        <small>${hungry ? 'Hungry: weak hits, won\'t carry you' : `${fed}% fed`}</small>
        <div class="a-btns">${out ? '<button data-stable>Send to stable</button>' : `<button class="secondary" data-out="${esc(p.uid)}">Call out</button>`}<button class="secondary" data-feed="${esc(p.uid)}">Feed</button></div></div>`;
    });
    this.el.innerHTML = `<div class="m-panel">
      <div class="m-head"><div><b>Pets</b><span>${st.owned.length}/${PET_RULES.maxPets} in your stable · food: ${esc(food)}</span></div>
        <div class="m-btns"><button class="secondary" data-close>Close</button></div></div>
      ${cards.length ? `<div class="a-list">${cards.join('')}</div>` : '<p class="p-empty">No pets yet. Find a Fox-hound, Shellback Tortoise or Glider Lemur in the wild, walk up with berries or meat and press ' + esc(k.interact) + ' to win its trust.</p>'}
      <div class="m-foot">One pet is out at a time and fights what you fight. Pets level with you and get hungry over time. Rare pets come from Beastkeepers' quests; legendary ones from a Bond Trial after their world boss.</div>
    </div>`;
  }
}

/**
 * The trust game: a marker sweeps across a bar; press interact while it is in
 * the calm zone. Enough hits wins the animal over; too many misses scares it off.
 */
export class TrustGameUi {
  private el = document.createElement('div');
  game: TrustGame | null = null;
  private t = 0;
  private hits = 0;
  private misses = 0;
  private zoneAt = 0.5;
  private flash = 0;
  onDone: ((success: boolean) => void) | null = null;

  constructor() {
    this.el.className = 'trust hidden';
    document.body.append(this.el);
  }

  get active(): boolean {
    return !!this.game;
  }

  start(g: TrustGame): void {
    this.game = g;
    this.t = 0;
    this.hits = 0;
    this.misses = 0;
    this.zoneAt = 0.3 + Math.random() * 0.4;
    this.el.classList.remove('hidden');
  }

  private marker(): number {
    // Ping-pong 0..1.
    const x = (this.t * (this.game?.speed ?? 1)) % 2;
    return x < 1 ? x : 2 - x;
  }

  /** Call every frame with whether interact was pressed. */
  update(dt: number, press: boolean, keyLabel: string): void {
    const g = this.game;
    if (!g) return;
    this.t += dt;
    this.flash = Math.max(0, this.flash - dt);
    if (press) {
      const m = this.marker();
      if (Math.abs(m - this.zoneAt) <= g.zone / 2) {
        this.hits++;
        this.flash = 0.25;
        this.zoneAt = 0.15 + Math.random() * 0.7;
      } else this.misses++;
    }
    if (this.hits >= g.hits || this.misses >= g.misses) {
      const ok = this.hits >= g.hits;
      this.game = null;
      this.el.classList.add('hidden');
      this.onDone?.(ok);
      return;
    }
    const m = this.marker();
    this.el.innerHTML = `<b>Earn the trust of the ${esc(g.name)}</b>
      <div class="t-bar${this.flash > 0 ? ' ok' : ''}"><span class="t-zone" style="left:${((this.zoneAt - g.zone / 2) * 100).toFixed(1)}%;width:${(g.zone * 100).toFixed(1)}%"></span><span class="t-mark" style="left:${(m * 100).toFixed(1)}%"></span></div>
      <small>Press ${esc(keyLabel)} when the marker is in the green · ${'●'.repeat(this.hits)}${'○'.repeat(g.hits - this.hits)} · misses ${this.misses}/${g.misses}</small>`;
  }
}

/** Big banner for boss announcements and Bond Trials. */
export class Announcer {
  private el = document.createElement('div');
  private t = 0;
  constructor() {
    this.el.className = 'announce hidden';
    document.body.append(this.el);
  }
  show(text: string): void {
    this.el.textContent = text;
    this.el.classList.remove('hidden');
    this.t = 7;
  }
  update(dt: number): void {
    if (this.t <= 0) return;
    this.t -= dt;
    if (this.t <= 0) this.el.classList.add('hidden');
  }
}

/** Health bar of the nearest boss at the top of the screen. */
export class BossBar {
  private el = document.createElement('div');
  constructor() {
    this.el.className = 'boss-bar hidden';
    document.body.append(this.el);
  }
  update(entities: Iterable<SimEntity>, x: number, z: number): void {
    let best: SimEntity | null = null;
    let bd = 90;
    for (const e of entities) {
      if (e.kind !== 'creature' || e.dead || (e.role !== 'boss' && e.role !== 'miniboss' && e.role !== 'trial')) continue;
      const d = Math.hypot(e.pos.x - x, e.pos.z - z);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    this.el.classList.toggle('hidden', !best);
    if (!best) return;
    const f = Math.max(0, best.hp / best.maxHp);
    this.el.innerHTML = `<div class="b-name">${esc(best.name)} <small>${esc(best.title ?? '')} · Lv ${best.level}</small></div>
      <div class="b-track"><span style="width:${(f * 100).toFixed(1)}%"></span></div><small>${Math.ceil(best.hp).toLocaleString()} / ${best.maxHp.toLocaleString()}</small>`;
  }
}

/** Nearest tameable wild animal within reach (for the "G · Tame" prompt). */
export function nearestTameable(entities: Iterable<SimEntity>, x: number, z: number): SimEntity | null {
  let best: SimEntity | null = null;
  let bd = PET_RULES.tameRange;
  for (const e of entities) {
    if (e.kind !== 'creature' || e.dead || !speciesById(e.beast)?.tame) continue;
    const d = Math.hypot(e.pos.x - x, e.pos.z - z);
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  return best;
}
