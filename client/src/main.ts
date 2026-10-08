import * as THREE from 'three/webgpu';
import worldData from '@data/world.json';
import { TerrainSampler, type TerrainConfig } from '@shared/terrain';
import { GameRenderer } from './engine/renderer';
import { Input } from './engine/input';
import { FlyCamera } from './engine/flyCamera';
import {
  detectPreset, getPreset, loadQualitySetting, saveQualitySetting, lowerPreset, TARGET_FPS,
  type PresetName, type QualitySetting, type QualityPreset,
} from './engine/quality';
import { Sky } from './world/sky';
import { DayNight } from './world/daynight';
import { Water } from './world/water';
import { ChunkStreamer } from './world/streamer';
import { ChunkMinimap } from './ui/minimap';
import { registerServiceWorker } from './engine/serviceWorker';
import { DebugOverlay } from './ui/debug';

const HELP = `F3 toggle overlay   F4/M chunk map
Drag mouse: look   WASD: move
Space/E up  Q down  Shift fast  Wheel speed`;

function setLoading(text: string, frac: number) {
  const t = document.getElementById('loading-text');
  const f = document.getElementById('loading-fill');
  if (t) t.textContent = text;
  if (f) f.style.width = `${Math.round(frac * 100)}%`;
}

async function main() {
  const container = document.getElementById('app')!;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 5000);
  camera.position.set(worldData.spawn.x + 40, 30, worldData.spawn.z + 60);

  setLoading('Starting renderer…', 0.1);
  const gr = await GameRenderer.create(container, scene, camera);

  let qualitySetting: QualitySetting = loadQualitySetting();
  const detected = detectPreset({ isWebGPU: gr.info.backend === 'WebGPU', gpu: gr.info.gpu });
  let presetName: PresetName = qualitySetting === 'auto' ? detected.preset : qualitySetting;
  let presetReason = qualitySetting === 'auto' ? `auto: ${detected.reason}` : 'manual';
  let q: QualityPreset = getPreset(presetName);

  const sampler = new TerrainSampler(worldData as unknown as TerrainConfig);
  const sky = new Sky();
  scene.add(sky.mesh);
  const dayNight = new DayNight(scene, sky);
  const water = new Water();
  scene.add(water.mesh);

  setLoading('Opening the world…', 0.2);
  const swActive = await registerServiceWorker();
  const streamer = new ChunkStreamer(sampler, q);
  await streamer.init();
  scene.add(streamer.group);

  function applyQuality() {
    gr.applyQuality(q);
    dayNight.setShadowMapSize(q.shadowMapSize);
    dayNight.fogScale = q.fogScale;
    streamer.setQuality(q);
  }
  applyQuality();

  const input = new Input(gr.renderer.domElement);
  const fly = new FlyCamera(camera, input, (x, z) => streamer.heightAt(x, z));

  const debug = new DebugOverlay(
    {
      onQuality(v) {
        qualitySetting = v;
        saveQualitySetting(v);
        presetName = v === 'auto' ? detected.preset : v;
        presetReason = v === 'auto' ? `auto: ${detected.reason}` : 'manual';
        q = getPreset(presetName);
        applyQuality();
      },
      onHour(h) {
        dayNight.hour = h;
      },
      onTimeScale(s) {
        dayNight.timeScale = s;
      },
    },
    qualitySetting,
    HELP,
  );
  const minimap = new ChunkMinimap(debug.extraSlot, streamer);

  window.addEventListener('resize', () => gr.resize());

  // Expose for automated browser tests and console tinkering.
  Object.assign(window, { __fw: { scene, camera, renderer: gr.renderer, dayNight, sampler, streamer, fly, swActive, get preset() { return presetName; } } });

  const clock = new THREE.Timer();
  let fpsAcc = 0;
  let fpsFrames = 0;
  let fps = 60;
  let msAvg = 16;
  let slowSeconds = 0;
  let loading = true;
  let loadingFrames = 0;
  streamer.applyBudget = 24;

  gr.renderer.setAnimationLoop(() => {
    clock.update();
    const dt = Math.min(clock.getDelta(), 0.1);
    fly.update(dt);
    streamer.update(camera.position, dt);
    dayNight.update(dt, camera.position, q.shadowDistance);
    dayNight.light.castShadow = q.shadows;
    sky.follow(camera);
    water.follow(camera.position);
    // Behind the loading screen only render occasionally (keeps shaders warm)
    // so the main thread spends its time streaming in the spawn area.
    if (!loading || ++loadingFrames % 20 === 0) gr.render();
    input.endFrame();

    if (loading) {
      const c = streamer.counts;
      setLoading(`Loading nearby land (${c.near + c.mid + c.far} chunks)…`, 0.3 + Math.min(0.7, (c.near + c.mid) / 30));
      if (streamer.nearReady()) {
        loading = false;
        streamer.applyBudget = 3;
        gr.render();
        document.getElementById('loading')?.classList.add('done');
      }
    }

    fpsAcc += dt;
    fpsFrames++;
    if (fpsAcc >= 0.5) {
      fps = fpsFrames / fpsAcc;
      msAvg = (fpsAcc / fpsFrames) * 1000;
      // Auto governor: if we sit well under target for 5 s, step the preset down once per 5 s.
      if (qualitySetting === 'auto') {
        slowSeconds = fps < TARGET_FPS[presetName] * 0.75 ? slowSeconds + fpsAcc : 0;
        const lower = lowerPreset(presetName);
        if (slowSeconds > 5 && lower) {
          presetName = lower;
          presetReason = 'auto: low FPS';
          q = getPreset(presetName);
          applyQuality();
          slowSeconds = 0;
        }
      }
      fpsAcc = 0;
      fpsFrames = 0;
      minimap.draw(camera.position.x, camera.position.z, fly.yaw);
      const info = gr.renderer.info.render;
      const st = streamer.store.stats;
      const h = dayNight.hour;
      const hh = Math.floor(h);
      const mm = Math.floor((h - hh) * 60);
      const phase = dayNight.moonPhase;
      debug.update(
        {
          fps,
          ms: msAvg,
          drawCalls: info.drawCalls,
          triangles: info.triangles,
          backend: gr.info.backend,
          gpu: gr.info.gpu,
          preset: q.label,
          presetReason,
          timeLabel: dayNight.label,
          clock: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
          moon: phase > 0.95 ? 'Full' : phase < 0.05 ? 'New' : `${Math.round(phase * 100)}%`,
          pos: `${camera.position.x.toFixed(0)}, ${camera.position.y.toFixed(0)}, ${camera.position.z.toFixed(0)}`,
          extra: [
            ['Chunks', `${streamer.counts.near}/${streamer.counts.mid}/${streamer.counts.far} <span class="k">n/m/f</span>`],
            ['Queue', `${streamer.counts.queued} build ${streamer.counts.building} pre ${streamer.counts.prefetch}`],
            ['Fetch', `${st.fetched} (${(st.bytes / 1048576).toFixed(1)} MB) sw ${swActive ? 'on' : 'off'} hit ${st.swHits}`],
            ['Mesh build', `${streamer.buildMsAvg.toFixed(1)} ms avg`],
          ],
        },
        h,
      );
    }
  });
}

main().catch((err) => {
  console.error(err);
  setLoading(`Failed to start: ${err?.message ?? err}`, 1);
});
