import qualityData from '@data/quality.json';

export type PresetName = 'low' | 'medium' | 'high';
export type QualitySetting = PresetName | 'auto';

export interface QualityPreset {
  label: string;
  pixelRatioCap: number;
  renderScale: number;
  shadows: boolean;
  shadowMapSize: number;
  shadowDistance: number;
  bloom: boolean;
  grassDensity: number;
  grassRadius: number;
  terrainSegments: { near: number; mid: number; far: number };
  rings: { near: number; mid: number; far: number };
  fogScale: number;
  propDensity: number;
}

const PRESETS = qualityData.presets as Record<PresetName, QualityPreset>;
export const TARGET_FPS = qualityData.targetFps as Record<PresetName, number>;
const STORAGE_KEY = 'fw.quality';

export function getPreset(name: PresetName): QualityPreset {
  return PRESETS[name];
}

export function loadQualitySetting(): QualitySetting {
  const fromUrl = new URLSearchParams(location.search).get('quality');
  if (fromUrl === 'low' || fromUrl === 'medium' || fromUrl === 'high' || fromUrl === 'auto') return fromUrl;
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'low' || v === 'medium' || v === 'high' || v === 'auto') return v;
  } catch {
    /* storage blocked */
  }
  return 'auto';
}

export function saveQualitySetting(v: QualitySetting): void {
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* storage blocked */
  }
}

export interface DetectInfo {
  isWebGPU: boolean;
  gpu: string;
}

/** Heuristic first guess; the runtime FPS governor can step it down later. */
export function detectPreset(info: DetectInfo): { preset: PresetName; reason: string } {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const mem = nav.deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 4;
  const gpu = info.gpu.toLowerCase();
  const software = /swiftshader|llvmpipe|software|basic render/.test(gpu);

  if (software) return { preset: 'low', reason: 'software renderer' };
  if (mobile) return { preset: mem >= 6 && info.isWebGPU ? 'medium' : 'low', reason: 'mobile device' };
  if (mem <= 4 || cores <= 4) return { preset: 'low', reason: `${mem} GB / ${cores} cores` };
  if (!info.isWebGPU) return { preset: 'medium', reason: 'WebGL2 fallback' };
  if (/apple m\d|apple gpu|nvidia|radeon|geforce|rtx/.test(gpu) || gpu === '') return { preset: 'high', reason: 'capable GPU' };
  return { preset: 'medium', reason: 'unknown GPU' };
}

const ORDER: PresetName[] = ['low', 'medium', 'high'];
export function lowerPreset(p: PresetName): PresetName | null {
  const i = ORDER.indexOf(p);
  return i > 0 ? ORDER[i - 1] : null;
}
