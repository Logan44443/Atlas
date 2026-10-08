# Four Winds — engineering notes

Browser elemental-bending open-world MMO. Design source of truth: [`docs/DESIGN.md`](docs/DESIGN.md).
This file covers architecture, layout, conventions and the current phase. Update it when decisions change.

## Current phase

- **Phase 1 Foundations**: done (terrain, sky, day/night, grass, quality presets, debug overlay).
- **Phase 2 Chunk streaming**: done (world build script, manifest + hashes, load rings, prefetch, unload, workers, Service Worker cache, LRU, chunk map).
- **Phase 3 Character**: done (Rapier kinematic controller: walk/sprint/jump/dodge/swim/block stance, procedural primitive avatar, over-the-shoulder camera with terrain collision, settings menu with rebinding + display name, nameplate, F2 free camera).
- **Phase 4 Bending v1**: done for all four elements (6 abilities each from `data/abilities/*.json`, chi, block +
  perfect-block counter, dodge i-frames, statuses burn/slow/root/stagger, shields, element/time-of-day modifiers,
  soft matchups, target assist, particle VFX with bloom, HUD, training + sparring dummies). Runs client-side;
  `CombatSystem` never reads input so it can move to the server in Phase 5.
- **Phase 5 Multiplayer**: next.

## Run it

```bash
npm install
npm run dev          # builds the world if world.json/props.json changed, then starts Vite on :5173
npm run build        # typecheck + production build into dist/
npm run world -- --force   # regenerate client/public/world/ (gitignored, ~65 MB, ~15 s)
npm run smoke        # headless Chromium smoke test against a running dev server (screenshots/)
SCENARIO=stream npm run smoke   # fly across the world, then reload and check SW cache hits
SCENARIO=character npm run smoke   # movement + settings menu (rename, rebind)
SCENARIO=combat npm run smoke      # all 4 elements vs dummies + block/perfect-block counter
```

URL flags: `?quality=low|medium|high|auto`, `?webgl` (force WebGL2 backend), `?nosw` (skip Service Worker).
In game: `F3` debug overlay, `F4`/`M` chunk-state map.

## Stack (fixed by design)

TypeScript + Vite, three.js `WebGPURenderer` (`three/webgpu`, auto WebGL2 fallback) with TSL node materials,
Rapier (`@dimforge/rapier3d-compat`), later Node + Colyseus (server-authoritative), PostgreSQL.

## Layout

```
client/              Vite root (index.html, src/, public/)
  src/main.ts        bootstrap + main loop
  src/engine/        renderer (+bloom pipeline), quality presets/auto-detect, input, cameras, service worker registration
  src/world/         sky, day/night, materials (TSL), water, grass, props, chunk streamer/store/worker
  src/game/          physics (Rapier), player controller, avatar, third-person camera, nameplate
  src/game/combat/   CombatSystem (projectiles/areas/hits/statuses), combatants (player, dummies), abilities (input -> casts), VFX particles
  src/ui/            debug overlay, chunk minimap, settings menu, combat HUD, CSS
  public/sw.js       Service Worker (versioned chunk cache)
  public/world/      GENERATED world chunks + manifest.json (gitignored)
shared/              Pure TS used by client, workers, build scripts and (later) the server
  noise.ts           seeded simplex/fbm/ridged
  terrain.ts         TerrainSampler: height(x,z), biome colours, grassiness
  chunkMesh.ts       chunk mesh builder (LOD + skirts), height-grid lookup
  world.ts           chunk keys, file formats, manifest types
  combat.ts          ability/element types, element power (day/night/moon/water/rock), matchups, level scaling
data/                ALL tunable numbers (JSON). Edit these, not code.
  quality.json       Low/Medium/High presets (pixel ratio, shadows, grass, rings, LOD)
  world.json         seed, chunk size (64 m), terrain shape, biome colours, grass, water
  time.json          day length, moon cycle, lighting keyframes by hour
  props.json         tree/rock/bush scatter rules
  controls.json      default key bindings (players override in Settings, saved to localStorage `fw.settings`)
  character.json     movement, dodge, swim and camera tuning
  combat.json, abilities/*.json   bending numbers (Phase 4)
  crafting/combos.json            element combo recipes (Phase 9)
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
- **Determinism**: terrain is a pure function of `world.json`; workers and (later) the server use the same
  `TerrainSampler`, so heights match everywhere.

## Conventions

- Tunable numbers go in `data/*.json`; code reads them via `@data/...` imports.
- `@shared/*` must stay DOM-free and three-free (runs in Node and workers).
- Prefer instancing / merged geometry; check draw calls in the F3 overlay. Budget: 60 FPS High on M4 Air, 30 FPS Low.
- Placeholder art = primitives with vertex colours until mechanics are fun.
- Verify each change in a headless browser (`npm run smoke`). Headless Chromium here has no GPU, so it runs
  the WebGL2 backend on SwiftShader at 1-3 real FPS (sim dt is clamped to 0.1 s, so wait on `combat.time`, not wall
  time): judge correctness there, not performance.
- Ask the owner before paid services, real accounts/payments or big irreversible choices.
