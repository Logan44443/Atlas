import controlsData from '@data/controls.json';
import type { Input } from './input';
import type { ElementId } from '@shared/combat';

export type ActionId = (typeof controlsData.actions)[number]['id'];

export interface ActionDef {
  id: ActionId;
  label: string;
  group: string;
  keys: string[];
}

export const ACTIONS = controlsData.actions as ActionDef[];
export const RESERVED = new Set(controlsData.reserved);

export interface PlayerSettings {
  name: string;
  bindings: Record<string, string[]>;
  mouseSensitivity: number;
  invertY: boolean;
  /** Temporary until character creation (Phase 6) makes the element permanent per character. */
  element: ElementId;
}

const KEY = 'fw.settings';

function defaults(): PlayerSettings {
  const bindings: Record<string, string[]> = {};
  for (const a of ACTIONS) bindings[a.id] = [...a.keys];
  return { name: '', bindings, mouseSensitivity: controlsData.mouseSensitivity, invertY: controlsData.invertY, element: 'fire' };
}

export function defaultBindings(): Record<string, string[]> {
  return defaults().bindings;
}

/** Validates a display name. Returns an error message or null. Server re-validates once accounts exist. */
export { validateName, randomName } from '@shared/names';
import { randomName, validateName } from '@shared/names';

type Listener = (s: PlayerSettings) => void;

/** Player settings (name, rebinds, mouse). Stored locally until accounts exist (Phase 6). */
export class Settings {
  data: PlayerSettings;
  private listeners: Listener[] = [];

  constructor() {
    const d = defaults();
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<PlayerSettings>;
        // Merge so new actions added to controls.json get their defaults.
        d.name = typeof saved.name === 'string' ? saved.name : '';
        d.mouseSensitivity = saved.mouseSensitivity ?? d.mouseSensitivity;
        d.invertY = saved.invertY ?? d.invertY;
        if (saved.element && ['fire', 'water', 'earth', 'air'].includes(saved.element)) d.element = saved.element;
        for (const a of ACTIONS) if (Array.isArray(saved.bindings?.[a.id])) d.bindings[a.id] = saved.bindings![a.id].slice(0, 2);
      }
    } catch {
      /* corrupt or blocked storage: use defaults */
    }
    if (validateName(d.name)) d.name = randomName();
    this.data = d;
  }

  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* ignore */
    }
    for (const l of this.listeners) l(this.data);
  }

  onChange(l: Listener): void {
    this.listeners.push(l);
  }

  /** Other actions already using `code`. */
  conflicts(code: string, except: string): string[] {
    return ACTIONS.filter((a) => a.id !== except && this.data.bindings[a.id]?.includes(code)).map((a) => a.id);
  }
}

/** Action-level view over raw Input using the player's bindings. */
export class Controls {
  constructor(private input: Input, private settings: Settings) {}
  private keys(a: ActionId): string[] {
    return this.settings.data.bindings[a] ?? [];
  }
  down(a: ActionId): boolean {
    return this.keys(a).some((k) => this.input.isDown(k));
  }
  pressed(a: ActionId): boolean {
    return this.keys(a).some((k) => this.input.wasPressed(k));
  }
  doubleTapped(a: ActionId, windowSec: number): boolean {
    return this.keys(a).some((k) => this.input.doubleTapped(k, windowSec));
  }
}

const NAMES: Record<string, string> = {
  Mouse0: 'Left click', Mouse1: 'Middle click', Mouse2: 'Right click', Mouse3: 'Mouse 4', Mouse4: 'Mouse 5',
  Space: 'Space', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', AltLeft: 'Left Alt', AltRight: 'Right Alt',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Tab: 'Tab', Backquote: '`', CapsLock: 'Caps Lock',
};
export function keyLabel(code: string): string {
  if (NAMES[code]) return NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}
