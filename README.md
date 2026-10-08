# Four Winds

A browser-based multiplayer open-world game about elemental bending. Pick one of four elements (Water,
Earth, Fire or Air), join one of six factions split across two sides (Order and Outlaw), and explore,
fight, level up, build and tame pets in a shared world with other players. Players open a link and play:
nothing to install.

- **Design (source of truth):** [docs/DESIGN.md](docs/DESIGN.md)
- **Engineering notes (architecture, folder layout, conventions):** [CLAUDE.md](CLAUDE.md)

## At a glance

| | |
|---|---|
| Platform | Web only. Desktop browsers first; touch controls come in the polish phase. |
| Client | TypeScript, Vite, three.js `WebGPURenderer` (automatic WebGL2 fallback), Rapier physics (WASM) |
| Server | Node.js + Colyseus 0.16, server-authoritative for combat, XP, inventory, building and taming |
| Storage | PostgreSQL (accounts, characters, bases, pets); falls back to memory in development |
| Hosting (planned) | Static client and world chunks on a CDN, game servers on a small VPS or Fly.io |
| Art | Stylized and painterly: toon shading, strong silhouettes, bright elemental effects, day/night, fog, bloom |
| Tuning | Every number (abilities, XP, factions, zones, pets, buildings) lives in JSON under `data/` |
| Performance target | 60 FPS on an M4 MacBook Air (High preset), 30 FPS on low-end hardware (Low preset) |

## Build status

The game is built in 11 phases, in order. Each phase ends with something you can play. Status as of
**8 October 2026**:

| # | Phase | Status |
|---|---|---|
| 1 | [Foundations](#phase-1-foundations) | ✅ Done |
| 2 | [Chunk streaming](#phase-2-chunk-streaming) | ✅ Done |
| 3 | [Character](#phase-3-character) | ✅ Done |
| 4 | [Bending v1](#phase-4-bending-v1) | ✅ Done |
| 5 | [Multiplayer](#phase-5-multiplayer) | ✅ Done |
| 6 | [Characters and factions](#phase-6-characters-and-factions) | 🔨 In progress |
| 7 | [Progression](#phase-7-progression) | ⏳ Planned |
| 8 | [Special Arts](#phase-8-special-arts) | ⏳ Planned |
| 9 | [Building](#phase-9-building) | ⏳ Planned |
| 10 | [Pets](#phase-10-pets) | ⏳ Planned |
| 11 | [Territory wars, crews, polish and deployment](#phase-11-territory-wars-crews-polish-and-deployment) | ⏳ Planned |

The game code for phases 1 to 6 lives on the build branch `claude/four-winds-foundations-89h5z4`
([pull request #1](https://github.com/Logan44443/Atlas/pull/1)) until it is merged into `main`.

---

## The phases in detail

### Phase 1: Foundations

**Status: ✅ Done**

**Goal:** a project skeleton and a world that looks like the game, running smoothly in a browser.

What this phase sets out to do:
- Set up Vite + TypeScript + three.js with the WebGPU renderer, falling back to WebGL2 on browsers without WebGPU.
- Draw stylized terrain, a sky, and a day/night cycle with sun, moon and stars.
- Add wind-animated grass and water.
- Provide Low / Medium / High quality presets, auto-detected from the device, so laptops and phones can run it.
- Add an FPS and debug overlay for watching performance (frame rate, draw calls).

What was built:
- Procedural terrain with toon (cel) shading and baked vertex colours per biome.
- Seeded procedural terrain (continents, hills, mountains, coastlines) with biomes from sand to snow.
- Gradient sky with sun, moon and stars; a data-driven day/night cycle (`data/time.json`, 24 real minutes per
  in-game day) that moves one
  shadow-casting light between sun and moon and tracks moon phase (later read by Water and Fire bonuses).
- Instanced, wind-animated grass; water surfaces; bloom so only glowing things glow.
- Quality presets in `data/quality.json` with auto-detect and an FPS governor that steps quality down if the
  frame rate drops.
- `F3` debug overlay.

**Done when:** the world renders without errors on WebGPU and WebGL2, all three presets work, and the overlay shows live stats.

**How it was checked:** in headless Chromium (WebGL2), with screenshots at noon, dusk and night.

### Phase 2: Chunk streaming

**Status: ✅ Done**

**Goal:** a world far bigger than what fits in memory, loaded piece by piece as you move.

What this phase sets out to do:
- Split the world into a grid of 64 m chunks, each with its terrain and a list of props, NPC spawns,
  resource nodes and base plots, plus a `manifest.json` listing every chunk with a version hash.
- Load chunks in rings around the player: **near** = full detail, physics and NPCs; **mid** = simpler
  meshes, no physics; **far** = low-poly terrain; **beyond** = fog.
- Prefetch chunks in the direction of travel, and unload chunks well behind the player.
- Cache in three layers: CDN, then a Service Worker cache (versioned, so only changed chunks are
  re-downloaded), then an in-memory cache of recent chunks.
- Show chunk states in a debug view.

What was built:
- A 4 km × 4 km world: a 64 × 64 grid of 64 m chunks.
- `scripts/build-world.ts` generates the world into `client/public/world/` (manifest plus per-chunk height
  and prop files with content hashes). Terrain is a pure function of `data/world.json`, so every client,
  worker and the server see the same heights.
- Near/mid/far rings with hysteresis, prefetch along your velocity, unloading, and mesh building in a pool of
  background workers so streaming does not stutter the frame.
- In-memory LRU cache plus a versioned Service Worker cache (reloading the page reuses chunks).
- Chunk-state minimap on `F4` or `M`.

**Done when:** you can travel across the whole world without hitches and a reload pulls chunks from the cache.

**How it was checked:** a headless test flies across the world, then reloads; the reload served 212 chunks from
the Service Worker cache with 0 network fetches.

### Phase 3: Character

**Status: ✅ Done**

**Goal:** a character that feels good to move around the world.

What this phase sets out to do:
- A third-person controller: walk, run, jump and dodge, on Rapier physics.
- A third-person camera.
- Character animations.
- A settings menu where players can rebind every control and change their display name.

What was built:
- Rapier kinematic character controller with walk, sprint, jump (with coyote time and input buffering),
  dodge roll, swimming and a block stance. Physics colliders exist only for near-ring chunks.
- A placeholder avatar made of primitives with walk, run, jump, roll and swim poses (real models come later,
  once the mechanics are fun).
- Over-the-shoulder camera with zoom and terrain collision; `F2` free camera for debugging.
- Settings menu (`Esc` or the gear button): display name with validation, mouse sensitivity, invert Y,
  graphics quality, and full control rebinding with conflict warnings and reset to defaults. Defaults live
  in `data/controls.json`; movement tuning in `data/character.json`.

**Done when:** walking, jumping, dodging and swimming work on real terrain, and rebinding and renaming save between visits.

**How it was checked:** a headless test walks, sprints, jumps, dodges, renames the character and rebinds a key.

### Phase 4: Bending v1

**Status: ✅ Done**

**Goal:** the core of the game: fun, readable elemental combat.

What this phase sets out to do:
- Start with Fire: 6 abilities (Basic, Heavy, Mobility, Defense, Control, Ultimate), effects, the chi
  resource, block and counter, and training-dummy NPCs to fight. Then add the other three elements.
- Give each element its role: Water controls and sustains (stronger at night and near water), Earth tanks
  (must stay grounded, stronger on rock), Fire bursts (stronger by day), Air is fast and evasive.
- Make matchups a small edge (about 10%), not a hard counter.

What was built, all four elements at once:

| Element | Basic | Heavy | Mobility | Defense | Control | Ultimate |
|---|---|---|---|---|---|---|
| Fire | Fire Jab | Fire Blast | Jet Dash | Fire Shield | Flame Ring | Inferno Breath |
| Water | Water Whip | Ice Spikes | Wave Surf | Ice Wall | Freeze | Tidal Surge |
| Earth | Rock Throw | Boulder Smash | Pillar Launch | Stone Armor | Quake Root | Earthquake Ring |
| Air | Air Slice | Air Cannon | Air Scooter | Air Bubble | Vortex Pull | Tornado |

- Chi that regenerates faster out of combat; hold-to-block with a perfectly timed block that counters
  (reflects projectiles, staggers melee); dodge invulnerability frames.
- Status effects: burn, slow, root and stagger. Shields that block or reflect projectiles.
- Element power that changes with time of day, moon phase, nearby water and standing on rock; soft matchups.
- Target assist from the crosshair plus `Tab` target lock.
- Particle effects, a combat HUD (health, chi, ability bar with cooldowns and bound keys, target frame,
  floating damage numbers), training dummies and a sparring dummy that telegraphs and fights back.
- Every number is in `data/abilities/*.json` and `data/combat.json`.

**Done when:** every ability of every element works against the dummies, and perfect blocks counter.

**How it was checked:** a headless test fires all 24 abilities at the dummies and lands perfect-block counters.

### Phase 5: Multiplayer

**Status: ✅ Done**

**Goal:** many players in the same world, with a server that decides what really happened.

What this phase sets out to do:
- Colyseus "shard" rooms, each one copy of the world holding about 80 players.
- A join flow: pick a shard or get auto-assigned, receive a spawn point, and load that area first behind
  the loading screen.
- Smooth movement for other players (interpolation).
- Server-authoritative hits, so a modified client cannot fake damage.
- Interest management: each client only receives what is happening in nearby chunks.

What was built:
- The combat rules moved into shared code (`shared/sim`) that runs on the server online and in the browser
  offline, so the game looks and plays the same either way.
- Shard server (`server/`) with rooms of 80, auto-assign or `?shard=<id>`, spawn points, a 20 Hz simulation,
  movement checks (speed, height, bounds) that correct cheaters, and per-client interest areas.
- Other players drawn about 110 ms behind for smooth motion; one shared world clock so day/night matches on
  every screen; ping display.
- Opt-in PvP flag plumbing; if no server answers, the game falls back to offline play.
- Two-browser automated test (`scripts/net-test.mjs`): players see each other, land hits, PvP works and a
  speed hack gets corrected.

**Done when:** two browsers on one shard see each other move, hits land the same for both, and a speed hack gets corrected.

**How it was checked:** `scripts/net-test.mjs` runs two browsers and passes all of those checks.

### Phase 6: Characters and factions

**Status: 🔨 In progress**

**Goal:** a real identity in the world: an account, characters, a side and a home town.

What this phase sets out to do:
- Accounts and character creation: up to 4 characters, each with a permanent element and a faction.
- The six factions, three per side, each with a hub, its own NPC members and a perk:
  - **Order:** Sentinel Corps (city police), Lantern Order (shrine-guarding monks), Free Isles League (sailors).
  - **Outlaw:** Red Fang Triad (street gang), Ash Syndicate (smugglers), Hollow Moon Cult (forbidden arts).
- Faction hubs with NPC members: vendors, trainers, quest givers, guards and patrols.
- Zones with different PvP rules: **safe** hubs (no PvP), **wilds** (opt-in PvP flag, +25% XP when flagged),
  **contested** territories (always PvP).
- The PvP flag, plus anti-griefing basics: spawn protection and no flagging below level 10.

Built so far:
- Accounts stored in PostgreSQL (memory fallback in development) with migrations. You start as a guest and
  can upgrade to a named account with a password.
- Title screen with up to 4 characters: name, permanent element and faction.
- Six hub towns (Sentinel Bastion, Lantern Monastery, Driftwood Harbor, Fang Alley, Cinder Wharf, Hollow
  Sanctum) plus three contested shrines (Ember, Tide and Stone).
- Zone banner and zone PvP rules, 10 s spawn protection, reduced damage against much lower-level players, and
  the level-gated PvP flag (`P`).
- Faction NPCs (vendor, trainer, envoy, guards, patrols) that work online and offline; talk to them with `G`;
  patrols fight the other side.
- Characters spawn at their hub and come back where they logged out.

**Done when:** a new player can create a character through the UI, spawn in their hub, talk to NPCs, be safe in
hubs, fight rivals at the contested shrines, and rejoin where they left.

**Where it stands:** built and pushed; 9 of 10 checks in the Phase 6 browser test (`scripts/phase6-test.mjs`)
pass. Still to do: PvP at the contested shrines isn't dealing damage yet. Once that is fixed and the test passes
end to end, this phase is done.

### Phase 7: Progression

**Status: ⏳ Planned**

**Goal:** a reason to keep playing: getting stronger, alone or with friends.

What this phase sets out to do:
- XP from NPC kills, quests, PvP kills (scaled by level difference), captures, taming, building and exploring
  landmarks.
- Bending Level 1 to 50. Each level gives +2% bending power and 1 mastery point.
- A mastery tree per element with 3 branches (for Fire: Precision, Inferno and Breath), with a paid respec.
- Parties of up to 4 same-side players with shared XP within 50 m and party markers.
- Anti-griefing: no XP for killing players 10+ levels below you (and they take less damage), diminishing XP
  for repeatedly killing the same player.
- Party combat combos, for example Water + Fire making a blinding steam cloud.
- Faction perks that depend on XP and bounties start working (Red Fang Triad PvP XP, Sentinel Corps bounty damage).

**Done when:** you can level from 1 upward, spend mastery points, party up and share XP, and griefing low-level players earns nothing.

### Phase 8: Special Arts

**Status: ⏳ Planned**

**Goal:** advanced bending to chase, each with a clear limit so none is overpowered.

What this phase sets out to do:
- Master NPCs hidden in the world, with mastery quests that unlock each art (plus a level and sometimes a faction rank).
- Then add the arts one at a time:

| Art | Element | Unlock | Limit |
|---|---|---|---|
| Healing | Water | Lv 15 + Lantern shrine quest | Halved while fighting players |
| Metalbending (with cable grapple) | Earth | Lv 20 + mining-city master | Only works on metal |
| Lightning | Fire | Lv 20 + storm-peak trial | Can't move while charging; can be redirected back at you |
| Lavabending | Earth | Lv 35 + volcano master | Long cooldown; lava cools into rock after 8 s |
| Combustion | Fire | Lv 35 + rare world-boss scroll | Telegraphed glow; 45 s cooldown |
| Flight | Air | Glider at Lv 10, true flight at Lv 40 + monastery trial | No attacks while flying; stamina drains faster in combat |
| Bloodbending | Water | Lv 40 + forbidden quest | Night only; Order players lose faction rank and gain a bounty |
| Spirit Projection | Any | Lv 45 + spirit-world questline | Your body is vulnerable while you scout |

**Done when:** each art can be found, earned through its quest, and used within its limit.

### Phase 9: Building

**Status: ⏳ Planned**

**Goal:** leave a mark on the world: a camp of your own, things crafted by bending, and a crew fortress.

What this phase sets out to do:
- **Camps** (solo, in the wilds): campfire, tent and storage chest; acts as your respawn point; one per player;
  burns down after 24 hours offline; not within 100 m of a hub.
- **Bending crafting**: two elements combined at the same spot within about 1.5 s make a material or a
  structure. Examples: Water + Earth = mud, Fire + Water = steam, Fire + Earth = glass or magma brick,
  Air + Fire = a forge for smelting. Solo players can combine their element with the world (Fire on sand =
  glass, Air on ash = charcoal). The server checks both casters, range and timing; recipes are in
  `data/crafting/combos.json`.
- **Crew bases** on claimed plots: snap-grid walls, gates, towers, workshop, pet stable, training dummy and an
  element shrine, upgraded through wood, stone, metal and spirit-warded tiers.
- **Raid windows**: enemies can raid a base only during scheduled windows the crew sets, so it cannot be wiped
  while its owners are offline. The base core can be damaged but never deleted.

**Done when:** you can place a camp, craft with a partner by combining elements, build a crew base, and defend it during a raid window.

### Phase 10: Pets

**Status: ⏳ Planned**

**Goal:** companions and mounts, from easy to legendary.

What this phase sets out to do:
- **Common pets** (fox-hound, shell turtle, glider lemur): feed one in the wild, then win a short trust minigame.
- **Rare pets** (armored rhino mount, polar-wolf, eel-hound): a questline and a mini-boss fight; +10% to their
  skills if they match your element.
- **Legendary pets** (Sun Dragon, Cloud Bison, Tide Serpent, Burrow Titan): a world boss that spawns in one region
  a few times a day with a server-wide announcement, fought by a group of 4 to 12 for 10+ minutes. Winners get
  about a 5% chance (rising with bad-luck protection) at a hard solo Bond Trial, and must match the pet's
  element to bond. Legendaries give a flying or swimming mount, a rider combo ability and a +15% element aura.
- Pets level up with you, need feeding and care, and only one is active at a time.

**Done when:** you can tame a common pet, earn a rare one, and a group can beat a legendary world boss with a chance at the Bond Trial.

### Phase 11: Territory wars, crews, polish and deployment

**Status: ⏳ Planned**

**Goal:** the faction-versus-faction endgame, and the game live on the internet.

What this phase sets out to do:
- **Territory wars**: factions capture shrines and outposts in contested zones for buffs and resource income,
  on a schedule (for example twice a day), with faction NPCs fighting alongside players.
- **Crews** (guilds) of up to 30 players within one faction, sharing a base, a bank and a crew rank; one hired
  NPC companion per player.
- **Polish**: real art and animation in place of the primitive placeholders, sound, touch controls for phones,
  gamepad support, and performance tuning.
- **Deployment**: the client and world chunks on a CDN (Cloudflare Pages/R2), game servers on a small VPS or
  Fly.io, a production database, and monitoring. Paid services wait for the owner's approval.

**Done when:** players anywhere can open a public link, play on live servers, and fight scheduled territory wars with their crews.

---

## Run it locally

You need Node.js 22 or newer.

```bash
npm install
npm run dev:all   # game server on :2567 and the game on http://localhost:5173
```

Open http://localhost:5173 and click into the window to capture the mouse.

| Command | What it does |
|---|---|
| `npm run dev` | Game client only. Without a server it plays offline. Builds the world first if its settings changed. |
| `npm run server` | Game (shard) server only, on port 2567. The client joins it automatically when it answers. |
| `npm run dev:all` | Both of the above together; `Ctrl+C` stops both. |
| `npm run build` | Type-check and production build into `dist/`. |
| `npm run world -- --force` | Regenerate the world chunks (about 65 MB, about 15 seconds). |
| `npm run smoke` | Headless browser smoke test against a running dev server. |

PostgreSQL is optional in development: without it the server keeps accounts in memory. Set `DATABASE_URL`
to use a real database.

Useful URL options: `?offline` (don't look for a server), `?quality=low|medium|high|auto`, `?webgl` (force
WebGL2), `?nosw` (skip the Service Worker cache), `?server=ws://host:port`, `?shard=<roomId>`.

## Controls

| Action | Default key |
|---|---|
| Move / sprint / jump / dodge | `WASD` / hold `Shift` / `Space` / `V` |
| Camera | Mouse (click to capture, `Esc` releases), wheel to zoom |
| Basic / Heavy / Control / Defense / Mobility / Ultimate | Left click / `Q` / `E` / `R` / `F` / `X` |
| Block (time it to counter) | Hold right click |
| Cycle target / talk | `Tab` / `G` |
| PvP flag | `P` |
| Settings | `Esc` or the gear button |
| Debug overlay / chunk map / free camera | `F3` / `F4` or `M` / `F2` |

Every control can be rebound in Settings.

## Tuning the game

All balance numbers are JSON files in `data/`, so the game can be tuned without touching code:

| File | What it controls |
|---|---|
| `abilities/*.json`, `combat.json` | Damage, chi cost, cooldowns, ranges and status effects per element |
| `character.json`, `controls.json` | Movement, dodge, swimming, camera and default key bindings |
| `factions.json`, `zones.json`, `accounts.json` | Factions, hubs, NPCs, PvP rules, character slots |
| `world.json`, `props.json`, `time.json` | Terrain shape, biomes, scatter of trees and rocks, day length and lighting |
| `quality.json`, `net.json` | Graphics presets, load-ring sizes, server tick rate, shard size |
| `crafting/combos.json` | Bending crafting recipes (used from Phase 9) |

## Repository layout

```
client/    the game in the browser (rendering, world streaming, character, combat view, UI)
server/    the multiplayer shard server and account API
shared/    code used by both: terrain, combat rules, factions, network messages
data/      all tunable numbers (JSON)
scripts/   world builder and automated browser tests
docs/      design document
```

See [CLAUDE.md](CLAUDE.md) for the architecture in depth.
