import * as THREE from 'three/webgpu';
import worldData from '@data/world.json';
import { TerrainSampler } from '@shared/terrain';
import { terrainConfig } from '@shared/factions';
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
import { CombatView } from './game/combat/combatView';
import { DummyView } from './game/combat/dummyView';
import { PlayerAbilities } from './game/combat/abilities';
import { LocalCombat, type CombatHost } from './game/combat/host';
import { CFG, type SimEntity, type SimEvent } from '@shared/sim/combatSim';
import characterData from '@data/character.json';
import { elementContextAt, worldDays } from '@shared/clock';
import { NetCombat, defaultServerUrl } from './net/netCombat';
import { RemotePlayers } from './game/remotePlayers';
import { AccountClient, type Character } from './net/account';
import type { ElementId } from '@shared/combat';
import { CharacterScreen } from './ui/characterScreen';
import { Hubs } from './world/hubs';
import { hubSpawn, sideOf, factionById, PVP, type FactionId } from '@shared/factions';
import { ZoneHud } from './ui/zoneHud';
import { NpcDialog } from './ui/dialog';
import { keyLabel } from './engine/settings';
import { Hud } from './ui/hud';
import { DebugOverlay } from './ui/debug';
import { ChunkMinimap } from './ui/minimap';
import { SettingsMenu } from './ui/settingsMenu';
import { XpHud, MasteryPanel, PartyUi } from './ui/progressUi';
import { PROG, type Progress } from '@shared/progression';
import { ArtsPanel } from './ui/artsUi';
import { artById } from '@shared/arts';
import { StructureView, ResourceView } from './world/campView';
import { BuildPanel } from './ui/buildUi';
import { campRespawn } from '@shared/campRules';
import { sanitizeInv } from '@shared/building';

const HELP = `Click to capture mouse, Esc for settings
WASD move, Shift sprint, Space jump, V dodge
LMB basic, Q E R F X abilities, Tab target
Hold right mouse: block (time it to counter)
T special art  J arts & quests  K mastery
B camp & bag  C channel (bend-craft)
I invite to party  G talk/gather  P PvP flag
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

  const sampler = new TerrainSampler(terrainConfig());
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
  const hubs = new Hubs((x, z) => sampler.height(x, z), physics);
  scene.add(hubs.group);

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

  // Title screen: account (guest by default) and character choice.
  const params = new URLSearchParams(location.search);
  setLoading('Finding a shard server…', 0.25);
  const account = new AccountClient();
  await account.start(params.has('offline'));
  // Dev/test shortcut: ?char=Name&el=fire&fac=sentinel picks (or creates) that character directly.
  let picked: Character | undefined;
  const quick = params.get('char');
  if (quick) {
    picked = account.characters.find((c) => c.name.toLowerCase() === quick.toLowerCase());
    if (!picked) {
      try {
        picked = await account.create(quick, (params.get('el') ?? 'fire') as ElementId, (params.get('fac') ?? 'sentinel') as FactionId);
      } catch (e) {
        console.warn(`[account] quick character failed: ${(e as Error).message}`);
      }
    }
  }
  if (!picked) {
    const charScreen = new CharacterScreen(account);
    picked = await charScreen.pick();
    charScreen.close();
  }
  const character = picked;
  settings.data.name = character.name;
  settings.data.element = character.element;
  settings.save();

  // Multiplayer: join a shard with this character if the server answers, otherwise play offline.
  spawn.y = Math.max(groundAt(spawn.x, spawn.z), worldData.seaLevel);
  const who = { name: character.name, element: character.element, faction: character.faction };
  const offlineSpawn = () => {
    if (character.pos) return new THREE.Vector3(character.pos[0], 0, character.pos[2]);
    const h = hubSpawn(character.faction);
    return new THREE.Vector3(h.x, 0, h.z);
  };
  let netStatus = account.online ? 'connecting…' : 'offline (no server)';
  let host: CombatHost;
  let start: THREE.Vector3;
  const savedProgress = {
    level: character.level, xp: character.xp ?? 0, mastery: character.mastery ?? {}, discovered: character.discovered ?? [],
    arts: character.arts as Progress['arts'] | undefined, rank: character.rank ?? 1,
    inv: sanitizeInv(character.inv), milestones: character.milestones ?? [],
  } as Partial<Progress>;
  const makeLocal = (at: THREE.Vector3, progress: Partial<Progress> = savedProgress) => {
    const lc = new LocalCombat(who.name, who.element, spawn, groundAt, progress);
    lc.me.faction = who.faction;
    lc.me.side = sideOf(who.faction) ?? '';
    lc.me.pos.copy(at);
    lc.charId = character.id;
    return lc;
  };
  const swimState = { swimming: false };
  if (account.online && account.token) {
    setLoading(`Joining a shard as ${character.name}…`, 0.28);
    try {
      const net = await NetCombat.connect(defaultServerUrl(), { token: account.token, characterId: character.id }, who, swimState, params.get('shard'));
      host = net;
      net.groundAt = groundAt;
      netStatus = `shard ${net.shard}`;
      start = net.me.pos.clone();
      console.info(`[net] joined ${netStatus} as ${net.me.id}`);
    } catch (err) {
      netStatus = `offline (${(err as Error)?.message ?? 'no server'})`;
      console.info(`[net] ${netStatus}`);
      start = offlineSpawn();
      host = makeLocal(start);
    }
  } else {
    start = offlineSpawn();
    host = makeLocal(start);
  }
  start.y = Math.max(groundAt(start.x, start.z), worldData.seaLevel);

  // Player.
  const player = new Player(physics, controls, start, groundAt, worldData.chunkSize);
  Object.defineProperty(swimState, 'swimming', { get: () => player.swimming });
  let avatar = new Avatar(settings.data.element);
  const nameplate = new Nameplate(settings.data.name);
  avatar.root.add(nameplate.sprite);
  scene.add(avatar.root);

  // Combat. The rules live in shared/sim; offline they run in this tab.
  const vfx = new Vfx();
  scene.add(vfx.group);
  const elementContext = () =>
    elementContextAt(sampler, worldData, CFG.elements.water.nearWaterMeters, player.renderPos, dayNight.days, player.swimming, player.grounded, groundAt);
  const abilities = new PlayerAbilities(
    () => host.me,
    () => host.entities.values(),
    controls,
    camera,
    player,
    elementContext,
    (slot, dir) => host.cast(slot, dir),
  );
  const view = new CombatView(vfx, () => host.entities, (e) => (e === host.me ? abilities.aim : yawDir(e.yaw)), () => host.me.id);
  scene.add(view.group);
  const hud = new Hud(settings);
  const remotes = new RemotePlayers(scene, view);
  const keyOf = (action: string) => {
    const k = settings.data.bindings[action]?.[0];
    return k ? keyLabel(k) : action;
  };
  const xpHud = new XpHud(() => keyOf('mastery'));
  const mastery = new MasteryPanel(() => host, () => updateHint());
  const partyUi = new PartyUi(() => host);
  const blindFog = document.createElement('div');
  blindFog.className = 'blind-fog';
  document.body.appendChild(blindFog);
  const zoneHud = new ZoneHud();
  const dialog = new NpcDialog();
  dialog.onTalk = (e) => host.talkTo(e.id);
  const artsPanel = new ArtsPanel(() => host, () => updateHint(), () => keyOf('art'));
  // Camps (Phase 9): structures, resource nodes and the camp panel.
  const structView = new StructureView(physics);
  scene.add(structView.group);
  structView.bind(host.camps);
  const nodeView = new ResourceView(groundAt);
  scene.add(nodeView.group);
  const build = new BuildPanel(
    () => host, scene, groundAt,
    () => ({ build: keyOf('build'), interact: keyOf('interact'), channel: keyOf('channel'), place: keyOf('basic'), rotate: keyOf('defense') }),
    () => updateHint(),
    () => input.requestPointerLock(),
  );
  // Spirit projection: the body stays put, a free camera roams within range and enemies are revealed.
  const spirit = { t: 0, range: 0, origin: new THREE.Vector3() };
  const spiritVeil = document.createElement('div');
  spiritVeil.className = 'spirit-veil';
  const flightBar = document.createElement('div');
  flightBar.className = 'flight-bar hidden';
  flightBar.innerHTML = '<div class="fill"></div>';
  const revealLayer = document.createElement('div');
  revealLayer.className = 'reveal-layer';
  document.body.append(spiritVeil, flightBar, revealLayer);
  let flightTotal = 1;
  const canGlide = () => {
    const g = artById('glider');
    return host.progress.arts.learned.includes('glider') || (!!g && host.me.element === g.element && host.progress.level >= g.level);
  };
  function endSpirit() {
    if (spirit.t <= 0) return;
    spirit.t = 0;
    player.frozen = false;
    spiritVeil.classList.remove('on');
    revealLayer.replaceChildren();
  }
  const revealPos = new THREE.Vector3();
  function updateReveal() {
    revealLayer.replaceChildren();
    if (spirit.t <= 0) return;
    for (const e of host.entities.values()) {
      if (e.dead || e === host.me || e.kind === 'dummy' || e.role === 'master') continue;
      if (e.pos.distanceTo(spirit.origin) > spirit.range) continue;
      revealPos.copy(e.pos).setY(e.pos.y + 2.4).project(camera);
      if (revealPos.z > 1) continue;
      const m = document.createElement('div');
      m.className = 'reveal';
      m.style.left = `${((revealPos.x + 1) / 2) * innerWidth}px`;
      m.style.top = `${((1 - revealPos.y) / 2) * innerHeight}px`;
      m.textContent = e.kind === 'player' ? `◆ ${e.name}` : '◆';
      revealLayer.appendChild(m);
    }
  }
  function togglePvp() {
    const me = host.me;
    if (host instanceof NetCombat) host.setPvp(!me.pvp);
    else if (!me.pvp && me.level < PVP.flagMinLevel) zoneHud.show(`PvP flag unlocks at level ${PVP.flagMinLevel}`, true);
    else {
      me.pvp = !me.pvp;
      zoneHud.show(me.pvp ? 'PvP flag raised' : 'PvP flag lowered');
    }
  }
  const dummyViews = new Map<string, DummyView>();
  const yawDirV = new THREE.Vector3();
  function yawDir(yaw: number) {
    return yawDirV.set(Math.sin(yaw), 0, Math.cos(yaw));
  }

  /** Push the controller's state into the local combat entity, and statuses back out. */
  function syncMe() {
    const me = host.me;
    me.pos.copy(player.renderPos);
    me.yaw = player.facing;
    me.grounded = player.grounded;
    me.ctx = elementContext();
    const wasBlocking = me.blocking;
    me.blocking = player.blocking && !me.dead;
    if (me.blocking && !wasBlocking) me.blockStart = host.time;
    const dodgeT = player.dodgeProgress * characterData.dodge.duration;
    me.invulnerable = player.isDodging && dodgeT >= CFG.dodgeInvulnerable[0] && dodgeT <= CFG.dodgeInvulnerable[1];
    const slow = me.statuses.get('slow');
    player.moveScale = slow ? 1 - slow.amount : 1;
    player.rooted = me.statuses.has('root');
    player.staggered = me.statuses.has('stagger');
    if (me.pendingImpulse.lengthSq() > 0) {
      player.knockback(me.pendingImpulse.clone());
      me.pendingImpulse.set(0, 0, 0);
    }
  }

  function syncEntityViews() {
    for (const e of host.entities.values()) {
      if (e.kind === 'dummy' && !dummyViews.has(e.id)) {
        const v = new DummyView(e);
        dummyViews.set(e.id, v);
        scene.add(v.root);
      }
    }
    for (const [id, v] of dummyViews) {
      if (!host.entities.has(id)) {
        v.dispose();
        dummyViews.delete(id);
      }
    }
  }

  const eventTaps: Array<(e: SimEvent) => void> = [];
  function onCombatEvent(e: SimEvent) {
    for (const tap of eventTaps) tap(e);
    view.handle(e);
    hud.onEvent(e, host.entities, host.me.id);
    const me = host.me;
    switch (e.t) {
      case 'castFail':
        if (e.caster === me.id) abilities.onCastFail(e.slot, e.reason);
        break;
      case 'fly':
        if (e.target === me.id) {
          player.fly(e.duration);
          if (e.duration > 0) flightTotal = e.duration;
        }
        break;
      case 'spirit':
        if (e.target !== me.id) break;
        if (e.duration > 0) {
          spirit.t = e.duration;
          spirit.range = e.range;
          spirit.origin.copy(player.renderPos);
          player.frozen = true;
          fly.yaw = tpc.yaw;
          fly.pitch = tpc.pitch;
          spiritVeil.classList.add('on');
        } else endSpirit();
        break;
      case 'hit':
        // Taking a real hit closes the glider.
        if (e.target === me.id && e.result === 'hit' && e.amount > 0) player.gliding = false;
        break;
      case 'dash':
        if (e.owner === me.id) player.dash(new THREE.Vector3(...e.dir), e.distance, e.duration, e.lift);
        break;
      case 'impulse':
        dummyViews.get(e.target)?.shake(Math.hypot(...e.v));
        break;
      case 'respawn':
        if (e.target === me.id) {
          if (host.online) player.teleport(me.pos.x, me.pos.z);
          else {
            const h = campRespawn(host.camps, host.charId) ?? hubSpawn(character.faction);
            player.teleport(h.x, h.z);
          }
        }
        break;
    }
  }

  function goOffline(reason: string) {
    netStatus = `offline (${reason})`;
    host = makeLocal(player.renderPos.clone(), host.progress);
    structView.bind(host.camps);
    abilities.setElement(settings.data.element);
    console.info(`[net] ${netStatus}`);
  }
  if (host instanceof NetCombat) host.onClose = () => goOffline('disconnected');
  const netReady = Promise.resolve();

  // Offline characters remember where they were.
  const saveLocal = () => {
    if (!host.online && !account.online) {
      const p = host.progress;
      account.saveLocalCharacter(character.id, {
        pos: [player.renderPos.x, player.renderPos.y, player.renderPos.z], name: settings.data.name,
        level: p.level, xp: p.xp, mastery: p.mastery, discovered: p.discovered, arts: p.arts, rank: p.rank,
        inv: p.inv, milestones: p.milestones,
      });
    }
  };
  setInterval(saveLocal, 10_000);
  addEventListener('beforeunload', saveLocal);

  /** Move the local player anywhere (tests, debugging); dev shards accept it. */
  function tp(x: number, z: number) {
    player.teleport(x, z);
    if (host instanceof NetCombat) host.teleport(x, groundAt(x, z), z);
  }

  settings.onChange((s) => {
    if (s.name === host.me.name) return;
    nameplate.set(s.name);
    host.me.name = s.name;
    if (host instanceof NetCombat) host.room.send('profile', { name: s.name });
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
    characterInfo: () => {
      const f = factionById(character.faction);
      return `${character.name} · ${character.element} · ${f?.name ?? character.faction}`;
    },
    onSwitchCharacter: () => {
      saveLocal();
      if (host instanceof NetCombat) host.leave();
      location.reload();
    },
  });

  // "Click to play" hint + crosshair.
  const hint = document.createElement('div');
  hint.className = 'play-hint';
  hint.textContent = 'Click to play · Esc for settings · F3 for help';
  document.body.appendChild(hint);
  const crosshair = document.createElement('div');
  crosshair.className = 'crosshair hidden';
  document.body.appendChild(crosshair);
  function updateHint() {
    hint.classList.toggle('hidden', input.pointerLocked || menu.isOpen || mastery.isOpen || artsPanel.isOpen || build.isOpen || freeCam);
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
      abilities, vfx, view, elementContext, eventTaps, remotes, tp, netReady, account, character, zoneHud, dialog, hubs, xpHud, mastery, partyUi, saveLocal, artsPanel, spirit, build, structView, nodeView,
      get netStatus() { return netStatus; },
      get host() { return host; },
      get me() { return host.me; },
      get dummies() { return [...host.entities.values()].filter((e: SimEntity) => e.kind === 'dummy'); },
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

  // Input is cleared in `finally` so a frame that throws can't leave a key "pressed" forever (repeat casts).
  gr.renderer.setAnimationLoop(() => {
    try {
      frame();
    } finally {
      input.endFrame();
    }
  });
  function frame() {
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
      const me = host.me;
      player.canGlide = canGlide();
      if (spirit.t > 0) {
        spirit.t -= dt;
        fly.update(dt);
        // The spirit can't wander past its range from the body.
        const off = camera.position.clone().sub(spirit.origin);
        if (off.length() > spirit.range) camera.position.copy(spirit.origin).add(off.setLength(spirit.range));
        if (spirit.t <= -1 || me.dead) endSpirit();
      }
      if (freeCam && spirit.t <= 0) fly.update(dt);
      if (!me.dead) player.update(dt, tpc.yaw);
      syncMe();
      if (!freeCam && !mastery.isOpen && !artsPanel.isOpen && !build.busy) abilities.update(dt, me.blocking);
      for (const e of host.update(dt, abilities.aim)) onCombatEvent(e);
      if (host instanceof NetCombat) {
        for (const c of host.corrections.splice(0)) {
          console.warn(`[net] server corrected position: ${c.reason}`);
          player.teleport(c.p[0], c.p[2]);
        }
        dayNight.days = worldDays(host.serverNow);
      }
      remotes.update(dt, host.entities, host.me.id, partyUi.memberIds());
      for (const n of host.notices.splice(0)) zoneHud.show(n.text, n.warn);
      // Progression and parties.
      for (const g of host.xpLog.splice(0)) xpHud.gain(g, host.progress);
      xpHud.update(dt, host.progress);
      if (controls.pressed('mastery')) mastery.toggle();
      if (controls.pressed('artsPanel')) artsPanel.toggle();
      // Camp: B opens the panel (or cancels placing), C channels, LMB/R place and rotate the ghost.
      const buildKey = controls.pressed('build');
      if (buildKey && !build.placing) build.toggle();
      build.update(tpc.yaw, { place: controls.pressed('basic'), rotate: controls.pressed('defense'), cancel: buildKey || me.dead });
      if (controls.pressed('channel') && !build.busy && !freeCam) host.channel();
      nodeView.update(player.renderPos.x, player.renderPos.z);
      artsPanel.update(camera, player.renderPos.x, player.renderPos.z);
      for (const l of host.questLines.splice(0)) dialog.say(l.npc, l.line);
      updateReveal();
      flightBar.classList.toggle('hidden', !player.flying);
      if (player.flying) (flightBar.firstElementChild as HTMLElement).style.width = `${Math.min(100, (player.flightLeft / flightTotal) * 100)}%`;
      mastery.update();
      if (controls.pressed('partyInvite') && !partyUi.inviteLookedAt(camera)) zoneHud.show(`Look at a player within ${PROG.party.inviteRange} m to invite them`, true);
      if (partyUi.pendingInvite && controls.pressed('acceptInvite')) partyUi.answer(true);
      if (partyUi.pendingInvite && controls.pressed('declineInvite')) partyUi.answer(false);
      partyUi.update(dt, { accept: keyOf('acceptInvite'), decline: keyOf('declineInvite') });
      blindFog.classList.toggle('on', me.statuses.has('blind'));
      zoneHud.pvp = me.pvp;
      zoneHud.update(dt, player.renderPos.x, player.renderPos.z);
      const interactKey = settings.data.bindings.interact?.[0];
      const npc = dialog.nearest(host.entities.values(), player.renderPos.x, player.renderPos.z);
      const interact = controls.pressed('interact');
      dialog.update(npc, interact && !!npc, interactKey ? keyLabel(interactKey) : 'Interact');
      // No one to talk to: gather, or open your chest / the forge.
      if (interact && !npc && !build.busy) build.interact();
      if (controls.pressed('pvpFlag')) togglePvp();
      syncEntityViews();
      for (const v of dummyViews.values()) v.update(dt);
      view.update(dt);
      vfx.update(dt);
      avatar.root.position.copy(player.renderPos);
      avatar.root.rotation.y = player.facing;
      const fb = abilities.feedback;
      avatar.update(dt, { ...player.pose(), cast: fb.gesture, castStyle: fb.style });
      avatar.root.rotation.z = me.dead ? Math.PI / 2 : 0;
      hud.update(dt, camera, host.me, abilities, abilities.target);
      if (!freeCam && spirit.t <= 0) tpc.update(dt, player);
    } else {
      tpc.update(0, player);
    }

    const focus = freeCam || spirit.t > 0 ? camera.position : player.renderPos;
    streamer.update(focus, dt);
    dayNight.update(dt, focus, q.shadowDistance);
    dayNight.light.castShadow = q.shadows;
    sky.follow(camera);
    water.follow(camera.position);

    // Behind the loading screen only render occasionally (keeps shaders warm)
    // so the main thread spends its time streaming in the spawn area.
    if (!loading || ++loadingFrames % 20 === 0) gr.render();

    if (loading) {
      const c = streamer.counts;
      setLoading(`Loading nearby land (${c.near + c.mid + c.far} chunks)…`, 0.3 + Math.min(0.7, (c.near + c.mid) / 30));
      if (streamer.nearReady() && physics.terrainColliderCount > 0) {
        loading = false;
        streamer.applyBudget = 3;
        player.teleport(start.x, start.z);
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
            ['Combat', `${abilities.element} vfx ${vfx.count} proj ${view.stats.projectiles} ${host.online ? 'online' : 'offline'}`],
            ['Net', host instanceof NetCombat ? `${netStatus} rtt ${host.rtt} ms, ${remotes.count} others` : netStatus],
            ['Player', `${player.grounded ? 'grounded' : player.swimming ? 'swimming' : 'air'} ${Math.hypot(player.velocity.x, player.velocity.z).toFixed(1)} m/s${freeCam ? ' (free cam)' : ''}`],
            ['Chunks', `${streamer.counts.near}/${streamer.counts.mid}/${streamer.counts.far} <span class="k">n/m/f</span> phys ${physics.terrainColliderCount}`],
            ['Queue', `${streamer.counts.queued} build ${streamer.counts.building} pre ${streamer.counts.prefetch}`],
            ['Fetch', `${st.fetched} (${(st.bytes / 1048576).toFixed(1)} MB) sw ${swActive ? 'on' : 'off'} hit ${st.swHits}`],
          ],
        },
        h,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  setLoading(`Failed to start: ${err?.message ?? err}`, 1);
});
