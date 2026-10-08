import * as THREE from 'three/webgpu';
import type { ElementId } from '@shared/combat';
import type { SimEntity } from '@shared/sim/combatSim';
import type { PartyInfo } from '@shared/net';
import {
  PROG, TIER_POINTS, branchPoints, cannotRaise, pointsEarned, pointsSpent, treeFor, xpToNext, type Progress,
} from '@shared/progression';
import type { CombatHost, XpGain } from '../game/combat/host';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const ELEMENT_NAME: Record<ElementId, string> = { fire: 'Fire', water: 'Water', earth: 'Earth', air: 'Air' };

/** Level + XP bar under the ability bar, "+XP" toasts and the level-up banner. */
export class XpHud {
  private root = document.createElement('div');
  private fill: HTMLDivElement;
  private lv: HTMLSpanElement;
  private txt: HTMLSpanElement;
  private points: HTMLSpanElement;
  private toasts = document.createElement('div');
  private banner = document.createElement('div');
  private bannerT = 0;
  private key = '';

  constructor(private masteryKey: () => string) {
    this.root.className = 'xp-hud';
    this.root.innerHTML = `<span class="xp-lv"></span><div class="xp-bar"><div class="fill"></div><span class="xp-t"></span></div><span class="xp-points hidden"></span>`;
    this.fill = this.root.querySelector('.fill')!;
    this.lv = this.root.querySelector('.xp-lv')!;
    this.txt = this.root.querySelector('.xp-t')!;
    this.points = this.root.querySelector('.xp-points')!;
    this.toasts.className = 'xp-toasts';
    this.banner.className = 'levelup hidden';
    document.body.append(this.root, this.toasts, this.banner);
  }

  gain(g: XpGain, p: Progress): void {
    const t = document.createElement('div');
    t.className = `xp-toast${g.amount > 0 ? '' : ' none'}`;
    t.innerHTML = g.amount > 0 ? `<b>+${g.amount} XP</b> ${esc(g.reason)}` : esc(g.reason);
    this.toasts.prepend(t);
    while (this.toasts.children.length > 5) this.toasts.lastElementChild?.remove();
    setTimeout(() => t.classList.add('fade'), 2200);
    setTimeout(() => t.remove(), 3000);
    if (g.levelUp) {
      const free = pointsEarned(p.level) - pointsSpent(p.mastery);
      this.banner.innerHTML = `<b>Level ${p.level}</b><span>+${g.levelUp * PROG.pointsPerLevel} mastery point${g.levelUp > 1 ? 's' : ''} · ${free} to spend · press ${esc(this.masteryKey())}</span>`;
      this.banner.className = 'levelup';
      this.bannerT = 4;
    }
  }

  update(dt: number, p: Progress): void {
    const next = xpToNext(p.level);
    const free = pointsEarned(p.level) - pointsSpent(p.mastery);
    const key = `${p.level}:${p.xp}:${free}`;
    if (key !== this.key) {
      this.key = key;
      this.lv.textContent = `Lv ${p.level}`;
      this.fill.style.width = next ? `${Math.min(100, (p.xp / next) * 100)}%` : '100%';
      this.txt.textContent = next ? `${p.xp} / ${next} XP` : 'Max level';
      this.points.textContent = `${free} mastery point${free === 1 ? '' : 's'} · ${this.masteryKey()}`;
      this.points.classList.toggle('hidden', free <= 0);
    }
    if (this.bannerT > 0 && (this.bannerT -= dt) <= 0) this.banner.classList.add('hidden');
  }
}

/** The mastery tree: 3 branches per element, click a skill to spend a point. */
export class MasteryPanel {
  private el = document.createElement('div');
  private key = '';
  isOpen = false;

  constructor(private host: () => CombatHost, private onOpenChange: (open: boolean) => void) {
    this.el.className = 'mastery hidden';
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('mousedown', (e) => e.stopPropagation());
    document.body.appendChild(this.el);
  }

  toggle(open = !this.isOpen): void {
    this.isOpen = open;
    this.el.classList.toggle('hidden', !open);
    this.key = '';
    if (open && document.pointerLockElement) document.exitPointerLock();
    this.onOpenChange(open);
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-node],[data-respec],[data-close]');
    if (!t) {
      if (e.target === this.el) this.toggle(false);
      return;
    }
    const h = this.host();
    if (t.dataset.close !== undefined) return this.toggle(false);
    if (t.dataset.respec !== undefined) return h.respec();
    const id = t.dataset.node!;
    const el = h.me.element;
    if (!el || cannotRaise(el, h.progress.level, h.progress.mastery, id)) return;
    h.setMastery({ ...h.progress.mastery, [id]: (h.progress.mastery[id] ?? 0) + 1 });
  }

  update(): void {
    if (!this.isOpen) return;
    const h = this.host();
    const el = h.me.element;
    const p = h.progress;
    const key = JSON.stringify([el, p.level, p.mastery]);
    if (!el || key === this.key) return;
    this.key = key;
    const earned = pointsEarned(p.level);
    const free = earned - pointsSpent(p.mastery);
    const branches = treeFor(el)
      .map((b) => {
        const spent = branchPoints(b, p.mastery);
        const tiers = TIER_POINTS.map((need, tier) => {
          const nodes = b.nodes
            .filter((n) => n.tier === tier)
            .map((n) => {
              const r = p.mastery[n.id] ?? 0;
              const why = cannotRaise(el, p.level, p.mastery, n.id);
              const state = r >= n.max ? 'maxed' : why === null ? 'open' : why.startsWith('Needs') ? 'locked' : r > 0 ? 'some' : 'idle';
              return `<button class="m-node ${state}" data-node="${n.id}" title="${esc(why ?? 'Click to add a point')}"><b>${esc(n.name)}</b><small>${esc(n.text)}</small><span class="m-rank">${r}/${n.max}</span></button>`;
            })
            .join('');
          return `<div class="m-tier${spent >= need ? '' : ' locked'}">${tier ? `<span class="m-req">${need}+</span>` : ''}${nodes}</div>`;
        }).join('');
        return `<div class="m-branch"><div class="m-bname">${esc(b.name)} <small>${spent} pts</small></div><div class="m-btext">${esc(b.text)}</div>${tiers}</div>`;
      })
      .join('');
    const cost = PROG.respecGold ? `${PROG.respecGold} gold` : 'free';
    this.el.innerHTML = `<div class="m-panel">
      <div class="m-head"><div><b>${ELEMENT_NAME[el]} mastery</b><span>Level ${p.level} · <b class="${free ? 'free' : ''}">${free}</b> of ${earned} points to spend · +${Math.round((p.level - 1) * PROG.powerPerLevel * 100)}% bending power</span></div>
        <div class="m-btns"><button class="secondary" data-respec ${pointsSpent(p.mastery) ? '' : 'disabled'}>Reset points (${cost})</button><button class="secondary" data-close>Close</button></div></div>
      <div class="m-branches">${branches}</div>
      <div class="m-foot">Click a skill to spend a point. Deeper rows unlock after spending points in that branch. You earn ${PROG.pointsPerLevel} point per level.</div>
    </div>`;
  }
}

/** Party frame (members, health, distance), invite prompt, and the invite action. */
export class PartyUi {
  private frame = document.createElement('div');
  private prompt = document.createElement('div');
  private key = '';
  private inviteT = 0;
  private inviteName = '';

  constructor(private host: () => CombatHost) {
    this.frame.className = 'party hidden';
    this.prompt.className = 'invite hidden';
    this.frame.addEventListener('mousedown', (e) => e.stopPropagation());
    this.prompt.addEventListener('mousedown', (e) => e.stopPropagation());
    this.frame.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-leave],[data-kick]');
      if (!t) return;
      if (t.dataset.leave !== undefined) this.host().leaveParty();
      else this.host().kick(t.dataset.kick!);
    });
    this.prompt.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-answer]');
      if (t) this.answer(t.dataset.answer === 'yes');
    });
    document.body.append(this.frame, this.prompt);
  }

  get pendingInvite(): boolean {
    return this.inviteT > 0;
  }

  answer(yes: boolean): void {
    if (this.inviteT <= 0) return;
    this.host().answerInvite(yes);
    this.inviteT = 0;
    this.prompt.classList.add('hidden');
  }

  /** Invite the player you're looking at (or the nearest one in range). */
  inviteLookedAt(camera: THREE.Camera): string | null {
    const h = this.host();
    const me = h.me;
    const dir = camera.getWorldDirection(new THREE.Vector3());
    let best: SimEntity | null = null;
    let bestScore = -Infinity;
    for (const e of h.entities.values()) {
      if (e.kind !== 'player' || e.id === me.id) continue;
      const d = e.pos.distanceTo(me.pos);
      if (d > PROG.party.inviteRange) continue;
      const to = e.pos.clone().sub(camera.position).normalize();
      const score = to.dot(dir) * 10 - d * 0.1;
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    if (!best) return null;
    h.invite(best.id);
    return best.name;
  }

  update(dt: number, keys: { accept: string; decline: string }): void {
    const h = this.host();
    for (const inv of h.invites.splice(0)) {
      this.inviteT = inv.expires;
      this.inviteName = inv.name;
      this.prompt.innerHTML = `<div><b>${esc(inv.name)}</b> invites you to their party</div>
        <div class="row"><button class="primary" data-answer="yes">Accept (${esc(keys.accept)})</button><button class="secondary" data-answer="no">Decline (${esc(keys.decline)})</button></div>`;
      this.prompt.classList.remove('hidden');
    }
    if (this.inviteT > 0 && (this.inviteT -= dt) <= 0) this.prompt.classList.add('hidden');
    this.render(h.party, h.me);
  }

  private render(party: PartyInfo | null, me: SimEntity): void {
    const key = party ? JSON.stringify([party, Math.round(me.pos.x / 5), Math.round(me.pos.z / 5)]) : '';
    if (key === this.key) return;
    this.key = key;
    this.frame.classList.toggle('hidden', !party);
    if (!party) return;
    const lead = party.leader === me.id;
    this.frame.innerHTML =
      `<div class="p-head"><b>Party</b> <small>${party.members.length}/${PROG.party.maxSize}</small><button class="link" data-leave>Leave</button></div>` +
      party.members
        .map((m) => {
          const d = Math.round(Math.hypot(m.x - me.pos.x, m.z - me.pos.z));
          const far = d > PROG.party.shareRadius;
          return `<div class="p-member${m.dead ? ' dead' : ''}${far ? ' far' : ''}">
            <div class="p-top"><span class="p-name">${m.id === party.leader ? '👑 ' : ''}${esc(m.name)}</span><span class="p-lv">Lv ${m.level}</span>
            ${m.id === me.id ? '' : `<span class="p-dist" title="${far ? 'Too far to share XP' : 'Sharing XP'}">${d} m</span>`}
            ${lead && m.id !== me.id ? `<button class="link" data-kick="${m.id}" title="Remove">✕</button>` : ''}</div>
            <div class="bar"><div class="fill hp" style="width:${m.maxHp ? (m.hp / m.maxHp) * 100 : 0}%"></div></div></div>`;
        })
        .join('');
  }

  /** Party member ids (for green nameplates). */
  memberIds(): Set<string> {
    return new Set(this.host().party?.members.map((m) => m.id) ?? []);
  }

  get inviterName(): string {
    return this.inviteName;
  }
}
