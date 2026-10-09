import './shop.css';
import type { SimEntity } from '@shared/sim/combatSim';
import { SHOP, sellPrice, shopItems, travelSpots, type TravelSpot } from '@shared/factionRules';
import { infamyNow } from '@shared/standing';
import { BAG_CAP, MATERIALS, invTotal, materialName } from '@shared/building';
import { SIDES, factionById, zoneAt, type Side } from '@shared/factions';
import type { CombatHost } from '../game/combat/host';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const icon = (id: string) => MATERIALS.find((m) => m.id === id)?.icon ?? '•';
const dist = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const dis = (ok: boolean) => (ok ? '' : ' disabled');

type Tab = 'buy' | 'sell' | 'travel';
const TABS: Array<[Tab, string]> = [
  ['buy', 'Buy'],
  ['sell', 'Sell'],
  ['travel', 'Travel'],
];

/**
 * Quartermaster panel (talk to a hub vendor of your side): buy materials (and
 * the black market for factions that have it), sell your bag, pay off a bounty,
 * and fast travel to your side's hubs, your camp or your crew hall. The
 * authority decides; results come back as notices and an updated progress.
 */
export class ShopPanel {
  private el = document.createElement('div');
  private key = '';
  private tab: Tab = 'buy';
  private npcId: string | null = null;
  isOpen = false;
  /** where we last saw our campfire (online the structure mirror only reaches a few hundred metres) */
  private campSeen: { charId: string; x: number; z: number } | null = null;
  private scanAt = 0;

  constructor(private host: () => CombatHost, private onOpenChange: (open: boolean) => void) {
    this.el.className = 'mastery shop hidden';
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('mousedown', (e) => e.stopPropagation());
    document.body.append(this.el);
    // Capture phase so the settings menu's Escape handler doesn't also fire.
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.isOpen || e.code !== 'Escape') return;
        // Someone typing (the chat box) closes their field first.
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.toggle(false);
      },
      true,
    );
  }

  /** open for this Quartermaster NPC entity (role 'vendor') */
  open(npc: SimEntity): void {
    if (npc.id !== this.npcId) this.tab = 'buy';
    this.npcId = npc.id;
    this.toggle(true);
  }

  toggle(open = !this.isOpen): void {
    if (open && !this.npcId) return;
    this.isOpen = open;
    this.el.classList.toggle('hidden', !open);
    this.key = '';
    if (open && document.pointerLockElement) document.exitPointerLock();
    this.onOpenChange(open);
  }

  /** call every frame; re-renders only when coins/bag/infamy change; closes when you walk away or the NPC is gone */
  update(px: number, pz: number): void {
    const h = this.host();
    const now = performance.now();
    if (now - this.scanAt > 1000) {
      this.scanAt = now;
      const fire = h.camps.campfireOf(h.charId);
      if (fire) this.campSeen = { charId: h.charId, x: fire.x, z: fire.z };
    }
    if (!this.isOpen) return;
    const npc = this.npcId ? h.entities.get(this.npcId) : undefined;
    if (!npc || npc.dead || Math.hypot(npc.pos.x - px, npc.pos.z - pz) > SHOP.vendorRange + 2) return this.toggle(false);
    this.render(h, npc);
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-tab],[data-buy],[data-sell],[data-pardon],[data-travel],[data-close]');
    if (!t) {
      if (e.target === this.el) this.toggle(false);
      return;
    }
    if ((t as HTMLButtonElement).disabled) return;
    const d = t.dataset;
    if (d.close !== undefined) return this.toggle(false);
    if (d.tab) this.tab = d.tab as Tab;
    const npc = this.npcId;
    if (npc) {
      const h = this.host();
      const n = Math.max(1, Math.floor(Number(d.n)) || 1);
      if (d.buy) h.shop({ npc, a: 'buy', item: d.buy, n });
      if (d.sell) h.shop({ npc, a: 'sell', item: d.sell, n });
      if (d.pardon !== undefined) h.shop({ npc, a: 'pardon' });
      if (d.travel) h.shop({ npc, a: 'travel', dest: d.travel });
    }
    this.key = '';
  }

  /** Your camp and crew hall, found the way the authority finds them. */
  private spots(h: CombatHost): TravelSpot[] {
    const fire = h.camps.campfireOf(h.charId);
    const seen = this.campSeen?.charId === h.charId ? this.campSeen : null;
    const camp = fire ? { x: fire.x, z: fire.z } : seen;
    const crew = h.crew;
    let hall: { x: number; z: number; name: string } | null = null;
    if (crew) {
      const name = `[${crew.tag}] crew hall`;
      const s = h.camps.hallOf(crew.id);
      const far = s ? null : h.terr.halls.find((x) => x.tag === crew.tag && x.faction === crew.faction);
      if (s) hall = { x: s.x, z: s.z, name };
      else if (far) hall = { x: far.x, z: far.z, name };
    }
    return travelSpots(h.me, camp, hall);
  }

  private render(h: CombatHost, npc: SimEntity): void {
    const me = h.me;
    const p = h.progress;
    const coins = p.standing.coins;
    const inf = Math.max(infamyNow(p.standing, Date.now()), 0);
    const bag = invTotal(p.inv);
    const sameSide = !!me.side && npc.side === me.side;
    const safe = zoneAt(me.pos.x, me.pos.z).kind === 'safe';
    const spots = sameSide && this.tab === 'travel' ? this.spots(h) : [];
    const key = JSON.stringify([
      this.tab, npc.id, npc.name, sameSide, coins, p.inv, inf, me.faction, safe,
      spots.map((s) => [s.id, s.cost, Math.round(Math.hypot(s.x - me.pos.x, s.z - me.pos.z) / 10)]),
    ]);
    if (key === this.key) return;
    this.key = key;

    const fac = factionById(npc.faction);
    const head = `<div class="m-head"><div><b>${esc(npc.name)}</b><span>${esc(npc.title ?? 'Quartermaster')}${fac ? ` · <b style="color:${fac.color}">${esc(fac.name)}</b>` : ''} · you have <b class="s-coins">${coins.toLocaleString()} coins</b>${inf > 0 ? ` · <b class="s-bounty">bounty ${inf}</b>` : ''}</span></div>
      <div class="m-btns"><button class="secondary" data-close>Close</button></div></div>`;

    if (!sameSide) {
      const side = SIDES[npc.side as Side]?.name ?? 'other side';
      this.el.innerHTML = `<div class="m-panel">${head}<p class="s-empty">${esc(npc.name)} only trades with the ${esc(side)}. Find the Quartermaster in one of your own side's hubs.</p></div>`;
      return;
    }

    const full = bag >= BAG_CAP;
    const tabs = `<div class="s-tabs">${TABS.map(([id, label]) => `<button data-tab="${id}" class="${this.tab === id ? 'on' : ''}">${label}</button>`).join('')}
      <span class="s-bag${full ? ' full' : ''}">Bag ${bag}/${BAG_CAP}</span></div>`;
    const body = this.tab === 'buy' ? this.buyTab(h, coins, bag, inf) : this.tab === 'sell' ? this.sellTab(h) : this.travelTab(h, spots, coins, inf, safe);
    this.el.innerHTML = `<div class="m-panel">${head}${tabs}${body}</div>`;
  }

  private buyTab(h: CombatHost, coins: number, bag: number, inf: number): string {
    const room = BAG_CAP - bag;
    const items = shopItems(h.me.faction);
    const rows = items.map((it) => {
      const have = h.progress.inv[it.id] ?? 0;
      const can1 = room > 0 && coins >= it.price;
      const can10 = room > 0 && coins >= it.price * Math.min(10, room);
      return `<div class="s-row${it.black ? ' black' : ''}">
        <span class="s-name">${icon(it.id)} ${esc(it.name)}${it.black ? '<small class="s-bm">black market</small>' : ''}</span>
        <span class="s-price">${it.price} c</span><span class="s-have">${have} held</span>
        <span class="s-btns"><button class="secondary" data-buy="${esc(it.id)}" data-n="1"${dis(can1)}>Buy 1</button><button data-buy="${esc(it.id)}" data-n="10"${dis(can10)}>Buy 10</button></span></div>`;
    });
    // Pardons come with the black market (the same rule the authority applies).
    let pardon = '';
    if (inf > 0 && items.some((it) => it.black)) {
      const cost = Math.ceil(inf * SHOP.pardonPerInfamy);
      pardon = `<div class="s-row s-pardon">
        <span class="s-name"><b>Pardon</b><small>Wipe your bounty of ${inf} clean. Bounties also wear off with time.</small></span>
        <span class="s-price">${cost} c</span><span class="s-have"></span>
        <span class="s-btns"><button data-pardon${dis(coins >= cost)}>Buy pardon</button></span></div>`;
    }
    const foot = room <= 0 ? 'Your bag is full: sell something or store it in your camp chest first.' : `Prices are per item; you can carry ${room} more.`;
    return `<div class="s-list">${rows.join('')}</div>${pardon}<div class="m-foot">${foot}</div>`;
  }

  private sellTab(h: CombatHost): string {
    const held = Object.entries(h.progress.inv)
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => materialName(a).localeCompare(materialName(b)));
    if (!held.length) return '<p class="s-empty">Your bag is empty. Gather from resource nodes, hunt, or bend materials (channel) to have something to sell.</p>';
    const rows = held.map(([id, n]) => {
      const each = sellPrice(id);
      return `<div class="s-row">
        <span class="s-name">${icon(id)} ${esc(materialName(id))}</span>
        <span class="s-price">${each} c each</span><span class="s-have">${n} held</span>
        <span class="s-btns"><button class="secondary" data-sell="${esc(id)}" data-n="1">Sell 1</button><button data-sell="${esc(id)}" data-n="${n}">Sell all (${(each * n).toLocaleString()} c)</button></span></div>`;
    });
    return `<div class="s-list">${rows.join('')}</div>
      <div class="m-foot">The Quartermaster pays ${Math.round(SHOP.buyBack * 100)}% of the shop price, and ${SHOP.junk} coin for anything not on the shelves.</div>`;
  }

  private travelTab(h: CombatHost, spots: TravelSpot[], coins: number, inf: number, safe: boolean): string {
    const t = SHOP.travel;
    const me = h.me;
    const discount = factionById(me.faction)?.perk.travelDiscount ?? 0;
    const calm = inf <= t.maxInfamy;
    const rules = `<ul class="s-rules">
      <li class="${safe ? 'ok' : 'bad'}">Ships leave only from a hub's safe zone${safe ? '' : ': you are outside it'}</li>
      <li>Not within ${t.combatSeconds} s of a fight</li>
      <li class="${calm ? 'ok' : 'bad'}">No passengers with a bounty over ${t.maxInfamy}${inf > 0 ? ` (yours: ${inf})` : ''}</li>
      <li>Fare: ${t.base} coins + ${t.perKm} per km${discount > 0 ? `, ${Math.round(discount * 100)}% off for your faction` : ''}</li></ul>`;
    const rows = spots.map((s) => {
      const d = Math.hypot(s.x - me.pos.x, s.z - me.pos.z);
      return `<div class="s-row">
        <span class="s-name">${s.id === 'camp' ? '🔥' : s.id === 'hall' ? '🏯' : (factionById(s.id.slice(4))?.emblem ?? '⚓')} ${esc(s.name)}</span>
        <span class="s-price">${s.cost} c</span><span class="s-have">${dist(d)}</span>
        <span class="s-btns"><button data-travel="${esc(s.id)}"${dis(safe && calm && coins >= s.cost)}>Travel</button></span></div>`;
    });
    const list = rows.length ? `<div class="s-list">${rows.join('')}</div>` : '<p class="s-empty">Nowhere to send you from here.</p>';
    return `${rules}${list}<div class="m-foot">Hubs of your side, your camp (once you've placed a campfire) and your crew hall are listed here.</div>`;
  }
}
