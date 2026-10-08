# Four Winds — engineering notes

Browser elemental-bending open-world MMO. Design source of truth: [`docs/DESIGN.md`](docs/DESIGN.md).
This file covers architecture, layout, conventions and the current phase. Update it when decisions change.

## Current phase

- **Phase 1 Foundations**: done (terrain, sky, day/night, grass, quality presets, debug overlay).
- **Phase 2 Chunk streaming**: done (world build script, manifest + hashes, load rings, prefetch, unload, workers, Service Worker cache, LRU, chunk map).
- **Phase 3 Character**: done (Rapier kinematic controller: walk/sprint/jump/dodge/swim/block stance, procedural primitive avatar, over-the-shoulder camera with terrain collision, settings menu with rebinding + display name, nameplate, F2 free camera).
- **Phase 4 Bending v1**: done for all four elements (6 abilities each from `data/abilities/*.json`, chi, block +
  perfect-block counter, dodge i-frames, statuses burn/slow/root/stagger, shields, element/time-of-day modifiers,
  soft matchups, target assist, particle VFX with bloom, HUD, training + sparring dummies).
- **Phase 5 Multiplayer**: done (Colyseus 0.16 shard rooms of 80, auto-assign or `?shard=<id>`, spawn points,
  server-authoritative combat from `shared/sim`, movement validation with corrections, StateView interest
  management, remote avatars interpolated ~110 ms behind, shared world clock, offline fallback, opt-in PvP flag
  plumbing). Verified with `scripts/net-test.mjs` (two browsers).
- **Phase 6 Characters/factions**: next.

## Run it

```bash
npm install
npm run dev          # builds the world if world.json/props.json changed, then starts Vite on :5173
npm run server       # shard server (Colyseus) on :2567; the client joins it automatically if it answers
npm run dev:all      # both of the above
npm run build        # typecheck + production build into dist/
npm run world -- --force   # regenerate client/public/world/ (gitignored, ~65 MB, ~15 s)
npm run smoke        # headless Chromium smoke test against a running dev server (screenshots/)
SCENARIO=stream npm run smoke   # fly across the world, then reload and check SW cache hits
SCENARIO=character npm run smoke   # movement + settings menu (rename, rebind)
SCENARIO=combat node scripts/smoke.mjs "http://localhost:5173/?offline"   # 4 elements vs dummies + perfect block (offline sim)
node scripts/net-test.mjs          # two browsers on one shard: see each other, hits, PvP, speed-hack correction
```

URL flags: `?quality=low|medium|high|auto`, `?webgl` (force WebGL2 backend), `?nosw` (skip Service Worker),
`?offline` (don't look for a server), `?server=ws://host:port`, `?shard=<roomId>`.
In game: `F3` debug overlay, `F4`/`M` chunk-state map.

## Stack (fixed by design)

TypeScript + Vite, three.js `WebGPURenderer` (`three/webgpu`, auto WebGL2 fallback) with TSL node materials,
Rapier (`@dimforge/rapier3d-compat`), Node + Colyseus 0.16 (`@colyseus/core`, `@colyseus/schema` 3 with
StateView, `colyseus.js` client; versions pinned), later PostgreSQL.

## Layout

```
client/              Vite root (index.html, src/, public/)
  src/main.ts        bootstrap + main loop
  src/engine/        renderer (+bloom pipeline), quality presets/auto-detect, input, cameras, service worker registration
  src/world/         sky, day/night, materials (TSL), water, grass, props, chunk streamer/store/worker
  src/game/          physics (Rapier), player controller, avatar, third-person camera, nameplate
  src/game/combat/   host (CombatHost: LocalCombat offline), CombatView (sim events -> meshes/VFX), DummyView, abilities (input -> cast requests), VFX particles
  src/game/remotePlayers.ts   avatars + nameplates for other players
  src/net/           NetCombat: Colyseus client, entity mirror + interpolation, move/cast messages
  src/ui/            debug overlay, chunk minimap, settings menu, combat HUD, CSS
  public/sw.js       Service Worker (versioned chunk cache)
  public/world/      GENERATED world chunks + manifest.json (gitignored)
shared/              Pure TS used by client, workers, build scripts and (later) the server
  noise.ts           seeded simplex/fbm/ridged
  terrain.ts         TerrainSampler: height(x,z), biome colours, grassiness
  chunkMesh.ts       chunk mesh builder (LOD + skirts), height-grid lookup
  world.ts           chunk keys, file formats, manifest types
  combat.ts          ability/element types, element power (day/night/moon/water/rock), matchups, level scaling
  sim/combatSim.ts   AUTHORITATIVE combat rules (casts, projectiles, areas, hits, block/counter, statuses) -> SimEvents
  sim/dummies.ts     training/sparring dummy AI
  clock.ts           world clock from wall time (same on every shard/client), bending context at a spot
  net.ts             wire protocol types (move/cast/welcome/correct/events)
server/              Node shard server: index.ts (HTTP /health, /shards + Colyseus), worldRoom.ts, schema.ts
data/                ALL tunable numbers (JSON). Edit these, not code.
  quality.json       Low/Medium/High presets (pixel ratio, shadows, grass, rings, LOD)
  world.json         seed, chunk size (64 m), terrain shape, biome colours, grass, water
  time.json          day length, moon cycle, lighting keyframes by hour
  props.json         tree/rock/bush scatter rules
  controls.json      default key bindings (players override in Settings, saved to localStorage `fw.settings`)
  character.json     movement, dodge, swim and camera tuning
  combat.json, abilities/*.json   bending numbers (Phase 4)
  crafting/combos.json            element combo recipes (Phase 9)
  net.json           tick/patch rates, shard size, interest radii, interpolation delay, movement tolerances
scripts/             build-world.ts, smoke.mjs (+ scenarios/), probe scripts
docs/DESIGN.md       game design (keep in sync)
```

## Architecture notes

- **Rendering**: `GameRenderer` wraps `WebGPURenderer`. Bloom runs via `RenderPipeline` with an MRT `emissive`
  target, so only emissive things glow (sky discs now, VFX later). Materials that write custom MRT must use
  `registerBloomSource()` — attaching an MRT node while bloom is off breaks WebGL draws.
- **Look**: `MeshToonNodeMaterial` with a 4-step ramp (`TOON_RAMP`) + baked vertex colours; Neutral tone mapping.
- **Day/night**: `DayNight` owns the game clock (`days`, `hour`, `moonPhase`, `nightFactor`), one directional
  light that follows the sun by day and moon by night (texel-snapped shadow frustum), hemisphere light and fog.
  `nightFactor`/`moonPhase` are what Water/Fire bonuses will read later.
- **World streaming**: `scripts/build-world.ts` writes `manifest.json` (version + per-chunk hash) and per chunk
  `{cx}_{cz}.bin` (65×65 int16 cm heights) + `.json` (props, npcSpawns, resourceNodes, basePlots). Chunk
  coordinates: world `x = cx * 64`, the world is centred on 0,0. `.bin` stands in for the design's `.glb` until
  real art exists; the manifest/hash/cache flow is the same.
  `ChunkStore` = LRU → fetch (`?v=hash`) → Service Worker cache → server. `ChunkStreamer` computes rings
  (near/mid/far from `quality.json`) with hysteresis, prioritises chunks ahead of travel, prefetches data along
  the velocity, unloads beyond far+1.5, builds meshes in a worker pool and uploads a bounded number per frame.
  Near chunks fire `onNear`/`onLeaveNear` hooks (physics colliders hang off these).
- **Character**: `Player` runs a fixed 60 Hz step on Rapier's `KinematicCharacterController` and interpolates for
  rendering. Terrain colliders are Rapier heightfields for near chunks only (column-major, rows along Z). If a
  chunk's collider isn't loaded yet the player is held on the analytic ground. Input goes through `Controls`
  (action ids from `controls.json`) so rebinding never touches gameplay code.
- **Determinism**: terrain is a pure function of `world.json`; workers and the server use the same
  `TerrainSampler`, so heights match everywhere.
- **Combat authority**: `shared/sim/CombatSim` owns the rules and emits `SimEvent`s. The client talks to a
  `CombatHost`: `LocalCombat` runs the sim in the tab (offline), `NetCombat` forwards casts to the shard and
  mirrors server state. `CombatView` and the HUD only consume events and entity state, so they're identical
  online and offline. Cooldowns are predicted client-side; `castFail` resets them.
- **Multiplayer**: `WorldRoom` ticks the sim at 20 Hz. Clients send `move` (predicted position, aim, block,
  dodge i-frame flag) at 20 Hz; the server checks speed (with allowances for dash/dodge/knockback), height and
  bounds and answers `correct` when it rejects one. Blocking start is stamped server-side so perfect blocks are
  authoritative. Knockback/pull come back as `imp`; nearby events as `ev`. Each client's StateView holds
  entities within 3 chunks and drops them past 4. Dev servers accept a `tp` message (tests, free cam);
  production (`NODE_ENV=production`) does not.

## Conventions

- Tunable numbers go in `data/*.json`; code reads them via `@data/...` imports.
- `@shared/*` must stay DOM-free (runs in Node and workers). It may import `three` math classes
  (`Vector3`), never `three/webgpu` or anything that renders.
- Prefer instancing / merged geometry; check draw calls in the F3 overlay. Budget: 60 FPS High on M4 Air, 30 FPS Low.
- Placeholder art = primitives with vertex colours until mechanics are fun.
- Verify each change in a headless browser (`npm run smoke`). Headless Chromium here has no GPU, so it runs
  the WebGL2 backend on SwiftShader at 1-3 real FPS (sim dt is clamped to 0.1 s, so wait on `host.time`, not wall
  time): judge correctness there, not performance.
- Ask the owner before paid services, real accounts/payments or big irreversible choices.
