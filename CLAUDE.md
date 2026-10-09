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
- **Phase 6 Characters/factions**: done (guest accounts upgradable to username/password, 4 character slots with
  element + faction, PostgreSQL persistence with in-memory fallback, saved position on rejoin, 6 faction hubs with
  walls/stalls/centrepieces, 7 NPC members per hub, safe/wild/contested zones, PvP flag on `P` with level gate,
  spawn protection and low-level damage scaling). Verified with `scripts/phase6-test.mjs`.
- **Phase 7 Progression**: done (XP from NPC/dummy/PvP kills and landmark discovery, levels 1-50 with +2% power
  each, 3-branch mastery tree per element (1 point per level, tiered unlocks, free respec until gold exists),
  crits/armor/chi-regen modifiers, parties of 4 with shared XP within 50 m, anti-griefing XP rules, 6 party combos
  such as Water + Fire steam that blinds). Verified with `scripts/progression-check.ts` and `scripts/phase7-test.mjs`.
- **Phase 8 Special Arts**: done (9 arts from `data/arts.json`: Healing, Lightning with redirect, Metal cable,
  Lava pool -> rock wall, Combustion, Glider, Flight, night-only Bloodbending with faction penalty, Spirit
  Projection; master NPCs with camps, step quests (talk/visit/kill/meditate), Arts panel `J` with quest compass,
  Art slot `T`). Verified with `scripts/phase8-test.mjs`.
- **Phase 9 Building**: done (resource nodes + gathering, bending crafting by channelling (environment and
  same-side ally combos, art upgrades), forge, camps of up to 40 pieces from `data/buildings/pieces.json` with a
  placement ghost, chest storage, campfire respawn, steam vents, element shrine XP, raid windows with Earth bonus,
  24 h burn-down, PostgreSQL `structures`). Crew bases and crew-set raid windows move to Phase 11 with crews.
  Verified with `scripts/building-check.ts` and `scripts/phase9-test.mjs`.
- **Phase 10 Pets + wildlife**: done (wildlife dens with 9 species that give XP and loot, common taming with food +
  trust game, Beastkeeper quests for rare pets behind mini bosses, 3 world bosses + 4 legendary world bosses with
  telegraphed moves, shared rewards, Bond Trial with pity, pets that follow/fight/level/get hungry, ground, flying and
  swimming mounts, pets panel `O`, ride `H`). Same PR: solid trees and boulders (player, projectiles, lightning),
  bending marks on what bending hits, and hub NPCs that give advice fitting the player. Verified with
  `scripts/pets-check.ts` and `scripts/phase10-test.mjs`.
- **Phase 11 Territory wars, crews, polish, deployment**: done (territory wars over 3 shrines + 6 outposts twice a day
  with capture meters, war bands, buffs and income; faction rank 1-10 with Envoy orders, Outlaw bounties, faction
  perks and rank unlocks; coins and the Quartermaster (shop, black market, pardons, fast travel); crews with roles,
  bank, crew XP, crew halls on base plots and crew-set raid windows with sacking; chat channels; world map `M`;
  faction & crew panel `U`). Deployment is prepared but not done: Dockerfile, `fly.toml`, Cloudflare Pages
  `_headers`, `/metrics`, CI, `docs/DEPLOY.md`; real accounts wait for bob. Verified with
  `scripts/territory-check.ts` and `scripts/phase11-test.mjs`.
- Next: whatever bob asks for (deployment once the accounts are picked, art, balance, the hired NPC companion).
- bob prefers several phases/features bundled into one PR rather than one PR per phase.
- README.md is owned by a separate thread: don't edit it from build threads.

## Run it

```bash
npm install
npm run dev          # builds the world if world.json/props.json changed, then starts Vite on :5173
npm run server       # shard server (Colyseus) on :2567 + /api; uses DATABASE_URL, else local Postgres, else memory
npm run dev:all      # both of the above
npm run build        # typecheck + production build into dist/
npm run world -- --force   # regenerate client/public/world/ (gitignored, ~65 MB, ~15 s)
npm run smoke        # headless Chromium smoke test against a running dev server (screenshots/)
SCENARIO=stream npm run smoke   # fly across the world, then reload and check SW cache hits
SCENARIO=character npm run smoke   # movement + settings menu (rename, rebind)
SCENARIO=combat node scripts/smoke.mjs "http://localhost:5173/?offline"   # 4 elements vs dummies + perfect block (offline sim)
node scripts/net-test.mjs          # two browsers on one shard: see each other, hits, PvP, speed-hack correction
node scripts/phase6-test.mjs       # title screen, hub spawn, NPC talk, safe vs contested PvP, patrols, saved position
npx tsx scripts/progression-check.ts   # XP/mastery/combo rules without a browser
node scripts/phase7-test.mjs       # party invite, steam combo, shared XP, discovery level-up, mastery panel, saves
node scripts/phase8-test.mjs       # Healing quest online, night-only Bloodbending, every other art offline
npx tsx scripts/building-check.ts  # placement/inventory/raid/burn/crafting rules without a browser
node scripts/phase9-test.mjs       # gather, channel, ally mud, build a camp with the ghost, chest, raid window, reload, offline camp
npx tsx scripts/pets-check.ts      # solid props, dens, creature XP, taming, hunger, mounts, boss rewards, Bond Trial, advice
node scripts/phase10-test.mjs      # advice, walk into a tree, scorch mark, hunt, tame, pets panel, ride, boss + Bond Trial, offline flying mount
npx tsx scripts/territory-check.ts # war schedule, captures, buffs, income, rank, bounties, orders, crews, crew bases, perks, shop
node scripts/phase11-test.mjs      # capture in a war, Envoy order, shop + travel, crew create/invite/bank/hall/raid, chat, map, panel, offline war
```
Deployment (not done yet, needs bob's accounts): see `docs/DEPLOY.md` (`Dockerfile`, `fly.toml`, Cloudflare Pages).

URL flags: `?quality=low|medium|high|auto`, `?webgl` (force WebGL2 backend), `?nosw` (skip Service Worker),
`?offline` (don't look for a server), `?server=ws://host:port`, `?shard=<roomId>`,
`?char=Name&el=fire&fac=sentinel` (skip the title screen: pick or create that character; tests use it and
`smoke.mjs` adds it by default).
In game: `F3` debug overlay, `F4`/`M` chunk-state map, `G` talk to an NPC, `P` PvP flag, `K` mastery tree,
`I` invite the player in front of you, `Y`/`N` answer an invite, `B` camp panel (bag/build/chest/forge), `C` channel
(bend-craft), `G` also gathers at resource nodes and tames the wild animal in front of you (needs food), `O` pets panel,
`H` ride your pet, `M` world map (`F4` is the chunk map), `U` faction & crew panel, `Enter` chat. Dev shards accept
`dev:xp`, `dev:clock`, `dev:raid`, `dev:give`, `dev:clearCamp`, `dev:boss` (`{id, here, hp}`), `dev:bond` (force the
Bond Trial roll), `dev:pet` (put a pet in your stable), `dev:war` (true/false/null: force the territory war),
`dev:warRate` (capture speed x n), `dev:coins` and `dev:points` (rank points); `LocalCombat` and `NetCombat` have the
same as `devBoss`/`devBond`/`devPet`/`devWar`/`devWarRate`/`devCoins`/`devPoints`.

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
  src/world/hubs.ts  faction hub + shrine buildings (merged geometry, instanced lanterns, box colliders)
  src/world/campView.ts   StructureView (camp pieces: merged primitives + Rapier boxes) and ResourceView (instanced nodes)
  src/world/marks.ts BendingMarks: per-element instanced decals on trunks, boulders and terrain where bending lands
  src/game/creatureView.ts   creatures, bosses and pets (primitive bodies by shape, walk/wing/wind-up anims, HP bars, rider seat)
  src/game/combat/telegraphs.ts   boss danger zones (ring/cone/lane) that fill until the move lands
  src/net/           NetCombat: Colyseus client, entity mirror + interpolation, move/cast messages
  src/net/account.ts AccountClient: guest/register/login, character list (offline: localStorage roster)
  src/ui/            debug overlay, chunk minimap, settings menu, combat HUD, title/character screen, zone HUD, NPC dialog,
                     progressUi (XP bar + toasts, mastery panel, party frame + invite prompt), artsUi (arts panel + quest compass),
                     buildUi (camp panel, placement ghost, gather/channel prompts), petsUi (pets panel, trust game, boss bar,
                     announcements), worldMap (M), factionUi (faction & crew panel U, crew invite prompt, war HUD),
                     chatUi (chat box), shopUi (Quartermaster: buy/sell/pardon/travel), CSS
  src/world/territoryView.ts   outposts, holder flags on every point, capture circles during a war
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
  sim/npcs.ts        faction NPC members (vendors, trainers, envoys, guards, patrols)
  factions.ts        factions, sides, zones (zoneAt), PvP numbers, hub flats -> terrainConfig(), hubSpawn
  names.ts           name/username/password validation shared by client and server
  arts.ts            Special Arts list, ArtsState, QuestRules (talk/visit/kill/meditate), quest status/compass target
  resources.ts       deterministic resource nodes per chunk (+ hub starter nodes), nearestNode/nodeById
  building.ts        pieces, inventories, Camps (placement rules, damage + raid windows, burn-down), snapping
  crafting.ts        CraftRules: gather, channel (environment + ally combos), forge
  campRules.ts       milestone XP, shrine bonus, steam vents, campfire respawn (shared by both authorities)
  props.ts           deterministic tree/rock scatter per chunk (build script + runtime) and Obstacles (solid trunks/boulders)
  sim/wildlife.ts    dens, creature AI, bosses (schedule, phases, telegraphed moves, rewards), Bond Trial spirits
  pets.ts, petsState.ts   pet defs, taming/trust, feeding/hunger, pet AI, mounts, Bond Trial results, Beastkeeper quests
  advice.ts          what hub NPCs tell this player (hunting grounds, mastery points, next art, bosses, pets, raids)
  territory.ts       war points (shrines + outposts), war schedule, Territory (capture meters, buffs, income), presenceAt
  standing.ts        faction rank/points, bounties (infamy), coins helpers, Envoy orders (OrderRules)
  factionRules.ts    kill/boss/capture/held/income rewards (FactionNews), boons, perks, pet eggs, shop and fast travel
  crews.ts           Crews (create/invite/roles/bank/raid hour/sack), crew levels
  sim/warbands.ts    faction NPC fighters at every point during a war
  progression.ts     XP curve, kill/discovery rewards (XpRules), mastery validation, Mods + modKit()
  clock.ts           world clock from wall time (same on every shard/client), bending context at a spot
  net.ts             wire protocol types (move/cast/welcome/correct/events)
server/              Node shard server: index.ts (HTTP /health, /shards, /metrics, /api + Colyseus), worldRoom.ts, schema.ts
  territory.ts       the process-wide Territory (all shards report presence; 1 s tick; crew income to banks)
  crews.ts           the process-wide Crews (batched saves, pushes the crew view to online members)
  online.ts          directory of online characters across shards (faction/whisper chat, crew messages)
  metrics.ts         Prometheus text for /metrics, JSON logs
  api.ts             account/character REST endpoints (rate-limited)
  parties.ts         party/invite bookkeeping per shard
  camps.ts           the process-wide Camps (all shards share it), batched saves, burn-down timer
  db/                Store interface: PgStore (migrations db/*.sql) and MemoryStore
data/                ALL tunable numbers (JSON). Edit these, not code.
  quality.json       Low/Medium/High presets (pixel ratio, shadows, grass, rings, LOD)
  world.json         seed, chunk size (64 m), terrain shape, biome colours, grass, water
  time.json          day length, moon cycle, lighting keyframes by hour
  props.json         tree/rock/bush scatter rules
  controls.json      default key bindings (players override in Settings, saved to localStorage `fw.settings`)
  character.json     movement, dodge, swim and camera tuning
  combat.json, abilities/*.json   bending numbers (Phase 4)
  crafting/combos.json            bending craft recipes: ally pairs, environment sources, art upgrades
  crafting/materials.json         materials, bag/chest size, resource node yields/cooldowns, forge recipes
  buildings/pieces.json, rules.json   camp pieces (size/hp/cost/effect) and camp/raid rules
  net.json           tick/patch rates, shard size, interest radii, interpolation delay, movement tolerances
  factions.json      factions, hub positions/styles/safe radius, NPC roster/levels/names
  zones.json         contested shrines and PvP rules (flag level, spawn protection, low-level scaling)
  accounts.json      character slots, session length, guest rate limit, save interval
  progression.json   XP curve, kill/discovery XP, level factor, PvP repeat rules, party size/share radius
  mastery.json       mastery trees (3 branches x 5 skills per element) and tier unlocks
  partyCombos.json   party combo pairs (steam, magma, firestorm, blizzard, mud, sandstorm)
  arts.json          Special Arts: level, master + camp spot, quest steps, the art's ability, glider/flight tuning
  wildlife.json      den grid, activation radii, creature level by hub distance, the 9 species (temper, attack, loot, tame)
  bosses.json        mini/world/legendary bosses (spot, schedule, HP per player, phases), boss moves, rewards, Bond Trial
  pets/*.json        rules (hunger, food, trust game, follow/assist) and common/rare/legendary pet defs (attack, mount, aura)
  territory.json     war schedule, capture/income per point kind, shrine buffs, war bands, outposts, base plots
  standing.json      rank points/titles/unlocks, bounties, coins, Envoy orders
  crews.json         crew size, founding, levels, bank, base, raid window, sacking
  shop.json          Quartermaster prices, black market, pardons, fast travel
scripts/             build-world.ts, smoke.mjs (+ scenarios/), probe scripts
docs/DESIGN.md       game design (keep in sync)
docs/DEPLOY.md       how to deploy (Fly.io shard server, Cloudflare Pages client, PostgreSQL) once bob approves accounts
Dockerfile, fly.toml, .github/workflows/ci.yml   server image, Fly config, CI (typecheck, rule checks, client build)
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
  production (`NODE_ENV=production`) does not. The shard drops a client that misses `pingMaxRetries` pings
  (`net.json`); a client whose connection closes without `leave()` plays on with `LocalCombat` and retries the same
  shard (then any) after each of `reconnectDelaysMs`, snapping to the position the shard saved.
- **Accounts**: `/api/guest` mints a guest account + session token (localStorage `fw.token`); register upgrades
  it in place. Joining a room requires `{token, characterId}`; `onAuth` checks both and allows one live session
  per character. Positions save on leave and every `saveEverySeconds`.
- **Factions/zones**: `zoneAt(x,z)` is the single source for safe/wild/contested. `canHarm(a,b,time)` in the sim
  applies all damage rules (same side, safe zone, spawn protection, contested vs flagged wilds). Hub and shrine
  sites are levelled through `TerrainConfig.flats`, so every sampler must be built from `terrainConfig()`.
- **Progression**: the authority (WorldRoom online, LocalCombat offline) owns a `Progress` per player and runs
  `XpRules` on `death` events and a 1 s landmark check; clients only display `xp`/`progress` messages. Mastery is
  sent as a whole allocation and always passed through `sanitizeAlloc`. `setMods(entity, computeMods(...))` turns
  it into `entity.mods`; the sim reads abilities through `kitOf(entity)` (memoised `modKit`), so client cooldown
  prediction uses the same numbers. Offline characters save progress to localStorage.
- **Parties/combos**: `entity.party` is set by the room. `CombatSim.comboCheck` marks each party hit on a target;
  a different element from another member within the window spawns the pair's combo area (`combo` event).
- **Special Arts**: `Progress.arts` (learned, equipped, quests, bounty) is owned by the authority like XP.
  `QuestRules` runs `talk` (client sends `quest:talk`, server checks the master is within 8 m), `onKill`, and a 1 s
  `tick` for visit/meditate (meditate needs the player to stand still). The equipped art is `entity.art`, appended
  to the kit by `kitOf` as slot `art`. New ability kinds in the sim: `heal`, `beam` (lightning), `pool` (lava ->
  `Wall`), `grab` (blood), `flight`, `spirit`; `grapple` projectiles. Flight/spirit are toggles: recasting ends them
  and the sim announces the end (`fly`/`spirit` with duration 0). The client runs the movement side (`Player.fly`,
  glider, `frozen` during spirit). Dev shards accept `dev:xp` and `dev:clock` (shift the shard clock in hours).
- **Camps/crafting**: `Camps` (shared/building.ts) holds every structure and a `solids` map of boxes the sim
  reads: solid pieces stop projectiles, and players' bending that reaches a structure emits an internal
  `structHit` event. The authority passes it to `Camps.damage` (other side, raid window, not in a safe zone,
  Earth x1.5) and broadcasts a `struct` event for VFX. Online one `Camps` lives in `server/camps.ts` for the whole
  process; each room listens for changes and streams structures within 320 m to its clients (`structs` /
  `structDel`); clients keep a mirror `Camps` so the placement ghost runs the same `check()`. Materials live in
  `Progress.inv`, chest contents on the chest structure. `CraftRules` keeps channel windows and cooldowns per
  room/tab. Offline camps are saved to localStorage `fw.camps`.
- **Solid props**: `shared/props.ts` `chunkProps()` is the one scatter used by `build-world.ts` (chunk `.json`) and at
  runtime; `obstacleOf()` turns a pine/broadleaf/rock into a cylinder (`data/props.json` `solid`). The client adds
  Rapier cylinders for near chunks (`Physics.addPropChunk`); the sim asks `obstacleAt` (an LRU `Obstacles` per process)
  so projectiles end and lightning stops on trunks. Changing `props.json` changes the world hash: rebuild the world.
- **Wildlife/bosses**: `Wildlife` (shared/sim/wildlife.ts) is owned by the authority next to the sim: `update()` fills
  and empties dens around players once a second and runs creature/boss brains; `onDeath()` returns `WildNews` (xp,
  loot, notices, announcements, bond/rare/trial) that the host applies. Creature XP goes through `XpRules` (bounty);
  boss XP comes only from `onDeath` (entity.damagers, credited to pet owners). Boss moves are ordinary `AbilityDef`s
  run with `sim.perform()` after a wind-up; the `tele` event paints the danger zone. Dead brains linger 3 s so the
  host can read them before cleanup. Boss schedules use the world clock (shifted by `dev:clock` online).
- **Pets**: `PetRules` (shared/pets.ts) keeps one pet entity (`pet_<ownerId>`, kind `pet`, `owner`) per player,
  synced from `Progress.pets` every tick (aura/charge perks set on the owner). Pets copy their owner's side/flags, and
  `canHarm` never lets owner and pet hurt each other. Hunger is wall-clock (`fedAt`). Taming: `startTame` (eats food,
  calms the creature, client gets a `trust` game) then `finishTame` (server checks the offer window and minimum
  time). Mounting emits `mount`; the client sets `Player.mount` (speed, fly, swim) and draws its own mount under the
  predicted position (`CreatureView.myMount`); the server widens the move budget and allows height for flying mounts.
  Bond Trial spirits have `trialOf`: `canHarm` makes them a duel.
- **NPC advice**: `adviceFor()` (shared/advice.ts) is a pure function of the player, their progress and the world
  clock, so the dialog computes it in the browser for every non-master NPC; masters and Beastkeepers also ask the
  authority (`quest:talk`) for quest lines.
- **Territory wars**: one `Territory` per process (`server/territory.ts`). Every room reports who stands in which
  capture circle (`reportPresence`); a 1 s tick merges the reports, runs `Territory.update` and hands `TerrNews` to
  every room, which rewards its own players (`factionRules.ts`) and raises/disbands `WarBands`. Clients get a `terr`
  message every second (war text, point states, crew halls). Offline, `LocalCombat` runs its own `Territory` (saved
  to localStorage `fw.territory`). Held points become `entity.boon` (dmg/regen/heal/armor) via `boonFor` and an XP
  multiplier via `xpScale`.
- **Standing**: `Progress.standing` (points, infamy, honour, coins, order, eggs) is owned by the authority; `rank` is
  always `rankOf(points)`. `entity.infamy` replicates as `inf` (nameplate skull, Sentinel perk). Envoy talks go
  through `quest:talk` like masters; Quartermaster trades are `shop` messages checked against the vendor's range.
- **Crews**: online only. `server/crews.ts` keeps one `Crews` per process; rooms handle `crew` messages and push the
  crew view (`crew`) to online members through `server/online.ts`. Crew structures carry `crew` (and the hall
  `tag`/`raidStart`); `Camps.raidWindow` uses the crew's hour. Crews save before camps (FK). `entity.tag`
  replicates as `tag` for nameplates. Chat (`chat` message) routes say/shard/faction/crew/party/whisper with a rate
  limit; faction, crew and whisper cross shards through the online directory.
- **NPCs**: the same `shared/sim/npcs.ts` brains run on the server and in `LocalCombat`. Offline every hub's NPCs
  are local, so `RemotePlayers` hides avatars beyond the interest radius to match what online would draw.

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
