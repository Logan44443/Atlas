import * as THREE from 'three/webgpu';
import worldData from '@data/world.json';
import combatData from '@data/combat.json';
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
import { Vfx } from './game/combat/vfx';
import { CombatSystem } from './game/combat/combatSystem';
import { PlayerCombatant, Dummy } from './game/combat/actors';
import { PlayerAbilities } from './game/combat/abilities';
import { CFG } from './game/combat/combatant';
import { Hud } from './ui/hud';
import { DebugOverlay } from './ui/debug';
import { ChunkMinimap } from './ui/minimap';
import { SettingsMenu } from './ui/settingsMenu';

const HELP = `Click to capture mouse, Esc for settings
WASD move, Shift sprint, Space jump, V dodge
LMB basic, Q E R F X abilities, Tab target
Hold right mouse: block (time it to counter)
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
  let avatar = new Avatar(settings.data.element);
  const nameplate = new Nameplate(settings.data.name);
  avatar.root.add(nameplate.sprite);
  scene.add(avatar.root);

  // Combat (Phase 4). Runs locally for now; moves server-side in Phase 5.
  const vfx = new Vfx();
  scene.add(vfx.group);
  const combat = new CombatSystem(vfx, groundAt);
  scene.add(combat.group);
  const me = new PlayerCombatant(player, settings.data.name, settings.data.element);
  combat.add(me);
  const dummies: Dummy[] = [];
  for (const d of combatData.dummies) {
    const home = new THREE.Vector3(spawn.x + d.offset[0], 0, spawn.z + d.offset[1]);
    home.y = groundAt(home.x, home.z);
    const dummy = new Dummy(d, home, groundAt);
    dummies.push(dummy);
    combat.add(dummy);
    scene.add(dummy.root);
  }
  const elementContext = () => {
    const f = player.renderPos;
    let nearWater = player.swimming;
    const r = CFG.elements.water.nearWaterMeters;
    for (let k = 0; k < 8 && !nearWater; k++) {
      const a = (k / 8) * Math.PI * 2;
      if (groundAt(f.x + Math.cos(a) * r, f.z + Math.sin(a) * r) < worldData.seaLevel) nearWater = true;
    }
    const ny = sampler.slopeY(f.x, f.z);
    const onRock = ny < worldData.biomes.rockSlope + 0.05 || f.y > worldData.biomes.grassMaxHeight;
    return { night: dayNight.nightFactor, sunHeight: dayNight.sunDir.y, moonPhase: dayNight.moonPhase, nearWater, onRock, grounded: player.grounded };
  };
  const abilities = new PlayerAbilities(me, combat, controls, camera, vfx, elementContext);
  const hud = new Hud(settings);
  combat.on((e) => {
    hud.onEvent(e, me.id);
    if (e.kind === 'death' && e.target === me) {
      // Phase 4 has no death penalty yet: get back up at spawn.
      setTimeout(() => {
        me.dead = false;
        me.hp = me.maxHp;
        me.chi = me.maxChi;
        me.statuses.clear();
        player.teleport(spawn.x, spawn.z);
      }, 2000);
    }
  });

  settings.onChange((s) => {
    nameplate.set(s.name);
    me.name = s.name;
    if (s.element !== abilities.element) {
      abilities.setElement(s.element);
      scene.remove(avatar.root);
      avatar.root.remove(nameplate.sprite);
      avatar = new Avatar(s.element);
      avatar.root.add(nameplate.sprite);
      scene.add(avatar.root);
    }
  });

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
      scene, camera, renderer: gr.renderer, dayNight, sampler, streamer, physics, player, settings, menu, input, tpc, swActive,
      combat, me, dummies, abilities, vfx, elementContext,
      get avatar() { return avatar; },
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
    const rawDt = clock.getDelta();
    const dt = Math.min(rawDt, 0.1);

    if (controls.pressed('freeCamera')) {
      freeCam = !freeCam;
      if (freeCam) {
        fly.yaw = tpc.yaw;
        fly.pitch = tpc.pitch;
      }
      updateHint();
    }

    if (!loading) {
      me.sync();
      if (freeCam) fly.update(dt);
      else if (!me.dead) player.update(dt, tpc.yaw);
      // Block stance: remember when it started so perfect-timed blocks can counter.
      const wasBlocking = me.blocking;
      me.blocking = player.blocking && !me.dead;
      if (me.blocking && !wasBlocking) me.blockStart = combat.time;
      if (!freeCam) abilities.update(dt, me.blocking);
      combat.update(dt);
      for (const d of dummies) d.update(dt, combat, me);
      vfx.update(dt);
      avatar.root.position.copy(player.renderPos);
      avatar.root.rotation.y = player.facing;
      const fb = abilities.feedback;
      avatar.update(dt, { ...player.pose(), cast: fb.gesture, castStyle: fb.style });
      avatar.root.rotation.z = me.dead ? Math.PI / 2 : 0;
      hud.update(dt, camera, me, abilities, abilities.target);
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

    fpsAcc += rawDt;
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
            ['Combat', `${abilities.element} x${abilities.power.toFixed(2)} vfx ${vfx.count} proj ${combat.stats.projectiles}`],
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
