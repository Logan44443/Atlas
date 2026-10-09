import type { ChunkStreamer } from '../world/streamer';

const COLORS: Record<string, string> = {
  near: '#e9f7a8',
  mid: '#6fcf5a',
  far: '#2f7a46',
  building: '#ff9a3c',
  fetching: '#f5d33a',
  cached: '#3a6fd6',
  none: '#151a26',
};

/** Chunk-state debug view (F4). One pixel block per chunk around the player. */
export class ChunkMinimap {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  visible = true;

  constructor(parent: HTMLElement, private streamer: ChunkStreamer, private radius = 12, private cell = 7) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'minimap';
    const px = (radius * 2 + 1) * cell;
    this.canvas.width = px;
    this.canvas.height = px;
    this.canvas.style.width = `${px}px`;
    this.ctx = this.canvas.getContext('2d')!;
    const legend = document.createElement('div');
    legend.className = 'help';
    legend.innerHTML = Object.entries(COLORS)
      .map(([k, c]) => `<span style="color:${c}">■</span> ${k}`)
      .join('  ');
    parent.appendChild(this.canvas);
    parent.appendChild(legend);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F4') {
        this.visible = !this.visible;
        this.canvas.style.display = legend.style.display = this.visible ? '' : 'none';
      }
    });
  }

  draw(x: number, z: number, yaw: number): void {
    if (!this.visible) return;
    const s = this.streamer.size;
    const pcx = Math.floor(x / s);
    const pcz = Math.floor(z / s);
    const { ctx, cell, radius } = this;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        ctx.fillStyle = COLORS[this.streamer.stateOf(pcx + dx, pcz + dz)];
        ctx.fillRect((dx + radius) * cell, (dz + radius) * cell, cell - 1, cell - 1);
      }
    }
    // Player marker + facing.
    const px = (radius + (x / s - pcx)) * cell;
    const pz = (radius + (z / s - pcz)) * cell;
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#ff4d6d';
    ctx.beginPath();
    ctx.arc(px, pz, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(px, pz);
    ctx.lineTo(px - Math.sin(yaw) * 12, pz - Math.cos(yaw) * 12);
    ctx.stroke();
    const v = this.streamer.velocityVec;
    if (v.lengthSq() > 1) {
      ctx.strokeStyle = '#5ad1ff';
      ctx.beginPath();
      ctx.moveTo(px, pz);
      const l = Math.min(v.length() / 4, 30);
      ctx.lineTo(px + (v.x / v.length()) * l, pz + (v.z / v.length()) * l);
      ctx.stroke();
    }
  }
}
