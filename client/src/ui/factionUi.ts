import './faction.css';
import type { CrewInviteMsg } from '@shared/net';
import { POINTS, TERR, type PointState, type WarPoint } from '@shared/territory';
import { STANDING, crewRank, infamyNow, nextRankPoints, orderTarget, orderText, rankTitle } from '@shared/standing';
import { CREW, cleanTag, roleAtLeast, validCrewName, validTag, type CrewRole, type CrewView } from '@shared/crews';
import { SIDES, factionById, sideOf, zoneAt, type Side } from '@shared/factions';
import { BAG_CAP, MATERIALS, crewRaidOpen, crewRaidText, invTotal, materialName } from '@shared/building';
import characterData from '@data/character.json';
import type { CombatHost } from '../game/combat/host';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const icon = (id: string) => MATERIALS.find((m) => m.id === id)?.icon ?? '•';
const pct = (f: number) => `${(Math.max(0, Math.min(1, f)) * 100).toFixed(1)}%`;
const num = (n: number) => Math.round(n).toLocaleString();
const dis = (ok: boolean, why = '') => (ok ? '' : ` disabled${why ? ` title="${esc(why)}"` : ''}`);
const isField = (el: Element | null): el is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');

const ELEMENT_NAME: Record<string, string> = { fire: 'Fire', water: 'Water', earth: 'Earth', air: 'Air' };
const ROLE_NAME: Record<CrewRole, string> = { leader: 'Leader', officer: 'Officer', member: 'Member' };
const ROLE_ORDER: Record<CrewRole, number> = { member: 0, officer: 1, leader: 2 };
const KIND_ICON: Record<WarPoint['kind'], string> = { shrine: '⛩️', outpost: '🏯' };
/** a point nobody holds */
const NOBODY = '#8a90a0';
/** how long a "click again" button waits for the second click */
const CONFIRM_MS = 4000;

/** Faction colours are made for banners; lighten them so text reads on the dark panels. */
const textColors = new Map<string, string>();
function textColor(hex: string | undefined): string {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return 'var(--ink)';
  let out = textColors.get(hex);
  if (!out) {
    const n = parseInt(hex.slice(1), 16);
    const mix = (v: number) => Math.round(v + (255 - v) * 0.3);
    out = `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
    textColors.set(hex, out);
  }
  return out;
}
const sideName = (s: string) => SIDES[s as Side]?.name ?? 'Nobody';
const sideColor = (s: string) => SIDES[s as Side]?.color ?? NOBODY;
const counts = (st: PointState) =>
  `<span style="color:${textColor(SIDES.order.color)}">${esc(SIDES.order.name)} ${st.order}</span> vs <span style="color:${textColor(SIDES.outlaw.color)}">${esc(SIDES.outlaw.name)} ${st.outlaw}</span>`;

interface CapView {
  /** meter fill 0..1 */
  frac: number;
  color: string;
  text: string;
  cls: 'idle' | 'held' | 'capturing' | 'contested';
}

/**
 * What a point's capture meter shows, read the way Territory.update moves it:
 * progress fills toward capSide; the side with more players inside pushes it
 * (toward them, or drains the other side's meter first); equal numbers stall it.
 */
function capView(st: PointState | undefined, open: boolean): CapView {
  if (!st) return { frac: 0, color: NOBODY, text: 'No word from here yet', cls: 'idle' };
  const holder = sideOf(st.owner) ?? '';
  const fac = factionById(st.owner);
  const held = fac ? `Held by ${fac.name}` : 'Unclaimed';
  if (!open) return { frac: fac ? 1 : 0, color: fac?.color ?? NOBODY, text: `${held} · captures open during territory wars`, cls: 'idle' };
  const color = fac && st.capSide === holder ? fac.color : sideColor(st.capSide);
  const p = st.progress;
  const o = st.order;
  const x = st.outlaw;
  if (o && o === x) return { frac: p, color, text: 'Contested: evenly matched, the meter is stuck', cls: 'contested' };
  if (!o && !x) {
    if (st.capSide === holder) return { frac: p, color, text: !fac || p >= 1 ? held : `${held} · recovering`, cls: fac ? 'held' : 'idle' };
    return { frac: p, color, text: `${sideName(st.capSide)} meter drifting back`, cls: 'idle' };
  }
  const push = o > x ? 'order' : 'outlaw';
  if (push === st.capSide || (!st.capSide && p <= 0)) {
    if (fac && push === holder) return { frac: p, color, text: p >= 1 ? `${fac.name} holds it` : `${fac.name} reinforcing`, cls: 'held' };
    return { frac: p, color: sideColor(push), text: `${sideName(push)} capturing`, cls: 'capturing' };
  }
  return { frac: p, color, text: st.capSide === holder ? `${sideName(push)} breaking the hold` : `${sideName(push)} pushing back`, cls: 'capturing' };
}

// ---- crew invites -----------------------------------------------------------------------

/** The crew invite waiting for an answer (shared by the prompt and the panel's Crew tab). */
let invite: { msg: CrewInviteMsg; until: number } | null = null;
const pendingInvite = () => (invite && invite.until > performance.now() ? invite : null);

function answerInvite(host: CombatHost, accept: boolean): void {
  if (!pendingInvite()) return;
  host.crewAction({ a: accept ? 'accept' : 'decline' });
  invite = null;
}

/**
 * "[TAG] Name: X invites you to their crew" with accept/decline keys and a
 * countdown. Sits right above the party invite prompt so both can show at once.
 */
export class CrewInvitePrompt {
  private el = document.createElement('div');
  private shown: typeof invite = null;
  private keyText = '';
  private secs = -1;
  private countdown: HTMLElement | null = null;

  constructor(private host: () => CombatHost) {
    this.el.className = 'invite crew-invite hidden';
    this.el.addEventListener('mousedown', (e) => e.stopPropagation());
    this.el.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-answer]');
      if (t) this.answer(t.dataset.answer === 'yes');
    });
    document.body.append(this.el);
  }

  get pending(): boolean {
    return !!pendingInvite();
  }

  answer(accept: boolean): void {
    answerInvite(this.host(), accept);
    this.hide();
  }

  update(_dt: number, keys: { accept: string; decline: string }): void {
    // Expiry runs on wall time like the server's (frame dt is clamped in slow tabs).
    for (const m of this.host().crewInvites.splice(0)) invite = { msg: m, until: performance.now() + Math.max(0, m.expires) * 1000 };
    const p = pendingInvite();
    if (!p) {
      invite = null;
      if (this.shown) this.hide();
      return;
    }
    const keyText = `${keys.accept}|${keys.decline}`;
    if (p !== this.shown || keyText !== this.keyText) {
      this.shown = p;
      this.keyText = keyText;
      this.secs = -1;
      const m = p.msg;
      this.el.innerHTML = `<div><b class="ci-crew">[${esc(m.tag)}] ${esc(m.name)}</b>: <b>${esc(m.from)}</b> invites you to their crew</div>
        <div class="row"><button class="primary" data-answer="yes">Accept (${esc(keys.accept)})</button><button class="secondary" data-answer="no">Decline (${esc(keys.decline)})</button></div>
        <small class="ci-t"></small>`;
      this.countdown = this.el.querySelector('.ci-t');
      this.el.classList.remove('hidden');
    }
    const secs = Math.max(0, Math.ceil((p.until - performance.now()) / 1000));
    if (secs !== this.secs && this.countdown) {
      this.secs = secs;
      this.countdown.textContent = secs >= 60 ? `Expires in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : `Expires in ${secs} s`;
    }
  }

  private hide(): void {
    this.shown = null;
    this.countdown = null;
    this.el.classList.add('hidden');
  }
}

// ---- war HUD ----------------------------------------------------------------------------

/**
 * Always-on corner HUD under the settings gear: the war line, the capture meter
 * of the point you stand on, your coins and your bounty. Touches the DOM only
 * when what it shows changes.
 */
export class WarHud {
  private root = document.createElement('div');
  private war = document.createElement('div');
  private cap = document.createElement('div');
  private purse = document.createElement('div');
  private capName = document.createElement('div');
  private capFill = document.createElement('span');
  private capPct = document.createElement('em');
  private capState = document.createElement('div');
  private warKey = '';
  private capKey = '';
  private nameKey = '';
  private purseKey = '';

  constructor() {
    this.root.className = 'war-hud';
    this.war.className = 'wh-war hidden';
    this.cap.className = 'wh-cap hidden';
    this.purse.className = 'wh-purse';
    this.capName.className = 'wh-name';
    this.capState.className = 'wh-state';
    const bar = document.createElement('div');
    bar.className = 'wh-bar';
    bar.append(this.capFill, this.capPct);
    this.cap.append(this.capName, bar, this.capState);
    this.root.append(this.war, this.cap, this.purse);
    document.body.append(this.root);
  }

  update(host: CombatHost, x: number, z: number): void {
    const t = host.terr;
    const warKey = `${t.open ? 1 : 0}|${t.text}`;
    if (warKey !== this.warKey) {
      this.warKey = warKey;
      this.war.textContent = t.text;
      this.war.className = `wh-war${t.open ? ' on' : ''}${t.text ? '' : ' hidden'}`;
    }

    const pt = POINTS.find((p) => Math.hypot(x - p.x, z - p.z) <= p.captureRadius);
    const st = pt ? t.points.find((s) => s.id === pt.id) : undefined;
    const capKey = pt ? `${pt.id}|${t.open ? 1 : 0}|${st ? `${st.owner}|${st.capSide}|${st.progress}|${st.order}|${st.outlaw}` : '-'}` : '';
    if (capKey !== this.capKey) {
      this.capKey = capKey;
      this.cap.classList.toggle('hidden', !pt);
      if (pt) this.renderCap(pt, st, t.open);
    }

    const coins = host.progress.standing.coins;
    const inf = Math.max(0, Math.round(host.me.infamy || 0));
    const purseKey = `${coins}|${inf}`;
    if (purseKey !== this.purseKey) {
      this.purseKey = purseKey;
      this.purse.innerHTML =
        `<span class="wh-coins" title="Coins"><i class="f-coin"></i>${num(coins)}</span>` +
        (inf > 0 ? `<span class="wh-bounty" title="Bounty on your head: Order benders who defeat you collect it">☠ ${num(inf)}</span>` : '');
    }
  }

  private renderCap(pt: WarPoint, st: PointState | undefined, open: boolean): void {
    const fac = factionById(st?.owner);
    const nameKey = `${pt.id}|${fac?.id ?? ''}`;
    if (nameKey !== this.nameKey) {
      this.nameKey = nameKey;
      const who = fac ? `<span style="color:${textColor(fac.color)}">${fac.emblem} ${esc(fac.name)}</span>` : '<span class="wh-none">Unclaimed</span>';
      this.capName.innerHTML = `<b>${KIND_ICON[pt.kind]} ${esc(pt.name)}</b> ${who}`;
    }
    const cv = capView(st, open);
    const live = open && !!st && (st.order > 0 || st.outlaw > 0);
    this.cap.className = `wh-cap ${cv.cls}`;
    // The fill element stays, so its width eases between the server's once-a-second updates.
    this.capFill.style.width = pct(cv.frac);
    this.capFill.style.background = cv.color;
    this.capPct.textContent = `${Math.round(cv.frac * 100)}%`;
    this.capState.innerHTML = `${esc(cv.text)}${live && st ? `<br>${counts(st)}` : ''}`;
  }
}

// ---- faction & crew panel ---------------------------------------------------------------

type Tab = 'faction' | 'crew';

/**
 * Faction & crew panel (U). Faction: rank, coins, perk, bounty or honour, the
 * Envoy's order, rank unlocks and who holds every war point. Crew: found one,
 * or run yours (members and roles, invites, message of the day, raid window,
 * bank). The authority decides everything; its answers arrive as notices and
 * fresh crew/progress state.
 */
export class FactionPanel {
  private el = document.createElement('div');
  private key = '';
  private tab: Tab = 'faction';
  /** what the player typed into the panel's fields (survives re-renders) */
  private draft: Record<string, string> = {};
  /** a button waiting for its second click */
  private confirm: { what: string; until: number } | null = null;
  /** no re-render between mousedown and click (it would swallow the click) */
  private pointerDown = false;
  /** first unmet founding requirement (set when the Crew tab renders) */
  private foundWhy: string | null = null;
  private bankCache = { t: 0, crew: '', v: { open: false, hall: false } };
  isOpen = false;

  constructor(private host: () => CombatHost, private onOpenChange: (open: boolean) => void) {
    this.el.className = 'mastery faction-panel hidden';
    this.el.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      this.pointerDown = true;
    });
    window.addEventListener('mouseup', () => (this.pointerDown = false));
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('input', (e) => this.onInput(e));
    this.el.addEventListener('change', (e) => this.onChange(e));
    // Typing in the panel's fields never reaches the game (Escape still closes it).
    this.el.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') return;
      e.stopPropagation();
      if ((e.code === 'Enter' || e.code === 'NumpadEnter') && isField(e.target as Element)) this.onEnter(e.target as HTMLElement);
    });
    // Leaving a field lets the panel catch up with what changed meanwhile.
    this.el.addEventListener('focusout', () => (this.key = ''));
    // Capture phase so the settings menu's Escape handler doesn't also fire.
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.isOpen || e.code !== 'Escape') return;
        const t = e.target as Element | null;
        // Someone typing elsewhere (the chat box) closes their own field first.
        if (isField(t) && !this.el.contains(t)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.toggle(false);
      },
      true,
    );
    document.body.append(this.el);
  }

  toggle(open = !this.isOpen): void {
    this.isOpen = open;
    this.el.classList.toggle('hidden', !open);
    this.key = '';
    this.confirm = null;
    if (!open) {
      const a = document.activeElement;
      if (a instanceof HTMLElement && this.el.contains(a)) a.blur();
    }
    if (open && document.pointerLockElement) document.exitPointerLock();
    this.onOpenChange(open);
  }

  /** call every frame; re-renders only when what the open tab shows has changed */
  update(): void {
    if (!this.isOpen) return;
    if (this.confirm && performance.now() > this.confirm.until) this.confirm = null;
    // Never while the player is typing or mid-click.
    if (this.pointerDown || this.editing()) return;
    const h = this.host();
    const now = Date.now();
    const key = this.tab === 'faction' ? this.factionKey(h, now) : this.crewKey(h, now);
    if (key === this.key) return;
    this.key = key;
    this.render(h, now);
  }

  private editing(): boolean {
    const a = document.activeElement;
    return isField(a) && this.el.contains(a);
  }

  // ---- input ------------------------------------------------------------------------

  private onClick(e: MouseEvent): void {
    this.pointerDown = false;
    const t = (e.target as HTMLElement).closest<HTMLElement>(
      '[data-close],[data-tab],[data-create],[data-invite],[data-sendinvite],[data-role],[data-kick],[data-motd],[data-take],[data-put],[data-coins],[data-leave]',
    );
    if (!t) {
      if (e.target === this.el) this.toggle(false);
      return;
    }
    if ((t as HTMLButtonElement).disabled) return;
    const d = t.dataset;
    if (d.close !== undefined) return this.toggle(false);
    if (d.tab) {
      this.tab = d.tab as Tab;
      this.confirm = null;
      this.key = '';
      return;
    }
    // Two-step buttons: the first click arms them.
    if (d.confirm && this.confirm?.what !== d.confirm) {
      this.confirm = { what: d.confirm, until: performance.now() + CONFIRM_MS };
      this.key = '';
      return;
    }
    this.confirm = null;
    const h = this.host();
    const crew = h.crew;
    if (d.create !== undefined) this.create(h);
    else if (d.invite) answerInvite(h, d.invite === 'yes');
    else if (d.sendinvite !== undefined) this.sendInvite(h);
    else if (d.role && d.who) h.crewAction({ a: 'role', charId: d.who, role: d.role as CrewRole });
    else if (d.kick) h.crewAction({ a: 'kick', charId: d.kick });
    else if (d.motd !== undefined) this.saveMotd(h);
    else if (d.take && crew) h.crewAction({ a: 'bank', items: { [d.take]: Math.max(1, Math.floor(Number(d.n)) || 1) }, put: false });
    else if (d.put) h.crewAction({ a: 'bank', items: { [d.put]: Math.max(1, Math.floor(Number(d.n)) || 1) }, put: true });
    else if (d.coins) this.moveCoins(h, d.coins === 'put');
    else if (d.leave !== undefined) h.crewAction({ a: 'leave' });
    this.key = '';
  }

  private onInput(e: Event): void {
    const t = e.target as HTMLInputElement;
    const f = t.dataset?.f;
    if (!f || t.tagName !== 'INPUT') return;
    if (f === 'tag') {
      const clean = cleanTag(t.value);
      if (clean !== t.value) t.value = clean;
    }
    this.draft[f] = t.value;
    if (f === 'name' || f === 'tag') this.refreshCreate();
  }

  private onChange(e: Event): void {
    const t = e.target as HTMLSelectElement;
    if (t.tagName !== 'SELECT' || t.dataset.f !== 'raid') return;
    const hour = Number(t.value);
    if (Number.isInteger(hour)) this.host().crewAction({ a: 'raid', hour });
    t.blur();
  }

  private onEnter(t: HTMLElement): void {
    const h = this.host();
    const f = t.dataset.f;
    if (f === 'name' || f === 'tag') {
      if (!this.createWhy(h)) this.create(h);
    } else if (f === 'invite') this.sendInvite(h);
    else if (f === 'motd') this.saveMotd(h);
    else return;
    t.blur();
  }

  // ---- crew actions -----------------------------------------------------------------

  private createWhy(h: CombatHost): string | null {
    const name = (this.draft.name ?? '').trim().replace(/\s+/g, ' ');
    const tag = this.draft.tag ?? '';
    if (!h.online) return 'Crews need the shard server';
    return this.foundWhy ?? (!name ? 'Pick a crew name' : validCrewName(name)) ?? (!tag ? 'Pick a tag' : validTag(tag));
  }

  private create(h: CombatHost): void {
    if (this.createWhy(h)) return;
    h.crewAction({ a: 'create', name: (this.draft.name ?? '').trim().replace(/\s+/g, ' '), tag: this.draft.tag ?? '' });
  }

  private sendInvite(h: CombatHost): void {
    const target = (this.draft.invite ?? '').trim();
    if (!target) return;
    h.crewAction({ a: 'invite', target });
    delete this.draft.invite;
  }

  private saveMotd(h: CombatHost): void {
    if (this.draft.motd === undefined) return;
    h.crewAction({ a: 'motd', text: this.draft.motd.trim().slice(0, 140) });
    delete this.draft.motd;
  }

  private moveCoins(h: CombatHost, put: boolean): void {
    const n = Math.floor(Number(this.draft.coins));
    if (!(n > 0)) return;
    h.crewAction({ a: 'coins', n, put });
    delete this.draft.coins;
  }

  /** Live validation of the founding form (runs while typing, without a re-render). */
  private refreshCreate(): void {
    const btn = this.el.querySelector<HTMLButtonElement>('[data-create]');
    if (!btn) return;
    const name = (this.draft.name ?? '').trim().replace(/\s+/g, ' ');
    const tag = this.draft.tag ?? '';
    const errs: Record<string, string | null> = { name: name ? validCrewName(name) : null, tag: tag ? validTag(tag) : null };
    for (const [f, err] of Object.entries(errs)) {
      this.el.querySelector(`input[data-f="${f}"]`)?.classList.toggle('bad', !!err);
      const out = this.el.querySelector(`[data-err="${f}"]`);
      if (out) out.textContent = err ?? '';
    }
    const why = this.createWhy(this.host());
    btn.disabled = !!why;
    btn.title = why ?? '';
    const whyEl = this.el.querySelector('.f-why');
    if (whyEl) whyEl.textContent = why ?? '';
  }

  /** The bank opens at the crew hall or in your own faction's hub (the server's rule). Checked twice a second. */
  private bankOpen(h: CombatHost, crew: CrewView): { open: boolean; hall: boolean } {
    const now = performance.now();
    const c = this.bankCache;
    if (now - c.t < 500 && c.crew === crew.id) return c.v;
    const me = h.me;
    const hall = h.camps.hallOf(crew.id);
    const atHall = !!hall && Math.hypot(hall.x - me.pos.x, hall.z - me.pos.z) <= CREW.bank.range + 4;
    const zone = zoneAt(me.pos.x, me.pos.z);
    c.t = now;
    c.crew = crew.id;
    c.v = { open: atHall || (zone.kind === 'safe' && zone.faction === me.faction), hall: atHall };
    return c.v;
  }

  // ---- render -----------------------------------------------------------------------

  private factionKey(h: CombatHost, now: number): string {
    const p = h.progress;
    const s = p.standing;
    const t = h.terr;
    return JSON.stringify([
      'f', h.me.faction, h.me.name, p.level, p.rank, s.points, s.coins, s.honor, infamyNow(s, now), s.order, s.ordersDone,
      t.open, t.text, t.points, h.crew?.tag ?? '', h.crew?.name ?? '', !!pendingInvite(),
    ]);
  }

  private crewKey(h: CombatHost, now: number): string {
    const p = h.progress;
    const crew = h.crew;
    return JSON.stringify([
      'c', h.online, h.me.faction, h.me.name, h.charId, p.level, p.rank, p.standing.coins, p.inv, crew,
      crew ? this.bankOpen(h, crew) : null, pendingInvite()?.msg ?? null, this.confirm?.what ?? '', Math.floor(now / 30_000),
    ]);
  }

  private render(h: CombatHost, now: number): void {
    const me = h.me;
    const p = h.progress;
    const fac = factionById(me.faction);
    const crew = h.crew;
    const head = `<div class="m-head"><div><b>Faction &amp; crew</b><span>${esc(me.name)} · Level ${p.level} · ${fac ? `<b style="color:${textColor(fac.color)}">${fac.emblem} ${esc(fac.name)}</b> · ` : ''}Rank ${p.rank} ${esc(rankTitle(p.rank))}${crew ? ` · <b class="f-tagtxt">[${esc(crew.tag)}]</b> ${esc(crew.name)}` : ''}</span></div>
      <div class="m-btns"><button class="secondary" data-close>Close</button></div></div>`;
    const tabs = `<div class="f-tabs"><button data-tab="faction" class="${this.tab === 'faction' ? 'on' : ''}">Faction</button><button data-tab="crew" class="${this.tab === 'crew' ? 'on' : ''}">Crew${!crew && pendingInvite() ? ' <i class="f-dot" title="Crew invite"></i>' : ''}</button>
      <span class="f-coins"><i class="f-coin"></i>${num(p.standing.coins)} coins</span></div>`;
    const body = this.tab === 'faction' ? this.factionTab(h, now) : this.crewTab(h, now);
    this.el.innerHTML = `<div class="m-panel f-panel">${head}${tabs}${body}</div>`;
    if (this.tab === 'crew') this.refreshCreate();
  }

  private factionTab(h: CombatHost, now: number): string {
    const me = h.me;
    const p = h.progress;
    const s = p.standing;
    const fac = factionById(me.faction);
    if (!fac) return '<p class="f-empty">You belong to no faction.</p>';
    const side = SIDES[fac.side];

    const base = STANDING.rankPoints[p.rank - 1] ?? 0;
    const next = nextRankPoints(p.rank);
    const frac = next === null ? 1 : (s.points - base) / Math.max(1, next - base);
    const rankLine = next === null ? `${num(s.points)} rank points · the top rank` : `${num(s.points)} / ${num(next)} rank points · ${num(next - s.points)} to ${esc(rankTitle(p.rank + 1))}`;
    let sideStat: string;
    let sideNote: string;
    if (fac.side === 'outlaw') {
      const inf = infamyNow(s, now);
      sideStat = `<span class="${inf > 0 ? 'f-bounty' : ''}">☠ <b>${num(inf)}</b> bounty</span>`;
      sideNote = inf > 0
        ? `Order benders who defeat you collect your bounty. It wears off by ${STANDING.infamy.decayPerHour} an hour; a Quartermaster with a black market sells pardons.`
        : `Defeating Order players puts a bounty on your head (+${STANDING.infamy.perKill} each).`;
    } else {
      sideStat = `<span>⚖ <b>${num(s.honor)}</b> honour</span>`;
      sideNote = 'Honour is the bounty you have collected from Outlaws. Defeat bountied Outlaws for coins, XP and rank points.';
    }
    const who = `<section class="f-card f-who" style="--fc:${fac.color}">
      <div class="f-name"><span class="f-emblem">${fac.emblem}</span> <div><b style="color:${textColor(fac.color)}">${esc(fac.name)}</b>
        <small><span style="color:${textColor(side.color)}">${esc(side.name)}</span> · ${esc(fac.identity)}</small></div></div>
      <div class="f-rank"><b>Rank ${p.rank} · ${esc(rankTitle(p.rank))}</b><small>${rankLine}</small></div>
      <div class="f-bar"><span style="width:${pct(frac)};background:${fac.color}"></span></div>
      <div class="f-stats"><span><i class="f-coin"></i><b>${num(s.coins)}</b> coins</span>${sideStat}<span><b>${num(s.ordersDone)}</b> order${s.ordersDone === 1 ? '' : 's'} done</span></div>
      <p class="f-note">${esc(sideNote)}</p>
      <div class="f-perk"><small>Faction perk</small>${esc(fac.perk.text)}</div>
    </section>`;

    const o = s.order;
    const tgt = orderTarget(o);
    const order = `<section class="f-card"><h4>Envoy order</h4>${
      o
        ? `<p class="f-order${o.have >= o.n ? ' done' : ''}">${esc(orderText(o))}</p>${tgt ? `<p class="f-note">📍 ${esc(tgt.name)}</p>` : ''}`
        : `<p class="f-note">Talk to your faction's Envoy for an order.</p>`
    }</section>`;

    const unlocks = `<section class="f-card"><h4>Rank unlocks</h4><ul class="f-list">${STANDING.unlocks
      .map((u) => `<li class="${p.rank >= u.rank ? 'ok' : ''}"><b>Rank ${u.rank}</b> ${esc(rankTitle(u.rank))}: ${esc(u.text)}</li>`)
      .join('')}</ul></section>`;

    return `<div class="f-grid"><div class="f-col">${who}${order}${unlocks}</div><div class="f-col">${this.territory(h)}</div></div>`;
  }

  private territory(h: CombatHost): string {
    const me = h.me;
    const t = h.terr;
    const fac = factionById(me.faction);
    const states = new Map(t.points.map((s) => [s.id, s]));
    const mine = POINTS.filter((pt) => states.get(pt.id)?.owner === me.faction);
    const perks = mine.flatMap((pt) => (pt.buff ? [pt.buff.text] : []));
    if (mine.length) perks.push(`+${Math.round(mine.length * TERR.xpPerPoint * 100)}% XP`);
    const summary = fac ? (mine.length ? `${esc(fac.name)} holds ${mine.length} of ${POINTS.length}: ${esc(perks.join(', '))}` : `${esc(fac.name)} holds none of the ${POINTS.length} points`) : '';
    const rows = POINTS.map((pt) => {
      const st = states.get(pt.id);
      const holder = factionById(st?.owner);
      const cv = capView(st, t.open);
      const holderSide = sideOf(st?.owner) ?? '';
      const moving = t.open && !!st && (st.order > 0 || st.outlaw > 0 || st.capSide !== holderSide || (!!holder && st.progress < 1));
      return `<div class="f-pt${holder && holder.id === me.faction ? ' mine' : ''}" style="--hc:${holder?.color ?? NOBODY}">
        <div class="f-pt-top"><span class="f-pt-name">${KIND_ICON[pt.kind]} ${esc(pt.name)}</span>
          <span class="f-pt-holder" style="color:${holder ? textColor(holder.color) : 'var(--muted)'}">${holder ? `${holder.emblem} ${esc(holder.name)}` : 'Unclaimed'}</span></div>
        ${pt.buff ? `<small class="f-pt-buff">${esc(pt.buff.text)} for the holders</small>` : ''}
        ${moving && st ? `<div class="f-pt-cap ${cv.cls}"><div class="f-bar thin"><span style="width:${pct(cv.frac)};background:${cv.color}"></span></div>
          <small>${esc(cv.text)} · ${Math.round(cv.frac * 100)}%${st.order || st.outlaw ? ` · ${counts(st)}` : ''}</small></div>` : ''}
      </div>`;
    }).join('');
    return `<section class="f-card f-terr"><h4>Territory <span class="f-war${t.open ? ' on' : ''}">${esc(t.text || 'No word on the war yet')}</span></h4>
      ${summary ? `<p class="f-note">${summary}</p>` : ''}
      <div class="f-pts">${rows}</div>
      <p class="f-note">Points change hands only during a territory war: stand in a point's circle with more of your side than theirs. Held shrines and outposts pay income to the crew that led the capture, and every member of the holding faction gets the bonus.</p>
    </section>`;
  }

  private crewTab(h: CombatHost, now: number): string {
    if (!h.online) return '<p class="f-empty">Crews need the shard server. You are playing offline.</p>';
    return h.crew ? this.inCrew(h, h.crew, now) : this.noCrew(h);
  }

  private confirmBtn(what: string, label: string, armed: string, cls = 'secondary', extra = ''): string {
    const on = this.confirm?.what === what;
    return `<button class="${cls}${on ? ' armed' : ''}" data-confirm="${esc(what)}" ${extra}>${esc(on ? armed : label)}</button>`;
  }

  private noCrew(h: CombatHost): string {
    const p = h.progress;
    const s = p.standing;
    const f = CREW.found;
    const need = crewRank();
    const reqs = [
      { ok: p.level >= f.minLevel, text: `Level ${f.minLevel}`, have: `you are level ${p.level}`, why: `Founding a crew needs level ${f.minLevel}` },
      { ok: p.rank >= need, text: `Faction rank ${need} (${rankTitle(need)})`, have: `you are rank ${p.rank}`, why: `Founding a crew needs faction rank ${need}` },
      { ok: s.coins >= f.coins, text: `${f.coins} coins`, have: `you have ${num(s.coins)}`, why: `Founding a crew costs ${f.coins} coins` },
    ];
    this.foundWhy = reqs.find((r) => !r.ok)?.why ?? null;
    const inv = pendingInvite();
    const invHtml = inv
      ? `<section class="f-card f-invite"><h4>Crew invite</h4><p><b class="f-tagtxt">[${esc(inv.msg.tag)}] ${esc(inv.msg.name)}</b>: <b>${esc(inv.msg.from)}</b> invites you to their crew.</p>
        <div class="f-row"><button class="f-btn" data-invite="yes">Join [${esc(inv.msg.tag)}]</button><button class="secondary" data-invite="no">Decline</button></div></section>`
      : '';
    const form = `<section class="f-card"><h4>Found a crew</h4>
      <div class="f-form">
        <label class="f-field"><span>Name</span><input data-f="name" type="text" maxlength="${CREW.name.max}" value="${esc(this.draft.name ?? '')}" placeholder="Crew name" autocomplete="off" spellcheck="false"><small class="f-err" data-err="name"></small></label>
        <label class="f-field f-tagf"><span>Tag</span><input data-f="tag" type="text" maxlength="${CREW.tag.max}" value="${esc(this.draft.tag ?? '')}" placeholder="TAG" autocomplete="off" spellcheck="false"><small class="f-err" data-err="tag"></small></label>
      </div>
      <ul class="f-list f-reqs">${reqs.map((r) => `<li class="${r.ok ? 'ok' : 'bad'}">${esc(r.text)} <small>(${esc(r.have)})</small></li>`).join('')}</ul>
      <div class="f-row"><button class="f-btn" data-create>Found crew (${f.coins} coins)</button><small class="f-why"></small></div>
    </section>`;
    const about = `<p class="m-foot">A crew is up to ${CREW.maxMembers} players of one faction: a crew tag on your nameplate, crew chat (/c), a shared bank, crew levels from ${Math.round(CREW.xpShare * 100)}% of its members' XP, and a base around a crew hall raised on a free plot, with a raid window the leader picks. Tags are ${CREW.tag.min}-${CREW.tag.max} capital letters or digits.</p>`;
    return invHtml + form + about;
  }

  private inCrew(h: CombatHost, c: CrewView, now: number): string {
    // The founding form's drafts are spent once you're in a crew.
    delete this.draft.name;
    delete this.draft.tag;
    const meId = h.charId;
    const role: CrewRole = c.members.find((m) => m.charId === meId)?.role ?? 'member';
    const officer = roleAtLeast(role, 'officer');
    const leader = role === 'leader';
    const fac = factionById(c.faction);
    const online = c.members.filter((m) => m.online).length;

    // Header: tag, name, level, message of the day.
    const base = CREW.levelXp[c.level - 1] ?? 0;
    const frac = c.nextXp ? (c.xp - base) / Math.max(1, c.nextXp - base) : 1;
    const motdText = c.motd ? `<q>${esc(c.motd)}</q>` : '<span class="f-muted">No message of the day</span>';
    const motd = officer
      ? `<div class="f-row f-motd"><input data-f="motd" type="text" maxlength="140" value="${esc(this.draft.motd ?? c.motd)}" placeholder="Message of the day" autocomplete="off"><button class="secondary" data-motd>Save</button></div>`
      : `<div class="f-motd">${motdText}</div>`;
    const head = `<section class="f-card f-who" style="--fc:${fac?.color ?? NOBODY}">
      <div class="f-name"><span class="f-crewtag" style="color:${textColor(fac?.color)}">[${esc(c.tag)}]</span> <div><b>${esc(c.name)}</b>
        <small>${fac ? `${fac.emblem} ${esc(fac.name)} · ` : ''}${online}/${c.members.length} online · you are ${ROLE_NAME[role].toLowerCase()}</small></div></div>
      <div class="f-rank"><b>Crew level ${c.level}</b><small>${c.nextXp ? `${num(c.xp)} / ${num(c.nextXp)} crew XP` : `${num(c.xp)} crew XP · the top level`}</small></div>
      <div class="f-bar"><span style="width:${pct(frac)};background:${fac?.color ?? NOBODY}"></span></div>
      ${motd}
    </section>`;

    // Members with what this viewer may do to each.
    const sorted = [...c.members].sort((a, b) => ROLE_ORDER[b.role] - ROLE_ORDER[a.role] || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    const rows = sorted.map((m) => {
      const self = m.charId === meId;
      const id = esc(m.charId);
      const btns: string[] = [];
      if (!self && leader) {
        if (m.role === 'member') btns.push(`<button class="secondary" data-role="officer" data-who="${id}" title="Make officer">Promote</button>`);
        if (m.role === 'officer') {
          btns.push(`<button class="secondary" data-role="member" data-who="${id}" title="Make member">Demote</button>`);
          btns.push(this.confirmBtn(`lead:${m.charId}`, 'Make leader', 'Hand over?', 'secondary', `data-role="leader" data-who="${id}" title="You become an officer"`));
        }
      }
      if (!self && officer && ROLE_ORDER[m.role] < ROLE_ORDER[role]) btns.push(this.confirmBtn(`kick:${m.charId}`, 'Kick', 'Really kick?', 'secondary danger', `data-kick="${id}"`));
      const info = [`Lv ${m.level}`, ELEMENT_NAME[m.element] ?? ''].filter(Boolean).join(' · ');
      return `<div class="f-mem${m.online ? ' on' : ''}${self ? ' me' : ''}"><i class="f-online" title="${m.online ? 'Online' : 'Offline'}"></i>
        <span class="f-mname">${esc(m.name)}${self ? ' <small>(you)</small>' : ''}</span><span class="f-role ${m.role}">${ROLE_NAME[m.role]}</span>
        <span class="f-mlv">${esc(info)}</span><span class="f-mbtns">${btns.join('')}</span></div>`;
    });
    const full = c.members.length >= CREW.maxMembers;
    const inviteRow = officer
      ? `<div class="f-row f-inv"><input data-f="invite" type="text" maxlength="${characterData.nameMaxLength}" value="${esc(this.draft.invite ?? '')}" placeholder="Character name" autocomplete="off" spellcheck="false">
          <button class="f-btn" data-sendinvite${dis(!full, 'The crew is full')}>Invite</button></div>
        <p class="f-note">Invite an online player of your faction by name. Invites last ${Math.round(CREW.inviteSeconds / 60)} minutes.</p>`
      : '<p class="f-note">Officers and the leader invite new members.</p>';
    const members = `<section class="f-card"><h4>Members <small>${c.members.length}/${CREW.maxMembers}</small></h4><div class="f-mems">${rows.join('')}</div>${inviteRow}</section>`;

    // Raid window.
    const raidOpen = crewRaidOpen(c.raidStart, now);
    const wait = c.raidChangedAt + CREW.raid.changeCooldownHours * 3_600_000 - now;
    const raidWhy = raidOpen ? 'Not while the raid window is open' : wait > 0 ? `You can move it again in ${Math.ceil(wait / 3_600_000)} h` : null;
    const hours = Array.from({ length: 24 }, (_, i) => `<option value="${i}"${i === c.raidStart ? ' selected' : ''}>${String(i).padStart(2, '0')}:00 UTC</option>`).join('');
    const raid = `<section class="f-card"><h4>Raid window</h4>
      <p class="f-raid${raidOpen ? ' on' : ''}">${esc(crewRaidText(c.raidStart, now))}</p>
      ${leader
        ? `<div class="f-row"><label class="f-sel">Opens at <select data-f="raid"${dis(!raidWhy, raidWhy ?? '')}>${hours}</select></label></div>
           <p class="f-note">${esc(raidWhy ?? `You can move it once every ${CREW.raid.changeCooldownHours} h, never while it is open.`)}</p>`
        : '<p class="f-note">The leader picks when it opens.</p>'}
      <p class="f-note">For ${CREW.raid.hours} h a day the other side can damage your crew hall and base. Beating the hall down sacks the bank.</p>
    </section>`;

    // Bank.
    const bank = this.bankOpen(h, c);
    const bag = h.progress.inv;
    const bankTotal = invTotal(c.bank);
    const bagTotal = invTotal(bag);
    const bankRoom = Math.max(0, c.bankCap - bankTotal);
    const bagRoom = Math.max(0, BAG_CAP - bagTotal);
    const closed = 'The bank opens at your crew hall or in your faction hub';
    const itemRow = (id: string, n: number, act: 'take' | 'put', room: number, allowed: boolean) => {
      const k = Math.min(n, room);
      const why = !bank.open ? closed : room <= 0 ? (act === 'take' ? 'Your bag is full' : 'The bank is full') : '';
      const verb = act === 'take' ? 'Take' : 'Put';
      const btns = allowed
        ? `<button class="secondary" data-${act}="${esc(id)}" data-n="1"${dis(!why, why)}>${verb} 1</button>${k > 1 ? `<button class="secondary" data-${act}="${esc(id)}" data-n="${k}"${dis(!why, why)}>${verb} ${k}</button>` : ''}`
        : '';
      return `<div class="f-item"><span>${icon(id)} ${esc(materialName(id))}</span><b>${num(n)}</b><span class="f-ibtns">${btns}</span></div>`;
    };
    const held = (inv: Record<string, number>) => Object.entries(inv).filter(([, n]) => n > 0).sort(([a], [b]) => materialName(a).localeCompare(materialName(b)));
    const bankRows = held(c.bank).map(([id, n]) => itemRow(id, n, 'take', bagRoom, officer)).join('');
    const bagRows = held(bag).map(([id, n]) => itemRow(id, n, 'put', bankRoom, true)).join('');
    const coinWhy = bank.open ? '' : closed;
    const bankHtml = `<section class="f-card f-bank"><h4>Crew bank <small>${num(bankTotal)}/${num(c.bankCap)} items · <i class="f-coin"></i>${num(c.coins)} coins</small></h4>
      <p class="f-note ${bank.open ? 'ok' : 'bad'}">${bank.open ? (bank.hall ? 'At your crew hall: the bank is open.' : 'In your faction hub: the bank is open.') : `${closed}.`}</p>
      <div class="f-cols"><div><h5>In the bank</h5>${bankRows || '<p class="f-muted">Empty</p>'}</div>
        <div><h5>Your bag <small>${bagTotal}/${BAG_CAP}</small></h5>${bagRows || '<p class="f-muted">Empty</p>'}</div></div>
      <div class="f-row f-coinrow"><i class="f-coin"></i><input data-f="coins" type="number" min="1" step="1" value="${esc(this.draft.coins ?? '')}" placeholder="Coins">
        <button class="secondary" data-coins="put"${dis(!coinWhy, coinWhy)}>Put in</button>${officer ? `<button class="secondary" data-coins="take"${dis(!coinWhy, coinWhy)}>Take out</button>` : ''}
        <small class="f-muted">you carry ${num(h.progress.standing.coins)}</small></div>
      ${officer ? '' : `<p class="f-note">Only ${CREW.withdraw}s and the leader take from the bank.</p>`}
    </section>`;

    // Leave or disband.
    const alone = c.members.length === 1;
    const heir = leader && !alone
      ? [...c.members].filter((m) => m.charId !== meId).sort((a, b) => ROLE_ORDER[b.role] - ROLE_ORDER[a.role] || a.joined - b.joined)[0]
      : null;
    const leaveNote = alone ? 'You are the last member: the crew, its bank and its base go with you.' : heir ? `${esc(heir.name)} becomes the leader.` : '';
    const leave = `<section class="f-card f-leave"><div class="f-row">${this.confirmBtn('leave', alone ? 'Disband crew' : 'Leave crew', alone ? 'Click again to disband' : 'Click again to leave', 'secondary danger', 'data-leave')}
      ${leaveNote ? `<small class="f-muted">${leaveNote}</small>` : ''}</div></section>`;

    return `<div class="f-grid"><div class="f-col">${head}${members}</div><div class="f-col">${raid}${bankHtml}${leave}</div></div>`;
  }
}
