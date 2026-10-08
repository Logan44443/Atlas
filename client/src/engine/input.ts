/**
 * Raw keyboard/mouse state. Keys use KeyboardEvent.code; mouse buttons are
 * reported as "Mouse0".."Mouse4" so bindings can mix both freely.
 */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private lastPress = new Map<string, number>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  pointerLocked = false;
  /** When set, the next key/button goes here instead of the game (used for rebinding). */
  capture: ((code: string) => void) | null = null;
  /** Suppress game input (e.g. while a menu is open). */
  enabled = true;

  constructor(private target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (this.capture) {
        e.preventDefault();
        const cb = this.capture;
        this.capture = null;
        cb(e.code);
        return;
      }
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (['Space', 'Tab', 'F2'].includes(e.code)) e.preventDefault();
      this.press(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
    window.addEventListener('mousedown', (e) => {
      const code = `Mouse${e.button}`;
      if (this.capture) {
        e.preventDefault();
        const cb = this.capture;
        this.capture = null;
        cb(code);
        return;
      }
      if (e.target === this.target) this.press(code);
    });
    window.addEventListener('mouseup', (e) => this.down.delete(`Mouse${e.button}`));
    window.addEventListener('mousemove', (e) => {
      if (this.pointerLocked || this.down.has('Mouse0') || this.down.has('Mouse2')) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    target.addEventListener('wheel', (e) => (this.wheel += Math.sign(e.deltaY)), { passive: true });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => (this.pointerLocked = document.pointerLockElement === this.target));
  }

  private press(code: string): void {
    if (!this.down.has(code)) this.pressed.add(code);
    this.down.add(code);
  }

  isDown(code: string): boolean {
    return this.enabled && this.down.has(code);
  }
  wasPressed(code: string): boolean {
    return this.enabled && this.pressed.has(code);
  }
  /** True if `code` was pressed this frame and also within `window` seconds before. */
  doubleTapped(code: string, windowSec: number): boolean {
    if (!this.wasPressed(code)) return false;
    const now = performance.now();
    const prev = this.lastPress.get(code) ?? -1e9;
    return now - prev < windowSec * 1000;
  }
  requestPointerLock(): void {
    try {
      const p = this.target.requestPointerLock?.() as unknown as Promise<void> | undefined;
      p?.catch?.(() => undefined);
    } catch {
      /* not allowed (e.g. headless) */
    }
  }
  /** Call at the end of every frame. */
  endFrame(): void {
    const now = performance.now();
    for (const c of this.pressed) this.lastPress.set(c, now);
    this.pressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}
