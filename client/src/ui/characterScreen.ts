import type { ElementId } from '@shared/combat';
import { FACTIONS, SIDES, type FactionId, type Side } from '@shared/factions';
import { validateName, randomName } from '@shared/names';
import { ApiError, type AccountClient, type Character } from '../net/account';

const ELEMENTS: Array<{ id: ElementId; icon: string; name: string; text: string }> = [
  { id: 'water', icon: '💧', name: 'Water', text: 'Control and sustain. Strongest near water, at night and under a full moon.' },
  { id: 'earth', icon: '⛰️', name: 'Earth', text: 'Tank and zone control. Must stay on the ground; stronger standing on rock.' },
  { id: 'fire', icon: '🔥', name: 'Fire', text: 'Burst damage. Stronger in daytime, peaking at noon.' },
  { id: 'air', icon: '🌀', name: 'Air', text: 'Speed and evasion. Highest mobility, lowest damage.' },
];
const ELEMENT_ICON = Object.fromEntries(ELEMENTS.map((e) => [e.id, e.icon])) as Record<ElementId, string>;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Title screen: account line, character slots, character creation (name,
 * element, faction). Resolves with the character the player picks.
 */
export class CharacterScreen {
  private el = document.createElement('div');
  private view: 'list' | 'create' | 'auth' = 'list';
  private authMode: 'register' | 'login' = 'register';
  private draft = { name: randomName(), element: null as ElementId | null, faction: null as FactionId | null };
  private error = '';
  private busy = false;
  private resolve!: (c: Character) => void;

  constructor(private account: AccountClient) {
    this.el.className = 'charscreen';
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
  }

  /** Shows the screen until a character is chosen. */
  pick(): Promise<Character> {
    document.body.appendChild(this.el);
    this.view = this.account.characters.length ? 'list' : 'create';
    this.render();
    return new Promise((r) => (this.resolve = r));
  }

  close(): void {
    this.el.remove();
  }

  private accountLine(): string {
    const a = this.account;
    if (!a.online) return `<span class="muted">Offline: no server found, characters are saved in this browser.</span>`;
    if (a.account?.guest) return `Playing as a guest. <button class="link" data-auth="register">Create an account</button> to keep your characters on any device, or <button class="link" data-auth="login">sign in</button>.`;
    return `Signed in as <b>${esc(a.account?.username ?? '')}</b>. <button class="link" data-logout>Sign out</button>`;
  }

  private render(): void {
    let body = '';
    if (this.view === 'list') {
      const chars = this.account.characters;
      body = `<h2>Choose your character</h2><div class="slots">` +
        chars
          .map((c) => {
            const f = FACTIONS.find((x) => x.id === c.faction);
            return `<div class="slot-card" style="--fc:${f?.color ?? '#888'}">
              <div class="sc-top"><span class="sc-el">${ELEMENT_ICON[c.element]}</span><span class="sc-name">${esc(c.name)}</span><span class="sc-lv">Lv ${c.level}</span></div>
              <div class="sc-fac">${f?.emblem ?? ''} ${esc(f?.name ?? c.faction)}</div>
              <div class="sc-btns"><button class="primary" data-play="${c.id}">Play</button><button class="secondary" data-del="${c.id}">Delete</button></div>
            </div>`;
          })
          .join('') +
        (chars.length < this.account.maxSlots ? `<button class="slot-card new" data-new>+ New character<small>${chars.length}/${this.account.maxSlots} slots</small></button>` : '') +
        `</div>`;
    } else if (this.view === 'create') {
      const d = this.draft;
      const sides: Side[] = ['order', 'outlaw'];
      body = `<h2>Create a character</h2>
        <label class="field"><span>Name</span><div class="name-row">
          <input id="cs-name" maxlength="16" value="${esc(d.name)}" autocomplete="off" spellcheck="false" />
          <button class="secondary" data-rand title="Random name">🎲</button></div></label>
        <div class="field"><span>Element <small>(permanent for this character)</small></span><div class="el-grid">` +
        ELEMENTS.map((e) => `<button class="pick el-${e.id} ${d.element === e.id ? 'on' : ''}" data-el="${e.id}"><b>${e.icon} ${e.name}</b><small>${e.text}</small></button>`).join('') +
        `</div></div>
        <div class="field"><span>Faction <small>(you can switch later, at a cost)</small></span><div class="fac-cols">` +
        sides
          .map(
            (s) =>
              `<div class="fac-col"><div class="side" style="color:${SIDES[s].color}">${SIDES[s].name}</div>` +
              FACTIONS.filter((f) => f.side === s)
                .map((f) => `<button class="pick fac ${d.faction === f.id ? 'on' : ''}" data-fac="${f.id}" style="--fc:${f.color}"><b>${f.emblem} ${esc(f.name)}</b><small>${esc(f.identity)}</small><small class="perk">${esc(f.perk.text)}</small></button>`)
                .join('') +
              `</div>`,
          )
          .join('') +
        `</div></div>
        <div class="row-end">${this.account.characters.length ? '<button class="secondary" data-back>Back</button>' : ''}<button class="primary" data-create ${this.busy ? 'disabled' : ''}>Create</button></div>`;
    } else {
      const reg = this.authMode === 'register';
      body = `<h2>${reg ? 'Create an account' : 'Sign in'}</h2>
        ${reg && this.account.account?.guest ? '<p class="muted">Your guest characters move to the new account.</p>' : ''}
        <label class="field"><span>Username</span><input id="cs-user" maxlength="20" autocomplete="username" /></label>
        <label class="field"><span>Password</span><input id="cs-pass" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" /></label>
        <div class="row-end"><button class="secondary" data-back>Back</button><button class="primary" data-submit ${this.busy ? 'disabled' : ''}>${reg ? 'Create account' : 'Sign in'}</button></div>`;
    }
    this.el.innerHTML = `<div class="cs-panel"><div class="cs-title">Four Winds</div><div class="cs-account">${this.accountLine()}</div>${body}<div class="err">${esc(this.error)}</div></div>`;
    this.wire();
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    try {
      await fn();
    } catch (e) {
      this.error = e instanceof ApiError || e instanceof Error ? e.message : String(e);
    }
    this.busy = false;
    this.render();
  }

  private wire(): void {
    const $ = <T extends HTMLElement>(s: string) => this.el.querySelector(s) as T | null;
    const on = (sel: string, fn: (b: HTMLElement) => void) => this.el.querySelectorAll<HTMLElement>(sel).forEach((b) => b.addEventListener('click', () => fn(b)));
    on('[data-play]', (b) => {
      const c = this.account.characters.find((x) => x.id === b.dataset.play);
      if (c) this.resolve(c);
    });
    on('[data-del]', (b) => {
      const c = this.account.characters.find((x) => x.id === b.dataset.del);
      if (c && confirm(`Delete ${c.name} forever?`)) void this.run(() => this.account.remove(c.id));
    });
    on('[data-new]', () => {
      this.view = 'create';
      this.error = '';
      this.render();
    });
    on('[data-back]', () => {
      this.view = 'list';
      this.error = '';
      this.render();
    });
    on('[data-auth]', (b) => {
      this.authMode = b.dataset.auth as 'register' | 'login';
      this.view = 'auth';
      this.error = '';
      this.render();
    });
    on('[data-logout]', () => void this.run(async () => {
      await this.account.logout();
      this.view = this.account.characters.length ? 'list' : 'create';
    }));
    on('[data-rand]', () => {
      this.draft.name = randomName();
      this.render();
    });
    on('[data-el]', (b) => {
      this.syncName();
      this.draft.element = b.dataset.el as ElementId;
      this.render();
    });
    on('[data-fac]', (b) => {
      this.syncName();
      this.draft.faction = b.dataset.fac as FactionId;
      this.render();
    });
    on('[data-create]', () => {
      this.syncName();
      const d = this.draft;
      const err = validateName(d.name) ?? (!d.element ? 'Pick an element' : !d.faction ? 'Pick a faction' : null);
      if (err) {
        this.error = err;
        this.render();
        return;
      }
      void this.run(async () => {
        await this.account.create(d.name.trim(), d.element!, d.faction!);
        this.draft = { name: randomName(), element: null, faction: null };
        this.view = 'list';
      });
    });
    on('[data-submit]', () => {
      const u = $<HTMLInputElement>('#cs-user')?.value.trim() ?? '';
      const p = $<HTMLInputElement>('#cs-pass')?.value ?? '';
      void this.run(async () => {
        if (this.authMode === 'register') await this.account.register(u, p);
        else await this.account.login(u, p);
        this.view = this.account.characters.length ? 'list' : 'create';
      });
    });
  }

  private syncName(): void {
    const n = this.el.querySelector<HTMLInputElement>('#cs-name');
    if (n) this.draft.name = n.value;
  }
}
