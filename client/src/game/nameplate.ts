import * as THREE from 'three/webgpu';

/** Billboard name tag drawn to a canvas texture. */
export class Nameplate {
  readonly sprite: THREE.Sprite;
  private canvas = document.createElement('canvas');
  private tex: THREE.CanvasTexture;

  constructor(name: string, color = '#ffffff') {
    this.canvas.width = 256;
    this.canvas.height = 64;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteNodeMaterial({ map: this.tex, transparent: true, depthWrite: false });
    mat.fog = false;
    this.sprite = new THREE.Sprite(mat);
    this.sprite.scale.set(1.6, 0.4, 1);
    this.sprite.position.y = 2.15;
    this.sprite.renderOrder = 20;
    this.set(name, color);
  }

  set(name: string, color = '#ffffff'): void {
    const c = this.canvas.getContext('2d')!;
    c.clearRect(0, 0, 256, 64);
    c.font = '600 30px ui-sans-serif, system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineWidth = 6;
    c.strokeStyle = 'rgba(0,0,0,0.65)';
    c.strokeText(name, 128, 32);
    c.fillStyle = color;
    c.fillText(name, 128, 32);
    this.tex.needsUpdate = true;
  }
}
