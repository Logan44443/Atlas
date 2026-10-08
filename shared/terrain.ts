// Deterministic terrain height + surface colour. Shared by the client (mesh
// building in workers), the world build script and, later, the server.
import { createSimplex2D, fbm, ridged, clamp, lerp, smoothstep, type Noise2D } from './noise';

export interface TerrainConfig {
  seed: number;
  chunkSize: number;
  worldChunks: number;
  seaLevel: number;
  terrain: {
    baseHeight: number;
    continentScale: number;
    continentAmplitude: number;
    hillScale: number;
    hillAmplitude: number;
    detailScale: number;
    detailAmplitude: number;
    mountainScale: number;
    mountainAmplitude: number;
    mountainThreshold: number;
    warpScale: number;
    warpAmount: number;
    edgeFalloff: number;
    edgeDepth: number;
  };
  biomes: { sandMaxHeight: number; grassMaxHeight: number; snowMinHeight: number; rockSlope: number };
  colors: Record<'sand' | 'grassLow' | 'grassHigh' | 'dirt' | 'rock' | 'rockDark' | 'snow' | 'seabed', string>;
  /** Levelled sites (faction hubs, shrines). Height is the raw terrain at the centre. */
  flats?: Array<{ x: number; z: number; radius: number; blend: number }>;
}

export type RGB = [number, number, number];

/** sRGB hex -> linear RGB (what three.js vertex colours expect). */
export function hexToLinear(hex: string): RGB {
  const n = parseInt(hex.replace('#', ''), 16);
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return [c((n >> 16) & 255), c((n >> 8) & 255), c(n & 255)];
}

const mixRGB = (a: RGB, b: RGB, t: number, out: RGB): RGB => {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
};

export class TerrainSampler {
  readonly cfg: TerrainConfig;
  private n1: Noise2D;
  private n2: Noise2D;
  private n3: Noise2D;
  private n4: Noise2D;
  private nw: Noise2D;
  private col: Record<string, RGB>;
  readonly halfExtent: number;

  constructor(cfg: TerrainConfig) {
    this.cfg = cfg;
    this.n1 = createSimplex2D(cfg.seed);
    this.n2 = createSimplex2D(cfg.seed + 1);
    this.n3 = createSimplex2D(cfg.seed + 2);
    this.n4 = createSimplex2D(cfg.seed + 3);
    this.nw = createSimplex2D(cfg.seed + 4);
    this.col = {};
    for (const [k, v] of Object.entries(cfg.colors)) this.col[k] = hexToLinear(v);
    this.halfExtent = (cfg.worldChunks * cfg.chunkSize) / 2;
  }

  private flatHeights: number[] = [];

  /** World-space height (metres) at x,z. */
  height(x: number, z: number): number {
    let h = this.rawHeight(x, z);
    const flats = this.cfg.flats;
    if (flats) {
      for (let i = 0; i < flats.length; i++) {
        const f = flats[i];
        const d = Math.hypot(x - f.x, z - f.z);
        if (d >= f.radius + f.blend) continue;
        if (this.flatHeights[i] === undefined) this.flatHeights[i] = Math.max(this.rawHeight(f.x, f.z), this.cfg.seaLevel + 2.5);
        h = lerp(h, this.flatHeights[i], 1 - smoothstep(f.radius, f.radius + f.blend, d));
      }
    }
    return h;
  }

  /** Height before levelling (natural terrain). */
  rawHeight(x: number, z: number): number {
    const t = this.cfg.terrain;
    // Domain warp for more organic coastlines and ridges.
    const wx = x + this.nw(x / t.warpScale, z / t.warpScale) * t.warpAmount;
    const wz = z + this.nw((x + 917) / t.warpScale, (z - 311) / t.warpScale) * t.warpAmount;

    const continent = fbm(this.n1, wx / t.continentScale, wz / t.continentScale, 4);
    const hills = fbm(this.n2, wx / t.hillScale, wz / t.hillScale, 4);
    const detail = fbm(this.n3, x / t.detailScale, z / t.detailScale, 3);
    const mRaw = ridged(this.n4, wx / t.mountainScale, wz / t.mountainScale, 5);
    const mMask = smoothstep(t.mountainThreshold - 0.15, t.mountainThreshold + 0.25, continent * 0.5 + 0.5);

    let h = t.baseHeight + continent * t.continentAmplitude;

    h += hills * t.hillAmplitude * smoothstep(-2, 10, h);
    h += mRaw * t.mountainAmplitude * mMask;
    h += detail * t.detailAmplitude;

    // Flatten the spawn area a little so the first view is welcoming.
    const sd = Math.hypot(x, z);
    const spawnFlat = 1 - smoothstep(30, 140, sd);
    h = lerp(h, Math.max(h * 0.35 + 4, 3.5), spawnFlat * 0.85);

    // Sink the world edge into the ocean.
    const e = this.halfExtent;
    const edge = Math.max(Math.abs(x), Math.abs(z)) / e;
    const fall = smoothstep(1 - t.edgeFalloff, 1, edge);
    h = lerp(h, t.edgeDepth, fall);
    return h;
  }

  /** Surface normal Y component (1 = flat) by central differences. */
  slopeY(x: number, z: number, eps = 1): number {
    const hl = this.height(x - eps, z);
    const hr = this.height(x + eps, z);
    const hd = this.height(x, z - eps);
    const hu = this.height(x, z + eps);
    const nx = hl - hr;
    const nz = hd - hu;
    const ny = 2 * eps;
    return ny / Math.hypot(nx, ny, nz);
  }

  /** Linear-space vertex colour for a point with known height and normal.y. */
  color(x: number, z: number, h: number, ny: number, out: RGB = [0, 0, 0]): RGB {
    const b = this.cfg.biomes;
    const c = this.col;
    const jitter = this.n3(x * 0.11, z * 0.11) * 0.5 + 0.5;
    const sea = this.cfg.seaLevel;
    if (h < sea - 0.5) return mixRGB(c.seabed, c.sand, clamp((h - sea + 6) / 6, 0, 1), out);
    if (h < sea + b.sandMaxHeight) return mixRGB(c.sand, c.grassLow, smoothstep(sea + b.sandMaxHeight - 0.8, sea + b.sandMaxHeight, h), out);
    const tmp: RGB = [0, 0, 0];
    mixRGB(c.grassLow, c.grassHigh, clamp(jitter * 0.7 + (h / b.grassMaxHeight) * 0.5, 0, 1), out);
    // Dirt patches.
    const dirt = smoothstep(0.55, 0.75, this.n2(x * 0.03, z * 0.03) * 0.5 + 0.5) * 0.6;
    mixRGB(out, c.dirt, dirt, out);
    // Altitude -> rock.
    const alt = smoothstep(b.grassMaxHeight - 10, b.grassMaxHeight + 12, h);
    mixRGB(c.rock, c.rockDark, jitter, tmp);
    mixRGB(out, tmp, alt, out);
    // Steep -> rock (cliff faces read as strong painterly bands).
    const steep = 1 - smoothstep(b.rockSlope, b.rockSlope + 0.12, ny);
    mixRGB(out, tmp, steep, out);
    // Snow caps on flatter high ground.
    const snow = smoothstep(b.snowMinHeight - 6, b.snowMinHeight + 6, h + jitter * 8) * smoothstep(0.5, 0.75, ny);
    mixRGB(out, c.snow, snow, out);
    // Packed-earth plazas on levelled sites.
    const plaza = this.plazaAmount(x, z);
    if (plaza > 0) mixRGB(out, c.dirt, plaza * 0.85, out);
    return out;
  }

  /** 0..1 inside a levelled site's plaza (hubs, shrines). */
  plazaAmount(x: number, z: number): number {
    const flats = this.cfg.flats;
    if (!flats) return 0;
    let a = 0;
    for (const f of flats) {
      const d = Math.hypot(x - f.x, z - f.z);
      if (d < f.radius) a = Math.max(a, 1 - smoothstep(f.radius - 8, f.radius, d));
    }
    return a;
  }

  /** Low-frequency [-1,1] noise used to cluster props into forests / rock fields. */
  clusterNoise(x: number, z: number): number {
    return this.n2(x + 51.3, z - 17.9);
  }

  /** 0..1 how suitable a point is for grass. */
  grassiness(h: number, ny: number): number {
    const b = this.cfg.biomes;
    const sea = this.cfg.seaLevel;
    return (
      smoothstep(sea + b.sandMaxHeight, sea + b.sandMaxHeight + 1.5, h) *
      (1 - smoothstep(b.grassMaxHeight - 12, b.grassMaxHeight, h)) *
      smoothstep(b.rockSlope + 0.08, b.rockSlope + 0.2, ny)
    );
  }
}
