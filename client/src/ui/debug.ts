import type { QualitySetting } from '../engine/quality';

export interface DebugStats {
  fps: number;
  ms: number;
  drawCalls: number;
  triangles: number;
  backend: string;
  gpu: string;
  preset: string;
  presetReason: string;
  timeLabel: string;
  clock: string;
  moon: string;
  pos: string;
  extra: Array<[string, string]>;
}

export interface DebugCallbacks {
  onQuality(v: QualitySetting): void;
  onHour(h: number): void;
  onTimeScale(s: number): void;
}

/** FPS / renderer / world overlay. F3 toggles. */
export class DebugOverlay {
  readonly el: HTMLDivElement;
  private body: HTMLDivElement;
  private hourInput: HTMLInputElement;
  private qualitySelect: HTMLSelectElement;
  readonly extraSlot: HTMLDivElement;
  private draggingHour = false;

  constructor(cb: DebugCallbacks, quality: QualitySetting, help: string) {
    this.el = document.createElement('div');
    this.el.className = 'debug';
    this.body = document.createElement('div');
    this.el.appendChild(this.body);
    this.el.appendChild(document.createElement('hr'));

    const qRow = document.createElement('div');
    qRow.className = 'row';
    qRow.innerHTML = '<span class="k">Quality</span>';
    this.qualitySelect = document.createElement('select');
    for (const [v, l] of [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = l;
      this.qualitySelect.appendChild(o);
    }
    this.qualitySelect.value = quality;
    this.qualitySelect.addEventListener('change', () => cb.onQuality(this.qualitySelect.value as QualitySetting));
    qRow.appendChild(this.qualitySelect);
    this.el.appendChild(qRow);

    const hRow = document.createElement('div');
    hRow.className = 'row';
    hRow.innerHTML = '<span class="k">Hour</span>';
    this.hourInput = document.createElement('input');
    this.hourInput.type = 'range';
    this.hourInput.min = '0';
    this.hourInput.max = '24';
    this.hourInput.step = '0.05';
    this.hourInput.addEventListener('pointerdown', () => (this.draggingHour = true));
    this.hourInput.addEventListener('pointerup', () => (this.draggingHour = false));
    this.hourInput.addEventListener('input', () => cb.onHour(parseFloat(this.hourInput.value)));
    hRow.appendChild(this.hourInput);
    this.el.appendChild(hRow);

    const sRow = document.createElement('div');
    sRow.className = 'row';
    sRow.innerHTML = '<span class="k">Time speed</span>';
    const speed = document.createElement('select');
    for (const v of ['0', '1', '10', '60', '240']) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v === '0' ? 'paused' : `${v}x`;
      speed.appendChild(o);
    }
    speed.value = '1';
    speed.addEventListener('change', () => cb.onTimeScale(parseFloat(speed.value)));
    sRow.appendChild(speed);
    this.el.appendChild(sRow);

    this.extraSlot = document.createElement('div');
    this.el.appendChild(this.extraSlot);

    const h = document.createElement('div');
    h.className = 'help';
    h.textContent = help;
    this.el.appendChild(h);

    document.body.appendChild(this.el);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3' || (e.code === 'Backquote' && !e.repeat)) {
        e.preventDefault();
        this.el.classList.toggle('hidden');
      }
    });
  }

  setQualityValue(v: QualitySetting): void {
    this.qualitySelect.value = v;
  }

  update(s: DebugStats, hour: number): void {
    if (this.el.classList.contains('hidden')) return;
    if (!this.draggingHour) this.hourInput.value = hour.toFixed(2);
    const fpsClass = s.fps >= 55 ? 'fps-good' : s.fps >= 28 ? 'fps-ok' : 'fps-bad';
    const rows: Array<[string, string]> = [
      ['FPS', `<span class="${fpsClass}">${s.fps.toFixed(0)}</span> (${s.ms.toFixed(1)} ms)`],
      ['Draw calls', String(s.drawCalls)],
      ['Triangles', s.triangles >= 1e6 ? `${(s.triangles / 1e6).toFixed(2)} M` : `${(s.triangles / 1e3).toFixed(1)} k`],
      ['Backend', s.backend],
      ['Preset', `${s.preset} <span class="k">(${s.presetReason})</span>`],
      ['Time', `${s.clock} ${s.timeLabel}`],
      ['Moon', s.moon],
      ['Position', s.pos],
      ...s.extra,
    ];
    this.body.innerHTML = rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span>${v}</span></div>`).join('');
    this.body.title = s.gpu;
  }
}
