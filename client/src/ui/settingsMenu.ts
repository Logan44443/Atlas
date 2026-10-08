import { ACTIONS, RESERVED, keyLabel, validateName, defaultBindings, type Settings } from '../engine/settings';
import type { Input } from '../engine/input';
import type { QualitySetting } from '../engine/quality';

export interface SettingsMenuHooks {
  getQuality(): QualitySetting;
  setQuality(q: QualitySetting): void;
  onOpenChange(open: boolean): void;
  characterInfo?(): string;
  onSwitchCharacter?(): void;
}

/** Esc / gear menu: display name, mouse, graphics and full control rebinding. */
export class SettingsMenu {
  readonly el: HTMLDivElement;
  private gear: HTMLButtonElement;
  private tab: 'general' | 'controls' = 'general';
  private listening: { action: string; slot: number } | null = null;
  isOpen = false;

  constructor(private settings: Settings, private input: Input, private hooks: SettingsMenuHooks) {
    this.gear = document.createElement('button');
    this.gear.className = 'gear';
    this.gear.title = 'Settings (Esc)';
    this.gear.setAttribute('aria-label', 'Settings');
    this.gear.textContent = '⚙';
    this.gear.addEventListener('click', () => this.toggle());
    document.body.appendChild(this.gear);

    this.el = document.createElement('div');
    this.el.className = 'settings hidden';
    this.el.addEventListener('mousedown', (e) => e.stopPropagation());
    document.body.appendChild(this.el);

    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape' || this.listening) return;
      // Esc while the mouse is captured only releases it (browser behaviour); the next Esc opens the menu.
      if (this.input.pointerLocked) return;
      e.preventDefault();
      this.toggle();
    });
  }

  toggle(force?: boolean): void {
    this.isOpen = force ?? !this.isOpen;
    this.el.classList.toggle('hidden', !this.isOpen);
    this.input.enabled = !this.isOpen;
    if (this.isOpen) {
      if (document.pointerLockElement) document.exitPointerLock();
      this.render();
    } else {
      this.listening = null;
      this.input.capture = null;
    }
    this.hooks.onOpenChange(this.isOpen);
  }

  private render(): void {
    const d = this.settings.data;
    const tabs = `
      <div class="tabs">
        <button data-tab="general" class="${this.tab === 'general' ? 'on' : ''}">General</button>
        <button data-tab="controls" class="${this.tab === 'controls' ? 'on' : ''}">Controls</button>
        <button class="close" data-close aria-label="Close">✕</button>
      </div>`;
    let body = '';
    if (this.tab === 'general') {
      body = `
        <label class="field"><span>Display name</span>
          <input id="set-name" maxlength="16" value="${escapeHtml(d.name)}" autocomplete="off" spellcheck="false" />
          <small id="set-name-err" class="err"></small>
        </label>
        <div class="field"><span>Character</span>
          <div class="char-line"><span>${escapeHtml(this.hooks.characterInfo?.() ?? '')}</span>
          <button id="set-chars" class="secondary">Switch character</button></div>
        </div>
        <label class="field"><span>Mouse sensitivity <b id="sens-val">${d.mouseSensitivity.toFixed(2)}</b></span>
          <input id="set-sens" type="range" min="0.2" max="3" step="0.05" value="${d.mouseSensitivity}" />
        </label>
        <label class="check"><input id="set-inv" type="checkbox" ${d.invertY ? 'checked' : ''}/> Invert mouse Y</label>
        <label class="field"><span>Graphics quality</span>
          <select id="set-quality">
            ${['auto', 'low', 'medium', 'high'].map((q) => `<option value="${q}" ${this.hooks.getQuality() === q ? 'selected' : ''}>${q[0].toUpperCase() + q.slice(1)}</option>`).join('')}
          </select>
        </label>`;
    } else {
      const groups = [...new Set(ACTIONS.map((a) => a.group))];
      body = `<p class="hint">Click a binding, then press a key or mouse button. Esc cancels, Backspace clears.</p>
        <div class="binds">` +
        groups
          .map(
            (g) =>
              `<div class="group">${g}</div>` +
              ACTIONS.filter((a) => a.group === g)
                .map((a) => {
                  const keys = d.bindings[a.id] ?? [];
                  const slots = [0, 1]
                    .map((slot) => {
                      const k = keys[slot];
                      const listening = this.listening?.action === a.id && this.listening.slot === slot;
                      const conflict = k && this.settings.conflicts(k, a.id).length > 0;
                      return `<button class="bind ${listening ? 'listening' : ''} ${conflict ? 'conflict' : ''}" data-action="${a.id}" data-slot="${slot}" title="${conflict ? 'Also bound to: ' + this.settings.conflicts(k, a.id).join(', ') : ''}">${listening ? 'Press a key…' : k ? keyLabel(k) : '—'}</button>`;
                    })
                    .join('');
                  return `<div class="bind-row"><span>${a.label}</span>${slots}</div>`;
                })
                .join(''),
          )
          .join('') +
        `</div><div class="row-end"><button id="reset-binds" class="secondary">Reset to defaults</button></div>`;
    }
    this.el.innerHTML = `<div class="panel"><h2>Settings</h2>${tabs}<div class="body">${body}</div></div>`;
    this.wire();
  }

  private wire(): void {
    const $ = <T extends HTMLElement>(sel: string) => this.el.querySelector(sel) as T | null;
    this.el.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        this.tab = b.dataset.tab as 'general' | 'controls';
        this.render();
      }),
    );
    $('[data-close]')?.addEventListener('click', () => this.toggle(false));

    const name = $<HTMLInputElement>('#set-name');
    if (name) {
      const err = $<HTMLElement>('#set-name-err')!;
      const check = () => {
        const msg = validateName(name.value);
        err.textContent = msg ?? '';
        name.classList.toggle('bad', !!msg);
        return !msg;
      };
      // Validate while typing; rename on Enter or when the field loses focus.
      const commit = () => {
        const v = name.value.trim().replace(/\s+/g, ' ');
        if (check() && v !== this.settings.data.name) {
          this.settings.data.name = v;
          this.settings.save();
        }
      };
      name.addEventListener('input', check);
      name.addEventListener('change', commit);
      name.addEventListener('keydown', (e) => e.stopPropagation());
    }
    const sens = $<HTMLInputElement>('#set-sens');
    sens?.addEventListener('input', () => {
      this.settings.data.mouseSensitivity = parseFloat(sens.value);
      $('#sens-val')!.textContent = this.settings.data.mouseSensitivity.toFixed(2);
      this.settings.save();
    });
    const inv = $<HTMLInputElement>('#set-inv');
    inv?.addEventListener('change', () => {
      this.settings.data.invertY = inv.checked;
      this.settings.save();
    });
    $('#set-chars')?.addEventListener('click', () => this.hooks.onSwitchCharacter?.());
    const q = $<HTMLSelectElement>('#set-quality');
    q?.addEventListener('change', () => this.hooks.setQuality(q.value as QualitySetting));

    this.el.querySelectorAll<HTMLButtonElement>('.bind').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.preventDefault();
        this.listen(b.dataset.action!, parseInt(b.dataset.slot!, 10));
      }),
    );
    $('#reset-binds')?.addEventListener('click', () => {
      this.settings.data.bindings = defaultBindings();
      this.settings.save();
      this.render();
    });
  }

  private listen(action: string, slot: number): void {
    this.listening = { action, slot };
    this.render();
    // Defer so the click that started listening isn't captured as the binding.
    setTimeout(() => {
      this.input.capture = (code) => {
        this.listening = null;
        if (code === 'Escape') return this.render();
        const keys = [...(this.settings.data.bindings[action] ?? [])];
        if (code === 'Backspace' || code === 'Delete') {
          keys.splice(slot, 1);
        } else if (RESERVED.has(code)) {
          this.render();
          this.flash(`${keyLabel(code)} is reserved`);
          return;
        } else {
          keys[slot] = code;
        }
        this.settings.data.bindings[action] = [...new Set(keys.filter(Boolean))].slice(0, 2);
        this.settings.save();
        this.render();
        const others = this.settings.conflicts(code, action);
        if (others.length) this.flash(`${keyLabel(code)} is also used by ${others.join(', ')}`);
      };
    }, 0);
  }

  private flash(msg: string): void {
    const n = document.createElement('div');
    n.className = 'toast';
    n.textContent = msg;
    this.el.querySelector('.panel')?.appendChild(n);
    setTimeout(() => n.remove(), 2500);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
