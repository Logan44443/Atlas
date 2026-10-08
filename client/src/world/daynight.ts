import * as THREE from 'three/webgpu';
import timeData from '@data/time.json';
import type { Sky } from './sky';

interface Keyframe {
  hour: number;
  skyTop: string;
  skyHorizon: string;
  sunColor: string;
  sunIntensity: number;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  fogColor: string;
  fogNear: number;
  fogFar: number;
  exposure: number;
}

interface ParsedKey {
  hour: number;
  skyTop: THREE.Color;
  skyHorizon: THREE.Color;
  sunColor: THREE.Color;
  sunIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  fogColor: THREE.Color;
  fogNear: number;
  fogFar: number;
  exposure: number;
}

const keys: ParsedKey[] = (timeData.keyframes as Keyframe[])
  .map((k) => ({
    ...k,
    skyTop: new THREE.Color(k.skyTop),
    skyHorizon: new THREE.Color(k.skyHorizon),
    sunColor: new THREE.Color(k.sunColor),
    hemiSky: new THREE.Color(k.hemiSky),
    hemiGround: new THREE.Color(k.hemiGround),
    fogColor: new THREE.Color(k.fogColor),
  }))
  .sort((a, b) => a.hour - b.hour);

/**
 * Game clock + lighting. `hour` is 0..24. The single directional light follows
 * the sun by day and the moon by night so there is always one shadow caster.
 */
export class DayNight {
  /** Absolute in-game days elapsed (fractional). */
  days: number;
  timeScale = 1;
  paused = false;
  readonly light: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fog: THREE.Fog;
  readonly sunDir = new THREE.Vector3();
  readonly moonDir = new THREE.Vector3();
  fogScale = 1;
  private sky: Sky;
  private tmp = new THREE.Color();

  constructor(scene: THREE.Scene, sky: Sky) {
    this.sky = sky;
    this.days = timeData.startHour / 24;
    this.light = new THREE.DirectionalLight(0xffffff, 2.5);
    this.light.castShadow = true;
    this.light.shadow.bias = -0.0004;
    this.light.shadow.normalBias = 0.6;
    this.hemi = new THREE.HemisphereLight(0xbcd8ff, 0x6b5a3f, 0.9);
    this.fog = new THREE.Fog(0xbfd8ef, 120, 700);
    scene.fog = this.fog;
    scene.add(this.light, this.light.target, this.hemi);
  }

  get hour(): number {
    return (((this.days % 1) + 1) % 1) * 24;
  }
  set hour(h: number) {
    this.days = Math.floor(this.days) + (((h % 24) + 24) % 24) / 24;
  }

  /** 0 = new moon, 1 = full moon. */
  get moonPhase(): number {
    const cycle = timeData.moonCycleDays;
    const p = (((this.days / cycle) % 1) + 1) % 1;
    return 0.5 - 0.5 * Math.cos(p * Math.PI * 2);
  }

  /** 0 at noon/day, 1 at full night. Used by Water/Fire bonuses later. */
  get nightFactor(): number {
    return THREE.MathUtils.smoothstep(-this.sunDir.y, -0.05, 0.15);
  }

  get label(): string {
    const h = this.hour;
    if (h < 5) return 'Night';
    if (h < 7) return 'Dawn';
    if (h < 11) return 'Morning';
    if (h < 13) return 'Noon';
    if (h < 17) return 'Afternoon';
    if (h < 19.5) return 'Dusk';
    return 'Night';
  }

  update(dt: number, focus: THREE.Vector3, shadowDistance: number): void {
    if (!this.paused) this.days += (dt * this.timeScale) / (timeData.dayLengthMinutes * 60);
    const h = this.hour;

    // Sun travels east->west, tilted toward the south.
    const a = ((h - 6) / 12) * Math.PI;
    const tilt = THREE.MathUtils.degToRad(timeData.sunTiltDegrees);
    this.sunDir.set(Math.cos(a), Math.sin(a) * Math.cos(tilt), Math.sin(a) * Math.sin(tilt)).normalize();
    this.moonDir.copy(this.sunDir).negate();
    this.moonDir.z = Math.abs(this.moonDir.z) * 0.5 + 0.2;
    this.moonDir.normalize();

    // Interpolate keyframes.
    let i = keys.length - 1;
    for (let k = 0; k < keys.length; k++) if (keys[k].hour <= h) i = k;
    const k0 = keys[i];
    const k1 = keys[(i + 1) % keys.length];
    const span = (k1.hour - k0.hour + 24) % 24 || 24;
    const t = ((h - k0.hour + 24) % 24) / span;
    const lc = (a: THREE.Color, b: THREE.Color, out: THREE.Color) => out.copy(a).lerp(b, t);
    const ln = (a: number, b: number) => a + (b - a) * t;

    lc(k0.skyTop, k1.skyTop, this.sky.top.value as THREE.Color);
    lc(k0.skyHorizon, k1.skyHorizon, this.sky.horizon.value as THREE.Color);
    lc(k0.sunColor, k1.sunColor, this.tmp);
    (this.sky.sunColor.value as THREE.Color).copy(this.tmp);
    this.light.color.copy(this.tmp);
    this.light.intensity = ln(k0.sunIntensity, k1.sunIntensity);
    lc(k0.hemiSky, k1.hemiSky, this.hemi.color);
    lc(k0.hemiGround, k1.hemiGround, this.hemi.groundColor);
    this.hemi.intensity = ln(k0.hemiIntensity, k1.hemiIntensity);
    lc(k0.fogColor, k1.fogColor, this.fog.color);
    this.fog.near = ln(k0.fogNear, k1.fogNear) * this.fogScale;
    this.fog.far = ln(k0.fogFar, k1.fogFar) * this.fogScale;

    (this.sky.sunDir.value as THREE.Vector3).copy(this.sunDir);
    (this.sky.moonDir.value as THREE.Vector3).copy(this.moonDir);
    this.sky.night.value = this.nightFactor;
    this.sky.moonPhase.value = this.moonPhase;

    // Shadow caster: sun when up, moon otherwise.
    const caster = this.sunDir.y > -0.02 ? this.sunDir : this.moonDir;
    const lift = Math.max(caster.y, 0.12);
    const dir = new THREE.Vector3(caster.x, lift, caster.z).normalize();
    // Snap the light to texel-sized steps to stop shadow shimmering when moving.
    const cam = this.light.shadow.camera as THREE.OrthographicCamera;
    const texel = (shadowDistance * 2) / this.light.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.light.target.position.set(fx, focus.y, fz);
    this.light.position.set(fx + dir.x * 300, focus.y + dir.y * 300, fz + dir.z * 300);
    if (cam.right !== shadowDistance) {
      cam.left = -shadowDistance;
      cam.right = shadowDistance;
      cam.top = shadowDistance;
      cam.bottom = -shadowDistance;
      cam.near = 1;
      cam.far = 700;
      cam.updateProjectionMatrix();
    }
  }

  setShadowMapSize(size: number): void {
    if (this.light.shadow.mapSize.x === size) return;
    this.light.shadow.mapSize.set(size, size);
    this.light.shadow.map?.dispose();
    this.light.shadow.map = null as unknown as THREE.RenderTarget;
  }
}
