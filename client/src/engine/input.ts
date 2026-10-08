/** Minimal keyboard/mouse state. Movement code reads it each frame. */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  buttons = 0;
  private pressedButtons = 0;
  pointerLocked = false;

  constructor(private target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
      if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => {
      this.down.clear();
      this.buttons = 0;
    });
    target.addEventListener('mousedown', (e) => {
      this.buttons |= 1 << e.button;
      this.pressedButtons |= 1 << e.button;
    });
    window.addEventListener('mouseup', (e) => (this.buttons &= ~(1 << e.button)));
    window.addEventListener('mousemove', (e) => {
      if (this.pointerLocked || this.buttons) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    target.addEventListener('wheel', (e) => (this.wheel += Math.sign(e.deltaY)), { passive: true });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => (this.pointerLocked = document.pointerLockElement === this.target));
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }
  mousePressed(button: number): boolean {
    return (this.pressedButtons & (1 << button)) !== 0;
  }
  requestPointerLock(): void {
    this.target.requestPointerLock?.();
  }
  /** Call at the end of every frame. */
  endFrame(): void {
    this.pressed.clear();
    this.pressedButtons = 0;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}
