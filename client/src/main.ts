import * as THREE from 'three/webgpu';
import worldData from '@data/world.json';
import { TerrainSampler, type TerrainConfig } from '@shared/terrain';
import { GameRenderer } from './engine/renderer';
import { Input } from './engine/input';
import { FlyCamera } from './engine/flyCamera';
import { Settings, Controls } from './engine/settings';
import { registerServiceWorker } from './engine/serviceWorker';
import {
  detectPreset, getPreset, loadQualitySetting, saveQualitySetting, lowerPreset, TARGET_FPS,
  type PresetName, type QualitySetting, type QualityPreset,
} from './engine/quality';
import { Sky } from './world/sky';
import { DayNight } from './world/daynight';
import { Water } from './world/water';
import { ChunkStreamer } from './world/streamer';
import { Physics } from './game/physics';
import { Player } from './game/player';
import { Avatar } from './game/avatar';
import { Nameplate } from './game/nameplate';
import { ThirdPersonCamera } from './game/thirdPersonCamera';
import { DebugOverlay } from './ui/debug';
import { ChunkMinimap } from './ui/minimap';
import { SettingsMenu } from './ui/settingsMenu';

const HELP = `Click to capture mouse, Esc for settings
WASD move, Shift sprint, Space jump, V dodge
Hold right mouse: block. Wheel: zoom
F2 free camera  F3 overlay  F4/M chunk map`;

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
  const spawn = new THREE.Vector3(worldData.spawn.x, 0, worldData.spawn.z);

  setLoading('Starting renderer…', 0.05);
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

  setLoading('Waking the spirits (physics)…', 0.1);
  const physics = await Physics.create();

  setLoading('Opening the world…', 0.2);
  const swActive = await registerServiceWorker();
  const streamer = new ChunkStreamer(sampler, q, {
    onNear: (cx, cz, data) => physics.addTerrainChunk(cx, cz, worldData.chunkSize, data.heights),
    onLeaveNear: (cx, cz) => physics.removeTerrainChunk(cx, cz),
  });
  await streamer.init();
  scene.add(streamer.group);
  const groundAt = (x: number, z: number) => streamer.heightAt(x, z);

  function applyQuality() {
    gr.applyQuality(q);
    dayNight.setShadowMapSize(q.shadowMapSize);
    dayNight.fogScale = q.fogScale;
    streamer.setQuality(q);
  }
  function setQuality(v: QualitySetting) {
    qualitySetting = v;
    saveQualitySetting(v);
    presetName = v === 'auto' ? detected.preset : v;
    presetReason = v === 'auto' ? `auto: ${detected.reason}` : 'manual';
    q = getPreset(presetName);
    applyQuality();
    debug.setQualityValue(v);
  }
  applyQuality();

  const input = new Input(gr.renderer.domElement);
  const settings = new Settings();
  settings.save();
  const controls = new Controls(input, settings);

  // Player.
  spawn.y = Math.max(groundAt(spawn.x, spawn.z), worldData.seaLevel);
  const player = new Player(physics, controls, spawn, groundAt, worldData.chunkSize);
  const avatar = new Avatar('fire');
  const nameplate = new Nameplate(settings.data.name);
  avatar.root.add(nameplate.sprite);
  scene.add(avatar.root);
  settings.onChange((s) => nameplate.set(s.name));

  const tpc = new ThirdPersonCamera(camera, input, settings, physics, groundAt);
  const fly = new FlyCamera(camera, input, groundAt);
  let freeCam = false;

  const debug = new DebugOverlay(
    { onQuality: setQuality, onHour: (h) => (dayNight.hour = h), onTimeScale: (s) => (dayNight.timeScale = s) },
    qualitySetting,
    HELP,
  );
  const minimap = new ChunkMinimap(debug.extraSlot, streamer);
  const menu = new SettingsMenu(settings, input, {
    getQuality: () => qualitySetting,
    setQuality,
    onOpenChange: () => updateHint(),
  });

  // "Click to play" hint + crosshair.
  const hint = document.createElement('div');
  hint.className = 'play-hint';
  hint.textContent = 'Click to play · Esc for settings';
  document.body.appendChild(hint);
  const crosshair = document.createElement('div');
  crosshair.className = 'crosshair hidden';
  document.body.appendChild(crosshair);
  function updateHint() {
    hint.classList.toggle('hidden', input.pointerLocked || menu.isOpen || freeCam);
    crosshair.classList.toggle('hidden', !input.pointerLocked);
  }
  gr.renderer.domElement.addEventListener('click', () => {
    if (!menu.isOpen && !input.pointerLocked) input.requestPointerLock();
  });
  document.addEventListener('pointerlockchange', () => setTimeout(updateHint, 0));

  window.addEventListener('resize', () => gr.resize());

  // Exposed for automated browser tests and console tinkering.
  Object.assign(window, {
    __fw: {
      scene, camera, renderer: gr.renderer, dayNight, sampler, streamer, physics, player, avatar, settings, menu, input, tpc, swActive,
      get preset() { return presetName; },
      get freeCam() { return freeCam; },
    },
  });

  const clock = new THREE.Timer();
  let fpsAcc = 0;
  let fpsFrames = 0;
  let slowSeconds = 0;
  let loading = true;
  let loadingFrames = 0;
  streamer.applyBudget = 24;

  gr.renderer.setAnimationLoop(() => {
    clock.update();
    const dt = Math.min(clock.getDelta(), 0.1);

    if (controls.pressed('freeCamera')) {
      freeCam = !freeCam;
      if (freeCam) {
        fly.yaw = tpc.yaw;
        fly.pitch = tpc.pitch;
      }
      updateHint();
    }

    if (!loading) {
      if (freeCam) fly.update(dt);
      else player.update(dt, tpc.yaw);
      avatar.root.position.copy(player.renderPos);
      avatar.root.rotation.y = player.facing;
      avatar.update(dt, player.pose());
      if (!freeCam) tpc.update(dt, player);
    } else {
      tpc.update(0, player);
    }

    const focus = freeCam ? camera.position : player.renderPos;
    streamer.update(focus, dt);
    dayNight.update(dt, focus, q.shadowDistance);
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
      if (streamer.nearReady() && physics.terrainColliderCount > 0) {
        loading = false;
        streamer.applyBudget = 3;
        player.teleport(spawn.x, spawn.z);
        gr.render();
        document.getElementById('loading')?.classList.add('done');
        updateHint();
      }
    }

    fpsAcc += dt;
    fpsFrames++;
    if (fpsAcc >= 0.5) {
      const fps = fpsFrames / fpsAcc;
      const msAvg = (fpsAcc / fpsFrames) * 1000;
      // Auto governor: if we sit well under target for 5 s, step the preset down.
      if (qualitySetting === 'auto' && !loading) {
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
      const info = gr.renderer.info.render;
      const st = streamer.store.stats;
      const h = dayNight.hour;
      const hh = Math.floor(h);
      const mm = Math.floor((h - hh) * 60);
      const phase = dayNight.moonPhase;
      const pp = player.renderPos;
      minimap.draw(focus.x, focus.z, freeCam ? fly.yaw : tpc.yaw);
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
          pos: `${pp.x.toFixed(0)}, ${pp.y.toFixed(1)}, ${pp.z.toFixed(0)}`,
          extra: [
            ['Player', `${player.grounded ? 'grounded' : player.swimming ? 'swimming' : 'air'} ${Math.hypot(player.velocity.x, player.velocity.z).toFixed(1)} m/s${freeCam ? ' (free cam)' : ''}`],
            ['Chunks', `${streamer.counts.near}/${streamer.counts.mid}/${streamer.counts.far} <span class="k">n/m/f</span> phys ${physics.terrainColliderCount}`],
            ['Queue', `${streamer.counts.queued} build ${streamer.counts.building} pre ${streamer.counts.prefetch}`],
            ['Fetch', `${st.fetched} (${(st.bytes / 1048576).toFixed(1)} MB) sw ${swActive ? 'on' : 'off'} hit ${st.swHits}`],
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
