import './worldMap.css';
import { TerrainSampler, hexToLinear, type RGB, type TerrainConfig } from '@shared/terrain';
import { clamp, smoothstep } from '@shared/noise';
import { FACTIONS, PLOTS, SIDES, factionById, terrainConfig, type Faction } from '@shared/factions';
import { POINTS, type WarPoint } from '@shared/territory';
import { ARTS, type ArtDef } from '@shared/arts';
import bossData from '@data/bosses.json';
import worldData from '@data/world.json';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface WorldMapState {
  me: { x: number; z: number; yaw: number };
  party?: Array<{ name: string; x: number; z: number }>;
  /** territory point states: id matches POINTS[i].id; owner = faction id or '' */
  points?: Array<{ id: string; owner: string; progress: number; capSide: string; heldSince: number }>;
  /** plot ids (PLOTS[i].id) that have a crew hall, with the crew tag */
  takenPlots?: Array<{ id: string; tag: string; faction: string }>;
  camp?: { x: number; z: number } | null;
  hall?: { x: number; z: number; name: string } | null;
  target?: { x: number; z: number; name: string } | null;
  /** "Territory war: 32 m left" style line shown in the title bar */
  warText?: string;
}

/** The fields of data/bosses.json the map needs (BossDef lives in the sim; this keeps the map light). */
interface BossSpot {
  id: string;
  name: string;
  tier: 'mini' | 'world' | 'legendary';
  element: string;
  level: number;
  x: number;
  z: number;
  arena: number;
  respawnSeconds?: number;
  schedule?: { everyMinutes: number; offsetMinutes: number; upMinutes: number; nightOnly?: boolean };
}
const BOSS_SPOTS = bossData.bosses as unknown as BossSpot[];
const MASTERS = ARTS.filter((a): a is ArtDef & { master: NonNullable<ArtDef['master']> } => !!a.master);

const HALF = (worldData.worldChunks * worldData.chunkSize) / 2;
/** Base layer samples per side (~10.7 m each). */
const RES = 384;
/** Base layer work per animation frame while it builds. */
const BUILD_BUDGET_MS = 20;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
/** Dynamic redraws at most every this many ms while open. */
const DRAW_EVERY_MS = 100;

const DEEP = worldData.water.deepColor;
const NOBODY = '#e6e9f0';
const EL_COLOR: Record<string, string> = { fire: '#ff7a3a', water: '#4fb6f0', earth: '#8bbf4a', air: '#f0d27a', any: '#c9a7ff' };
const BOSS_STYLE: Record<BossSpot['tier'], { r: number; color: string; label: string }> = {
  mini: { r: 6, color: '#e8a25a', label: 'Rare beast' },
  world: { r: 8, color: '#ff6a4a', label: 'World boss' },
  legendary: { r: 10, color: '#ffd76a', label: 'Legendary world boss' },
};
const ME = '#ff4d6d';
const PARTY = '#9fe39a';
const CAMP = '#ff9a3c';
const HALL = '#ffd76a';
const TARGET = '#7fd8ff';
const OUTLINE = 'rgba(8, 10, 18, 0.9)';

// ---- formatting ------------------------------------------------------------------------

const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
function span(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m >= 24 * 60) return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} m` : `${m} m`;
}
const dist = (d: number): string => (d < 1000 ? `${d.toFixed(0)} m` : `${(d / 1000).toFixed(1)} km`);

/** Minutes until a world/legendary boss rises (0 = up now), from wall time like the sim's bossNextMinutes. */
function bossNext(b: BossSpot, now: number): number {
  const s = b.schedule;
  if (!s) return 0;
  const cycle = s.everyMinutes * 60_000;
  const into = ((((now - s.offsetMinutes * 60_000) % cycle) + cycle) % cycle);
  return into < s.upMinutes * 60_000 ? 0 : Math.ceil((cycle - into) / 60_000);
}

// ---- base layer ------------------------------------------------------------------------

type Flat = NonNullable<TerrainConfig['flats']>[number];

const toSrgb = (v: number): number => {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(c * 255);
};
// Hill-shade light from the north-west (screen top-left), fairly high.
const LIGHT = (() => {
  const l = Math.hypot(-1, 1.6, -1);
  return { x: -1 / l, y: 1.6 / l, z: -1 / l };
})();

/**
 * Terrain colour + water depth + hill shading for the whole world, one sample
 * per ~10 m. Built in time slices (rows top to bottom) the first time the map
 * opens, then kept as an offscreen canvas.
 */
class BaseLayer {
  readonly canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  private heights: Float32Array | null = new Float32Array(RES * RES);
  /** `full` knows the levelled sites; `bare` skips them and is ~3x faster, so it samples everywhere a site can't reach. */
  private full: TerrainSampler | null = null;
  private bare: TerrainSampler | null = null;
  private flats: Flat[] = terrainConfig().flats ?? [];
  private hRow = 0;
  private cRow = 0;
  /** compute time spent so far (ms) */
  ms = 0;
  private shallow = hexToLinear(worldData.water.shallowColor);
  private deep = hexToLinear(worldData.water.deepColor);
  private shore = hexToLinear(worldData.colors.seabed);

  constructor() {
    this.canvas.width = this.canvas.height = RES;
    this.ctx = this.canvas.getContext('2d')!;
    this.img = this.ctx.createImageData(RES, RES);
  }

  get done(): boolean {
    return this.cRow >= RES;
  }
  get progress(): number {
    return this.cRow / RES;
  }

  /** Work for up to `budget` ms. Returns true when new rows landed on the canvas. */
  step(budget: number): boolean {
    if (this.done) return false;
    const t0 = performance.now();
    this.full ??= new TerrainSampler(terrainConfig());
    this.bare ??= new TerrainSampler({ ...terrainConfig(), flats: [] });
    const from = this.cRow;
    while (this.cRow < RES && performance.now() - t0 < budget) {
      // Shading needs the row below, so heights run one row ahead.
      while (this.hRow < Math.min(RES, this.cRow + 2)) this.heightRow(this.hRow++);
      this.colourRow(this.cRow++);
    }
    this.ctx.putImageData(this.img, 0, 0, 0, from, RES, this.cRow - from);
    this.ms += performance.now() - t0;
    if (this.done) {
      this.heights = null;
      this.full = this.bare = null;
    }
    return this.cRow > from;
  }

  /** Sampler for (x, row): `full` only inside the square around a levelled site (both give the same answer outside). */
  private samplerAt(x: number, near: Flat[]): TerrainSampler {
    for (const f of near) if (Math.abs(x - f.x) < f.radius + f.blend) return this.full!;
    return this.bare!;
  }
  private rowFlats(z: number): Flat[] {
    return this.flats.filter((f) => Math.abs(z - f.z) < f.radius + f.blend);
  }

  private heightRow(j: number): void {
    const H = this.heights!;
    const step = (2 * HALF) / RES;
    const z = -HALF + (j + 0.5) * step;
    const near = this.rowFlats(z);
    for (let i = 0; i < RES; i++) {
      const x = -HALF + (i + 0.5) * step;
      H[j * RES + i] = this.samplerAt(x, near).height(x, z);
    }
  }

  private colourRow(j: number): void {
    const H = this.heights!;
    const d = this.img.data;
    const step = (2 * HALF) / RES;
    const sea = worldData.seaLevel;
    const z = -HALF + (j + 0.5) * step;
    const near = this.rowFlats(z);
    const up = Math.max(0, j - 1) * RES;
    const down = Math.min(RES - 1, j + 1) * RES;
    const col: RGB = [0, 0, 0];
    for (let i = 0; i < RES; i++) {
      const x = -HALF + (i + 0.5) * step;
      const h = H[j * RES + i];
      const o = (j * RES + i) * 4;
      if (h < sea) {
        // Water: shallow -> deep with depth, a sandy tint right at the shore.
        const t = smoothstep(0, 22, sea - h);
        for (let c = 0; c < 3; c++) col[c] = this.shallow[c] + (this.deep[c] - this.shallow[c]) * t;
        const sh = (1 - clamp((sea - h) / 1.6, 0, 1)) * 0.35;
        for (let c = 0; c < 3; c++) col[c] += (this.shore[c] - col[c]) * sh;
      } else {
        const dx = (H[j * RES + Math.min(RES - 1, i + 1)] - H[j * RES + Math.max(0, i - 1)]) / (2 * step);
        const dz = (H[down + i] - H[up + i]) / (2 * step);
        this.samplerAt(x, near).color(x, z, h, 1 / Math.sqrt(1 + dx * dx + dz * dz), col);
        // Hill shading: exaggerated normal against a north-west light, relative to flat ground.
        const nx = -dx * 2.5;
        const nz = -dz * 2.5;
        const lam = (nx * LIGHT.x + LIGHT.y + nz * LIGHT.z) / Math.sqrt(nx * nx + 1 + nz * nz);
        const k = clamp(1 + (lam / LIGHT.y - 1) * 0.9, 0.45, 1.3);
        for (let c = 0; c < 3; c++) col[c] *= k;
      }
      d[o] = toSrgb(col[0]);
      d[o + 1] = toSrgb(col[1]);
      d[o + 2] = toSrgb(col[2]);
      d[o + 3] = 255;
    }
  }
}

// ---- marker shapes (shared by the map and the legend) ---------------------------------

type Ctx = CanvasRenderingContext2D;

function shape(ctx: Ctx, fill: string, stroke = OUTLINE, lw = 1.5): void {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = lw;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}
function dot(ctx: Ctx, x: number, y: number, r: number, fill: string, stroke = OUTLINE, lw = 1.5): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  shape(ctx, fill, stroke, lw);
}
function diamond(ctx: Ctx, x: number, y: number, r: number, fill: string): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r * 0.8, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r * 0.8, y);
  ctx.closePath();
  shape(ctx, fill);
}
function triangle(ctx: Ctx, x: number, y: number, r: number, fill: string): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r * 0.9, y + r * 0.7);
  ctx.lineTo(x - r * 0.9, y + r * 0.7);
  ctx.closePath();
  shape(ctx, fill);
}
function square(ctx: Ctx, x: number, y: number, r: number, fill: string, stroke: string): void {
  ctx.beginPath();
  ctx.rect(x - r, y - r, r * 2, r * 2);
  shape(ctx, fill, stroke, 1.2);
}
/** n-pointed star; inner = inner radius as a fraction of r. */
function star(ctx: Ctx, x: number, y: number, r: number, n: number, inner: number, fill: string): void {
  ctx.beginPath();
  for (let k = 0; k < n * 2; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / n;
    const rr = k % 2 ? r * inner : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  shape(ctx, fill);
}
/** Player arrow along the facing (screen up = north, same as the chunk minimap). */
function arrow(ctx: Ctx, x: number, y: number, yaw: number, r: number, fill: string): void {
  const fx = -Math.sin(yaw);
  const fy = -Math.cos(yaw);
  ctx.beginPath();
  ctx.moveTo(x + fx * r, y + fy * r);
  ctx.lineTo(x - fx * r * 0.6 - fy * r * 0.65, y - fy * r * 0.6 + fx * r * 0.65);
  ctx.lineTo(x - fx * r * 0.25, y - fy * r * 0.25);
  ctx.lineTo(x - fx * r * 0.6 + fy * r * 0.65, y - fy * r * 0.6 - fx * r * 0.65);
  ctx.closePath();
  shape(ctx, fill, '#fff', 1.8);
}
function house(ctx: Ctx, x: number, y: number, r: number, fill: string): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y - r * 0.15);
  ctx.lineTo(x + r * 0.75, y - r * 0.15);
  ctx.lineTo(x + r * 0.75, y + r * 0.8);
  ctx.lineTo(x - r * 0.75, y + r * 0.8);
  ctx.lineTo(x - r * 0.75, y - r * 0.15);
  ctx.lineTo(x - r, y - r * 0.15);
  ctx.closePath();
  shape(ctx, fill);
}
function campfire(ctx: Ctx, x: number, y: number, r: number): void {
  dot(ctx, x, y, r, '#3a1a08', CAMP, 1.8);
  ctx.beginPath();
  ctx.moveTo(x, y - r * 0.75);
  ctx.quadraticCurveTo(x + r * 0.65, y + r * 0.1, x, y + r * 0.55);
  ctx.quadraticCurveTo(x - r * 0.65, y + r * 0.1, x, y - r * 0.75);
  ctx.fillStyle = '#ffd76a';
  ctx.fill();
}
function hubIcon(ctx: Ctx, x: number, y: number, r: number, f: Faction): void {
  dot(ctx, x, y, r, f.color, f.trim, 2);
  ctx.font = `${Math.round(r * 1.15)}px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(f.emblem, x, y + 0.5);
}
function ring(ctx: Ctx, x: number, y: number, r: number, frac: number, color: string, lw: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.lineWidth = lw + 2;
  ctx.strokeStyle = 'rgba(8, 10, 18, 0.75)';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
  ctx.lineWidth = lw;
  ctx.strokeStyle = color;
  ctx.stroke();
}
function label(ctx: Ctx, text: string, x: number, y: number, color = '#f4efe2', size = 11, weight = 600, align: CanvasTextAlign = 'center'): void {
  ctx.font = `${weight} ${size}px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = OUTLINE;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

interface Hit {
  x: number;
  y: number;
  r: number;
  tip: () => string;
}
type PointState = NonNullable<WorldMapState['points']>[number];

/**
 * Full-screen world map (M): terrain picture, faction hubs, territory points and
 * who holds them, crew plots, arts masters, boss arenas, and the live layer
 * (you, your party, camp, crew hall, quest target). Wheel zooms 1-4x, drag pans,
 * double-click recentres on you. The game owns the key that opens it; the map
 * only handles Escape while open.
 */
export class WorldMap {
  private el = document.createElement('div');
  private body!: HTMLDivElement;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private tip!: HTMLDivElement;
  private warEl!: HTMLSpanElement;
  private zoomEl!: HTMLSpanElement;
  private posEl!: HTMLSpanElement;
  private base: BaseLayer | null = null;
  private pumpId = 0;
  private drawId = 0;
  private opened = false;
  private state: WorldMapState | null = null;
  private zoom = 1;
  private cx = 0;
  private cz = 0;
  private scale = 1;
  private vw = 0;
  private vh = 0;
  private lastDraw = 0;
  private hits: Hit[] = [];
  private labels: Array<{ prio: number; text: string; x: number; y: number; color: string; size: number; weight: number; align: CanvasTextAlign }> = [];
  private hover: { x: number; y: number } | null = null;
  private drag: { id: number; x: number; y: number } | null = null;
  private warText = '';
  private tipHtml = '';
  /** Compute time of the base layer in ms once built (for the debug overlay / tests). */
  baseMs = 0;

  constructor(parent: HTMLElement) {
    this.el.className = 'wmap hidden';
    this.el.innerHTML = `<div class="wm-panel">
      <div class="wm-head"><div class="wm-title"><b>World Map</b><span class="wm-war"></span></div>
        <div class="wm-btns"><button class="wm-z" data-zoom="-1" title="Zoom out">−</button><span class="wm-zoom">1.0×</span><button class="wm-z" data-zoom="1" title="Zoom in">+</button>
          <button data-centre>Centre on me</button><button data-close>Close<kbd>M / Esc</kbd></button></div></div>
      <div class="wm-body"><canvas></canvas><div class="wm-tip hidden"></div></div>
      <div class="wm-legend"></div>
    </div>`;
    this.body = this.el.querySelector('.wm-body')!;
    this.canvas = this.body.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.tip = this.body.querySelector('.wm-tip')!;
    this.warEl = this.el.querySelector('.wm-war')!;
    this.zoomEl = this.el.querySelector('.wm-zoom')!;
    this.buildLegend(this.el.querySelector('.wm-legend')!);
    this.posEl = this.el.querySelector('.wm-pos')!;
    parent.append(this.el);

    // Keep the map's mouse to itself (mouseup/mousemove still bubble so the game's held-button state clears).
    for (const t of ['mousedown', 'pointerdown', 'click', 'dblclick', 'wheel', 'contextmenu'] as const) {
      this.el.addEventListener(t, (e) => e.stopPropagation());
    }
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.posEl.textContent = '';
      this.showTip();
    });
    this.canvas.addEventListener('dblclick', () => this.recentre());
    this.body.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    // Capture phase so the settings menu's Escape handler doesn't also fire.
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.opened || e.code !== 'Escape') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.close();
      },
      true,
    );
  }

  get isOpen(): boolean {
    return this.opened;
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.el.classList.remove('hidden');
    if (document.pointerLockElement) document.exitPointerLock();
    if (this.state) {
      this.cx = this.state.me.x;
      this.cz = this.state.me.z;
    }
    this.base ??= new BaseLayer();
    if (!this.base.done) this.pump();
    this.draw();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.el.classList.add('hidden');
    this.drag = null;
    this.hover = null;
    this.tip.classList.add('hidden');
    cancelAnimationFrame(this.pumpId);
    cancelAnimationFrame(this.drawId);
    this.pumpId = this.drawId = 0;
  }

  toggle(): void {
    if (this.opened) this.close();
    else this.open();
  }

  /** call every frame; cheap when closed */
  update(state: WorldMapState): void {
    this.state = state;
    if (this.opened && performance.now() - this.lastDraw >= DRAW_EVERY_MS) this.draw();
  }

  // ---- base layer build ------------------------------------------------------------

  private pump = (): void => {
    this.pumpId = 0;
    const b = this.base;
    if (!this.opened || !b || b.done) return;
    b.step(BUILD_BUDGET_MS);
    if (b.done) this.baseMs = Math.round(b.ms);
    else this.pumpId = requestAnimationFrame(this.pump);
    // Rows show up as they land, at the normal redraw rate.
    if (b.done || performance.now() - this.lastDraw >= DRAW_EVERY_MS) this.draw();
  };

  // ---- view --------------------------------------------------------------------------

  private sx(x: number): number {
    return this.vw / 2 + (x - this.cx) * this.scale;
  }
  private sy(z: number): number {
    return this.vh / 2 + (z - this.cz) * this.scale;
  }

  /** Keep the world on screen: centre it when it fits, else clamp the pan to its edges. */
  private clampView(): void {
    const hx = this.vw / 2 / this.scale;
    const hz = this.vh / 2 / this.scale;
    this.cx = hx >= HALF ? 0 : clamp(this.cx, -HALF + hx, HALF - hx);
    this.cz = hz >= HALF ? 0 : clamp(this.cz, -HALF + hz, HALF - hz);
  }

  /** Zoom keeping the world point under screen (ax, ay) where it is. */
  private setZoom(z: number, ax = this.vw / 2, ay = this.vh / 2): void {
    z = clamp(z, MIN_ZOOM, MAX_ZOOM);
    if (z === this.zoom || !this.vw) return;
    const wx = this.cx + (ax - this.vw / 2) / this.scale;
    const wz = this.cz + (ay - this.vh / 2) / this.scale;
    this.zoom = z;
    this.scale = (Math.min(this.vw, this.vh) / (2 * HALF)) * z;
    this.cx = wx - (ax - this.vw / 2) / this.scale;
    this.cz = wz - (ay - this.vh / 2) / this.scale;
    this.requestDraw();
  }

  private recentre(): void {
    if (!this.state) return;
    if (this.zoom < 2) this.setZoom(2);
    this.cx = this.state.me.x;
    this.cz = this.state.me.z;
    this.requestDraw();
  }

  private requestDraw(): void {
    if (!this.opened || this.drawId) return;
    this.drawId = requestAnimationFrame(() => {
      this.drawId = 0;
      this.draw();
    });
  }

  // ---- input -------------------------------------------------------------------------

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-zoom],[data-centre],[data-close]');
    if (!t) {
      if (e.target === this.el) this.close();
      return;
    }
    if (t.dataset.close !== undefined) return this.close();
    if (t.dataset.centre !== undefined) return this.recentre();
    this.setZoom(this.zoom * (Number(t.dataset.zoom) > 0 ? 1.5 : 1 / 1.5));
  }

  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    this.canvas.setPointerCapture(e.pointerId);
    this.body.classList.add('dragging');
    this.tip.classList.add('hidden');
  }

  private onMove(e: PointerEvent): void {
    const p = this.local(e);
    this.hover = p;
    this.posEl.textContent = `x ${Math.round(this.cx + (p.x - this.vw / 2) / this.scale)} · z ${Math.round(this.cz + (p.y - this.vh / 2) / this.scale)}`;
    if (this.drag && this.drag.id === e.pointerId) {
      this.cx -= (e.clientX - this.drag.x) / this.scale;
      this.cz -= (e.clientY - this.drag.y) / this.scale;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      this.requestDraw();
      return;
    }
    this.showTip();
  }

  private onUp(e: PointerEvent): void {
    if (!this.drag || this.drag.id !== e.pointerId) return;
    this.drag = null;
    this.body.classList.remove('dragging');
    this.showTip();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const p = this.local(e);
    this.setZoom(this.zoom * Math.exp(-dy * 0.0015), p.x, p.y);
  }

  // ---- tooltip -----------------------------------------------------------------------

  private showTip(): void {
    const p = this.hover;
    let html = '';
    if (p && !this.drag) {
      // Topmost marker under the cursor (dynamic markers are drawn last).
      for (let i = this.hits.length - 1; i >= 0; i--) {
        const h = this.hits[i];
        if (Math.hypot(p.x - h.x, p.y - h.y) <= h.r + 3) {
          html = h.tip();
          break;
        }
      }
      if (!html) html = this.areaTip(this.cx + (p.x - this.vw / 2) / this.scale, this.cz + (p.y - this.vh / 2) / this.scale);
    }
    this.tip.classList.toggle('hidden', !html);
    if (!html || !p) return;
    if (html !== this.tipHtml) this.tip.innerHTML = this.tipHtml = html;
    const w = this.tip.offsetWidth;
    const h = this.tip.offsetHeight;
    const x = p.x + 16 + w > this.vw ? p.x - 12 - w : p.x + 16;
    const y = p.y + 16 + h > this.vh ? p.y - 12 - h : p.y + 16;
    this.tip.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  }

  /** No marker under the cursor: name the safe zone or contested zone it is in. */
  private areaTip(x: number, z: number): string {
    for (const f of FACTIONS) {
      if (Math.hypot(x - f.hub.x, z - f.hub.z) <= f.hub.safeRadius) return `<b style="color:${f.color}">${esc(f.hub.name)}</b><br><small>Safe zone: no PvP</small>`;
    }
    for (const pt of POINTS) {
      if (Math.hypot(x - pt.x, z - pt.z) <= pt.radius) return `<b>${esc(pt.name)}</b><br><small>Contested zone: PvP is always on</small>`;
    }
    return '';
  }

  private pointTip(pt: WarPoint, st: PointState | undefined): string {
    const f = factionById(st?.owner);
    const lines = [`<b>${esc(pt.name)}</b> <small>${pt.kind === 'shrine' ? 'Shrine' : 'Outpost'}</small>`];
    lines.push(f ? `Held by <b style="color:${f.color}">${esc(f.name)}</b>` : 'Unclaimed');
    if (f && st && st.heldSince > 0) lines.push(`<small>since ${hhmm(st.heldSince)} UTC (${span((Date.now() - st.heldSince) / 60_000)} ago)</small>`);
    if (st && st.progress > 0 && st.progress < 1 && st.capSide) {
      lines.push(`<span class="wm-cap">${esc(SIDES[st.capSide as keyof typeof SIDES]?.name ?? st.capSide)} capturing: ${Math.round(st.progress * 100)}%</span>`);
    }
    if (pt.buff) lines.push(`<small>Holder's members: ${esc(pt.buff.text)}</small>`);
    return lines.join('<br>');
  }

  private bossTip(b: BossSpot): string {
    const st = BOSS_STYLE[b.tier];
    let when: string;
    if (!b.schedule) when = `Respawns ${span((b.respawnSeconds ?? 180) / 60)} after it falls`;
    else {
      const m = bossNext(b, Date.now());
      when = `${m === 0 ? 'Up now' : `Rises in ${span(m)}`} · every ${span(b.schedule.everyMinutes)}${b.schedule.nightOnly ? ', night only' : ''}`;
    }
    return `<b style="color:${st.color}">${esc(b.name)}</b><br><small>${st.label} · Lv ${b.level} · ${esc(b.element)}</small><br><small>${when}</small>`;
  }

  private away(x: number, z: number): string {
    const me = this.state?.me;
    return me ? ` · ${dist(Math.hypot(x - me.x, z - me.z))} away` : '';
  }

  // ---- drawing -----------------------------------------------------------------------

  private draw(): void {
    if (!this.opened) return;
    this.lastDraw = performance.now();
    const w = this.body.clientWidth;
    const h = this.body.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.vw = w;
    this.vh = h;
    this.scale = (Math.min(w, h) / (2 * HALF)) * this.zoom;
    this.clampView();
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = DEEP;
    ctx.fillRect(0, 0, w, h);
    const size = 2 * HALF * this.scale;
    if (this.base) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.base.canvas, this.sx(-HALF), this.sy(-HALF), size, size);
    }
    this.hits.length = 0;
    this.labels.length = 0;
    this.drawGrid();
    this.drawStatic();
    this.drawPoints();
    this.drawLive();
    this.placeLabels();
    this.drawChrome();
    if (this.base && !this.base.done) {
      label(ctx, `Charting the world… ${Math.round(this.base.progress * 100)}%`, w / 2, h / 2, '#f4efe2', 14, 600);
    }
    const zt = `${this.zoom.toFixed(1)}×`;
    if (this.zoomEl.textContent !== zt) this.zoomEl.textContent = zt;
    const war = this.state?.warText ?? '';
    if (war !== this.warText) {
      this.warText = war;
      this.warEl.textContent = war;
      this.warEl.classList.toggle('on', /left|under way/.test(war));
    }
    if (this.hover && !this.drag) this.showTip();
  }

  /** Queue a name; placeLabels() draws the most important ones that don't overlap. */
  private tag(prio: number, text: string, x: number, y: number, color: string, size: number, weight = 600, align: CanvasTextAlign = 'center'): void {
    this.labels.push({ prio, text, x, y, color, size, weight, align });
  }

  private placeLabels(): void {
    const ctx = this.ctx;
    const placed: Array<[number, number, number, number]> = [];
    this.labels.sort((a, b) => b.prio - a.prio);
    for (const l of this.labels) {
      ctx.font = `${l.weight} ${l.size}px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif`;
      const w = ctx.measureText(l.text).width + 4;
      const x0 = l.align === 'left' ? l.x - 2 : l.x - w / 2;
      const y0 = l.y - l.size / 2 - 2;
      const x1 = x0 + w;
      const y1 = y0 + l.size + 4;
      if (x1 < 0 || x0 > this.vw || y1 < 0 || y0 > this.vh) continue;
      if (placed.some(([a, b, c, d]) => x0 < c && x1 > a && y0 < d && y1 > b)) continue;
      placed.push([x0, y0, x1, y1]);
      label(ctx, l.text, l.x, l.y, l.color, l.size, l.weight, l.align);
    }
  }

  /** Faint 512 m grid (8 chunks) and the world edge. */
  private drawGrid(): void {
    const ctx = this.ctx;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.beginPath();
    for (let v = -HALF + 512; v < HALF; v += 512) {
      ctx.moveTo(this.sx(v), this.sy(-HALF));
      ctx.lineTo(this.sx(v), this.sy(HALF));
      ctx.moveTo(this.sx(-HALF), this.sy(v));
      ctx.lineTo(this.sx(HALF), this.sy(v));
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.strokeRect(this.sx(-HALF), this.sy(-HALF), 2 * HALF * this.scale, 2 * HALF * this.scale);
  }

  /** Things that never move: safe zones + hubs, crew plots, arts masters, boss arenas. */
  private drawStatic(): void {
    const ctx = this.ctx;
    const z = this.zoom;
    const k = 0.85 + 0.15 * z;
    const now = Date.now();
    // Safe zones first so every marker sits on top.
    for (const f of FACTIONS) {
      const x = this.sx(f.hub.x);
      const y = this.sy(f.hub.z);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(6, f.hub.safeRadius * this.scale), 0, Math.PI * 2);
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = f.color;
      ctx.fill();
      ctx.globalAlpha = 0.7;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = f.color;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    // Boss arenas (only once zoomed in enough to read them) and markers.
    for (const b of BOSS_SPOTS) {
      const st = BOSS_STYLE[b.tier];
      const x = this.sx(b.x);
      const y = this.sy(b.z);
      if (z >= 2) {
        ctx.beginPath();
        ctx.arc(x, y, b.arena * this.scale, 0, Math.PI * 2);
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = st.color;
        ctx.globalAlpha = 0.6;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
      if (b.schedule && bossNext(b, now) === 0) dot(ctx, x, y, st.r * k + 5, 'rgba(255, 120, 60, 0.35)', 'rgba(255, 200, 120, 0.8)', 1);
      star(ctx, x, y, st.r * k, 8, 0.55, st.color);
      if (z >= (b.tier === 'legendary' ? 1.5 : 2)) this.tag(b.tier === 'legendary' ? 45 : 35, b.name, x, y + st.r * k + 9, st.color, 10);
      this.hits.push({ x, y, r: st.r * k, tip: () => this.bossTip(b) });
    }
    // Arts masters.
    for (const a of MASTERS) {
      const x = this.sx(a.master.x);
      const y = this.sy(a.master.z);
      star(ctx, x, y, 6 * k, 5, 0.45, EL_COLOR[a.element] ?? EL_COLOR.any);
      if (z >= 2) this.tag(30, a.master.name, x, y + 6 * k + 9, '#cfe3ff', 10);
      this.hits.push({
        x,
        y,
        r: 6 * k,
        tip: () => `<b>${esc(a.master.name)}</b> <small>${esc(a.master.title)}</small><br>Teaches <b>${esc(a.name)}</b><br><small>Lv ${a.level} · ${a.element === 'any' ? 'any element' : esc(a.element)}${this.away(a.master.x, a.master.z)}</small>`,
      });
    }
    // Crew base plots: hollow when free, faction-filled with the crew tag once a hall stands.
    const taken = new Map((this.state?.takenPlots ?? []).map((t) => [t.id, t]));
    PLOTS.forEach((p, i) => {
      const x = this.sx(p.x);
      const y = this.sy(p.z);
      const t = taken.get(p.id);
      const f = factionById(t?.faction);
      if (t) square(ctx, x, y, 3.5 * k, f?.color ?? NOBODY, '#fff');
      else square(ctx, x, y, 3 * k, 'rgba(10, 12, 20, 0.45)', '#e8dcc0');
      if (t && z >= 2) this.tag(40, `[${t.tag}]`, x, y - 3.5 * k - 7, f?.color ?? '#fff', 10, 700);
      this.hits.push({
        x,
        y,
        r: 4 * k,
        tip: () =>
          t
            ? `<b>[${esc(t.tag)}]</b> crew hall<br><small>${f ? `<span style="color:${f.color}">${esc(f.name)}</span> · ` : ''}crew plot ${i + 1}</small>`
            : `<b>Crew plot ${i + 1}</b><br><small>Free: raise a crew hall here to claim it</small>`,
      });
    });
    // Hubs on top of their safe zones.
    for (const f of FACTIONS) {
      const x = this.sx(f.hub.x);
      const y = this.sy(f.hub.z);
      const r = 8 * k;
      hubIcon(ctx, x, y, r, f);
      this.tag(70, f.hub.name, x, y + r + 9, '#fff', 11 + Math.min(2, z - 1), 700);
      this.hits.push({
        x,
        y,
        r,
        tip: () => `<b style="color:${f.color}">${esc(f.hub.name)}</b><br>${esc(f.name)} <small>(${esc(SIDES[f.side].name)})</small><br><small>Faction hub · safe zone ${f.hub.safeRadius} m${this.away(f.hub.x, f.hub.z)}</small>`,
      });
    }
  }

  /** Territory points: owner colour, contested circle, capture ring during a war. */
  private drawPoints(): void {
    const ctx = this.ctx;
    const k = 0.85 + 0.15 * this.zoom;
    const states = new Map((this.state?.points ?? []).map((p) => [p.id, p]));
    for (const pt of POINTS) {
      const st = states.get(pt.id);
      const f = factionById(st?.owner);
      const fill = f?.color ?? NOBODY;
      const x = this.sx(pt.x);
      const y = this.sy(pt.z);
      ctx.beginPath();
      ctx.arc(x, y, pt.radius * this.scale, 0, Math.PI * 2);
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = f ? fill : '#ff8a6a';
      ctx.fill();
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1;
      ctx.strokeStyle = f ? fill : '#ff8a6a';
      ctx.stroke();
      ctx.globalAlpha = 1;
      const r = (pt.kind === 'shrine' ? 9 : 7) * k;
      if (pt.kind === 'shrine') diamond(ctx, x, y, r, fill);
      else triangle(ctx, x, y, r, fill);
      if (st && st.progress > 0 && st.progress < 1) {
        ring(ctx, x, y, r + 5, st.progress, SIDES[st.capSide as keyof typeof SIDES]?.color ?? '#fff', 3);
      }
      if (pt.kind === 'shrine' || this.zoom >= 1.3) this.tag(pt.kind === 'shrine' ? 60 : 50, pt.name, x, y - r - 8, f ? '#fff' : '#ffd9cc', pt.kind === 'shrine' ? 11 : 10);
      this.hits.push({ x, y, r: r + 2, tip: () => this.pointTip(pt, states.get(pt.id)) });
    }
  }

  /** The live layer: camp, crew hall, quest target, party, you. */
  private drawLive(): void {
    const s = this.state;
    if (!s) return;
    const ctx = this.ctx;
    const k = 0.85 + 0.15 * this.zoom;
    if (s.camp) {
      const { x: wx, z: wz } = s.camp;
      const x = this.sx(wx);
      const y = this.sy(wz);
      campfire(ctx, x, y, 6.5 * k);
      this.tag(80, 'Camp', x, y + 6.5 * k + 9, CAMP, 10, 700);
      this.hits.push({ x, y, r: 7 * k, tip: () => `<b>Your camp</b><br><small>Campfire: you can respawn here${this.away(wx, wz)}</small>` });
    }
    if (s.hall) {
      const { x: wx, z: wz, name } = s.hall;
      const x = this.sx(wx);
      const y = this.sy(wz);
      house(ctx, x, y, 7.5 * k, HALL);
      this.tag(85, name, x, y + 7.5 * k + 9, HALL, 10, 700);
      this.hits.push({ x, y, r: 8 * k, tip: () => `<b>${esc(name)}</b><br><small>Your crew hall${this.away(wx, wz)}</small>` });
    }
    if (s.target) {
      const { x: wx, z: wz, name } = s.target;
      const x = this.sx(wx);
      const y = this.sy(wz);
      const t = (performance.now() / 1200) % 1;
      dot(ctx, x, y, 6 + t * 14, 'rgba(0,0,0,0)', `rgba(127, 216, 255, ${(1 - t).toFixed(2)})`, 2.5);
      dot(ctx, x, y, 5 * k, TARGET, '#fff', 1.5);
      this.tag(100, name, x, y - 5 * k - 9, TARGET, 11, 700);
      this.hits.push({ x, y, r: 7 * k, tip: () => `<b style="color:${TARGET}">${esc(name)}</b><br><small>Current target${this.away(wx, wz)}</small>` });
    }
    for (const m of s.party ?? []) {
      const x = this.sx(m.x);
      const y = this.sy(m.z);
      dot(ctx, x, y, 4.5 * k, PARTY);
      this.tag(90, m.name, x + 4.5 * k + 4, y, PARTY, 10, 700, 'left');
      const { name, x: wx, z: wz } = m;
      this.hits.push({ x, y, r: 5 * k, tip: () => `<b style="color:${PARTY}">${esc(name)}</b><br><small>Party member${this.away(wx, wz)}</small>` });
    }
    const me = s.me;
    const x = this.sx(me.x);
    const y = this.sy(me.z);
    dot(ctx, x, y, 15 * k, 'rgba(255, 77, 109, 0.18)', 'rgba(255, 255, 255, 0.35)', 1);
    arrow(ctx, x, y, me.yaw, 10 * k, ME);
    this.hits.push({ x, y, r: 9 * k, tip: () => `<b style="color:${ME}">You</b><br><small>x ${Math.round(me.x)} · z ${Math.round(me.z)}</small>` });
  }

  /** North marker and scale bar. */
  private drawChrome(): void {
    const ctx = this.ctx;
    triangle(ctx, 22, 20, 7, '#f4efe2');
    label(ctx, 'N', 22, 36, '#f4efe2', 11, 700);
    const nice = [50, 100, 250, 500, 1000, 2000];
    const m = nice.find((n) => n * this.scale >= 70) ?? 2000;
    const len = m * this.scale;
    const x = 14;
    const y = this.vh - 16;
    ctx.lineWidth = 4;
    ctx.strokeStyle = OUTLINE;
    ctx.beginPath();
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x, y);
    ctx.lineTo(x + len, y);
    ctx.lineTo(x + len, y - 5);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#f4efe2';
    ctx.stroke();
    label(ctx, m >= 1000 ? `${m / 1000} km` : `${m} m`, x + len + 6, y - 2, '#f4efe2', 11, 600, 'left');
  }

  // ---- legend ------------------------------------------------------------------------

  private buildLegend(el: HTMLElement): void {
    const icon = (draw: (ctx: Ctx) => void): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = c.height = 16 * dpr;
      const ctx = c.getContext('2d')!;
      ctx.scale(dpr, dpr);
      draw(ctx);
      return c;
    };
    const item = (text: string, draw: (ctx: Ctx) => void): HTMLSpanElement => {
      const s = document.createElement('span');
      s.append(icon(draw), text);
      return s;
    };
    const sep = () => Object.assign(document.createElement('i'), { className: 'wm-sep' });
    el.append(
      item('You', (c) => arrow(c, 8, 8, 0, 6.5, ME)),
      item('Party', (c) => dot(c, 8, 8, 4, PARTY)),
      item('Target', (c) => dot(c, 8, 8, 4, TARGET, '#fff')),
      item('Camp', (c) => campfire(c, 8, 8, 6)),
      item('Crew hall', (c) => house(c, 8, 8, 6, HALL)),
      sep(),
      item('Shrine', (c) => diamond(c, 8, 8, 7, NOBODY)),
      item('Outpost', (c) => triangle(c, 8, 9, 6, NOBODY)),
      item('Capturing', (c) => ring(c, 8, 8, 5, 0.65, SIDES.order.color, 2.5)),
      item('Crew plot', (c) => square(c, 8, 8, 3.5, 'rgba(10, 12, 20, 0.45)', '#e8dcc0')),
      item('Arts master', (c) => star(c, 8, 8, 6.5, 5, 0.45, EL_COLOR.any)),
      item('Rare beast', (c) => star(c, 8, 8, 5, 8, 0.55, BOSS_STYLE.mini.color)),
      item('World boss', (c) => star(c, 8, 8, 6.5, 8, 0.55, BOSS_STYLE.world.color)),
      item('Legendary', (c) => star(c, 8, 8, 7.5, 8, 0.55, BOSS_STYLE.legendary.color)),
      sep(),
    );
    for (const f of FACTIONS) {
      const s = document.createElement('span');
      s.innerHTML = `<i class="wm-fac" style="background:${f.color}"></i>${esc(f.name)}`;
      el.append(s);
    }
    const help = document.createElement('span');
    help.className = 'wm-help';
    help.textContent = 'Wheel: zoom · drag: pan · double-click: centre on you';
    const pos = document.createElement('span');
    pos.className = 'wm-pos';
    el.append(help, pos);
  }
}
