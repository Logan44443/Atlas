# Four Winds — Design Document

Working title: **Four Winds**, a browser-based multiplayer open-world game about elemental bending.
This document is the source of truth for the design. Keep it in sync when the design changes
(see `CLAUDE.md` for the engineering side). All tunable numbers live in `data/*.json`, not here.

## Design pillars (owner's summary)

- **Elements**: each of the four has a distinct role. Water controls and sustains (stronger at night),
  Earth tanks (must stay on the ground), Fire does burst damage (stronger in daytime), Air is fast and
  evasive. Matchups give a small edge, not a hard counter.
- **Factions**: 3 on each side. Order: Sentinel Corps, Lantern Order, Free Isles League. Outlaw: Red Fang
  Triad, Ash Syndicate, Hollow Moon Cult. Each has NPC members, a hub and a perk.
- **Special Arts**: each has a clear limit. Lightning must be charged and can be redirected back at you.
  Metalbending includes a cable grapple. Flight blocks attacks while airborne. Bloodbending works at night
  only, and Order players lose faction rank for learning it.
- **Legendary pets** (Sun Dragon, Cloud Bison, Tide Serpent, Burrow Titan): won through a group world-boss
  fight, then a small chance at a hard solo Bond Trial. Each must match your element to bond.
- **PvP and bases**: low-level protection, diminishing XP for repeat kills, and scheduled raid windows so
  bases can't be wiped while their owners are offline.
- **10 build phases**, each playable on its own, with all numbers in JSON so they can be tuned.

---

## 1. Platform and tech (fixed decisions)

- **Deployment**: web app only. Players open a link; no installs. Dev machine is a MacBook Air M4, 16 GB.
- **Client**: TypeScript + Vite + Three.js with WebGPURenderer (automatic WebGL2 fallback). Rapier (WASM) for physics.
- **Server**: Node.js + Colyseus, server-authoritative for combat, XP, inventory, building and taming. The client predicts movement only.
- **Persistence**: PostgreSQL (accounts, characters, bases, pets). Redis optional for sessions and matchmaking.
- **Assets**: glTF/GLB compressed with Meshopt or Draco, KTX2 textures, Mixamo or Blender animations.
- **Hosting**: static client and world chunks on a CDN (Cloudflare Pages/R2); game servers on a small VPS or Fly.io.
- **Art direction**: stylized and painterly (think Genshin Impact / Breath of the Wild), not photoreal.
  Cel-ish shading, strong silhouettes, bright elemental VFX, wind-animated grass, day/night cycle, fog, bloom.
- **Quality presets**: Low / Medium / High, auto-detected, so laptops and phones can run it.

## 2. World streaming and servers

- The world is a grid of **64 m chunks**. Each chunk has a `.glb` (terrain and static meshes) and a `.json`
  (props, NPC spawns, resource nodes, base plots).
- A `manifest.json` lists every chunk with a version hash.
- **Load rings** around the player: near = full detail, physics and NPCs; mid = simplified meshes, no physics;
  far = low-poly terrain and impostors; beyond = fog. Prefetch chunks in the direction of travel. Unload chunks
  well behind the player.
- **Caching**: CDN, then a Service Worker with the Cache API (versioned; re-download only changed chunks),
  then an in-memory LRU of recent chunks.
- **World instances**: each Colyseus room is one world shard with about 80 players. On join, the player picks
  a shard (or is auto-assigned). The server returns their spawn point (faction hub or last camp or base), and
  the client loads that area's chunks first behind the loading screen.
- **Interest management**: the server sends each client only entities in nearby chunks.

## 3. Core loop

1. Create a character and choose an element: Water, Earth, Fire or Air. Permanent per character; up to 4 character slots.
2. Choose a faction (Order or Outlaw side). You can switch later, but it costs a long quest and resets your faction rank.
3. Explore, quest, fight NPCs and rival players to gain XP, which raises your Bending Level (1–50) and earns mastery points.
4. Unlock Special Arts (advanced sub-skills) through level, quests and masters.
5. Build camps and bases, tame pets, and fight for territory with your faction.

## 4. Factions

Two sides, three factions each. Each faction has a hub city or hideout, its own NPC members (vendors,
trainers, quest givers, patrolling guards and fighters), a color and emblem, and a passive perk.

### Order (the "good guys")

| Faction | Identity | Perk |
|---|---|---|
| Sentinel Corps | City police; lawful and disciplined | +10% damage against Outlaws holding bounties |
| Lantern Order | Monks who guard the spirit shrines | +15% healing and chi regeneration near shrines |
| Free Isles League | Sailors and explorers | +20% mount speed; discounted sea travel |

### Outlaw (the "bad guys")

| Faction | Identity | Perk |
|---|---|---|
| Red Fang Triad | Street gang that recruits all elements; "three fangs" tattoo | +10% XP from PvP; access to black-market vendors |
| Ash Syndicate | Smugglers and saboteurs | Can raid bases outside the normal raid windows (with heavy limits) |
| Hollow Moon Cult | Secretive forbidden-arts users | Only faction that can learn Bloodbending without a penalty |

- Same side = allies. You can party, share XP, and enter allied bases. Opposite side = enemies in contested zones.
- Faction rank (1–10) rises with faction quests and PvP wins, and unlocks gear, base pieces and pet eggs.
- Infamy/Honor: Outlaws gain a bounty from PvP kills; Order players earn a bonus for collecting bounties.

## 5. Zones and PvP rules

- **Safe zones**: faction hubs. No PvP.
- **Wilds**: PvE plus opt-in PvP (toggle a flag; flagged players get +25% XP).
- **Contested territories**: always-on PvP. Factions capture shrines and outposts for buffs and resource income.
  Territory wars run on a schedule (for example, twice a day).
- **Anti-griefing**:
  - Players 10+ levels below you give 0 XP and take reduced damage from you.
  - Repeatedly killing the same player gives diminishing XP.
  - 10 seconds of spawn protection.
  - Levels 1–9 cannot be flagged.
- **As built (Phase 6)**: the flag toggles with `P` (10 s cooldown). Hub locations and safe radii live in
  `data/factions.json`, the three contested shrines (Ember, Tide, Stone) and all PvP numbers in `data/zones.json`.
  Each hub has 7 NPC members (vendor, trainer, envoy, two gate guards, two patrols); patrols attack players of the
  other side nearby, guards only fight back. Dummies and NPCs never fight each other.

## 6. Bending combat

Third-person action combat with target-assist, not tab-targeting. Two resources:

- **Chi**: abilities spend it; it regenerates fast out of combat.
- **Stance**: block, dodge and counter. Perfect-timed blocks counter (deflect projectiles, stagger melee).

Each element gets 6 base abilities (Basic, Heavy, Mobility, Defense, Control, Ultimate), defined in
`data/abilities/*.json` (damage, chi cost, cooldown, range, VFX id, animation id).

| Element | Playstyle | Example kit |
|---|---|---|
| Water | Control and sustain; strongest near water, at night, and under a full moon | Water whip, ice spikes, wave surf (mobility), ice wall, freeze-in-place, tidal surge (ultimate) |
| Earth | Tank and zone control; must stay grounded to bend (stronger standing on rock) | Rock throw, boulder smash, earth glide/pillar launch, stone armor, quake root, earthquake ring |
| Fire | Burst damage; stronger in daytime and at noon | Fire jab combo, fire blast, jet dash, fire shield, flame ring, inferno breath |
| Air | Speed and evasion; highest mobility, lowest damage | Air slice, air cannon (knockback), air scooter/glider, air bubble deflect, vortex pull, tornado |

Elemental matchups are soft, not rock-paper-scissors: Water's freeze slows Fire, Air knocks Earth off the
ground (it loses its grounded bonus), Earth's walls block Fire projectiles, and Fire burns away Air's barriers.
The bonus is about 10%, so skill matters more than matchup.

## 6a. Controls and settings

Default PC layout (third-person action, keyboard + mouse):

| Action | Default |
|---|---|
| Move / sprint / jump / dodge | WASD / hold Shift / Space / V (or double-tap a direction) |
| Camera | Mouse (click to capture, Esc releases), wheel zoom |
| Basic / Heavy / Control / Defense / Mobility / Ultimate | Left click / Q / E / R / F / X |
| Block (perfect timing = counter) | Hold right click |
| Cycle target / interact | Tab / G |
| Toggle PvP flag | P |

- **Settings menu** (Esc or the gear button): players can **rebind every control** (click an action, press a key or
  mouse button; conflicts are flagged; reset to defaults), **edit their display name**, and change graphics quality
  and mouse sensitivity / invert-Y.
- Defaults live in `data/controls.json`. Player overrides are saved locally (`fw.settings`). Character names are
  validated by the server (length, allowed characters, uniqueness) on create and rename; a profanity filter is
  still to do.
- Gamepad support arrives with combat (Phase 4); touch controls (virtual stick + ability buttons) in the polish phase.

## 6b. Accounts and characters (as built in Phase 6)

- First visit creates a **guest account** automatically (token in localStorage), so players are in the game in one
  click. "Create an account" upgrades the guest in place (username + password, scrypt-hashed) and keeps its
  characters; "Sign in" works from any device.
- 4 character slots per account. Element is permanent; faction is picked at creation.
- Characters save position and level on logout and every 30 s, and log back in where they left off. One live
  session per character.
- Storage is PostgreSQL (`DATABASE_URL`); without a database the server keeps accounts in memory, and without a
  server the client keeps characters in the browser and plays offline.

## 7. XP and progression

- XP sources: NPC kills, quests, PvP kills (scaled by level difference), territory captures, taming, building
  milestones and exploration (discovering landmarks).
- Bending Level 1–50. Each level gives +2% bending power and 1 mastery point.
- Mastery tree per element, with 3 branches. Example for Fire: Precision (crit, range), Inferno (area damage,
  burn) and Breath (chi efficiency, sustain). A respec is available for gold.
- Special Arts need: a level threshold, a mastery quest from a master NPC (hidden in the world), and sometimes faction rank.

## 8. Special Arts (advanced bending)

| Art | Element | Unlock | How it works | Balance limits |
|---|---|---|---|---|
| Healing | Water | Lv 15 + Lantern shrine quest | Channel to heal allies; cleanses burns | Healing reduced 50% while you're in combat with players |
| Metalbending | Earth | Lv 20 + master in the mining city | Bend metal: pull armored enemies, metal cable grapple (swing/zip-line), shred metal base walls faster | Only works on metal (armor, cables, base parts, ore) |
| Lightning | Fire | Lv 20 + storm-peak trial | Charge 1.5 s, then an instant line strike with very high damage | You can't move while charging; Fire users with Lightning can redirect it back if they time a block |
| Lavabending | Earth | Lv 35 + volcano master | Turns ground into lava pools (zone damage); create stepping stones | Long cooldown; lava cools into rock walls after 8 s |
| Combustion | Fire | Lv 35 + rare scroll from a world boss | Long-range explosive "third-eye" shot | Telegraphed with a visible glow; 45 s cooldown |
| Flight | Air | Glider at Lv 10; true flight at Lv 40 + mountain monastery trial | Free 3D flight on a stamina bar | Can't use offensive abilities while flying; stamina drains faster in combat |
| Bloodbending | Water | Lv 40 + forbidden quest; at night only (stronger under a full moon) | Grab one target within 10 m: root or drag them for 2 s | 60 s cooldown and huge chi cost. Order players who learn it lose faction rank and gain a bounty. Hollow Moon Cult has no penalty. |
| Spirit Projection | Any | Lv 45 + spirit-world questline | Leave your body as a spirit to scout or reveal hidden enemies | Your body is vulnerable while you're out |

## 9. Teams

- **Parties** of up to 4 same-side players: shared XP within 50 m, party markers, combo moves (for example
  Water + Fire make a steam cloud that blinds).
- **Crews** (guilds) of up to 30 players, within one faction. They share a base, a bank and a crew rank.
- Faction NPCs fight alongside you in territory wars, and you can hire 1 NPC companion.

## 10. Building: camps and bases

**Camp** (solo, anywhere in the Wilds):
- A campfire, tent and storage chest.
- Acts as a respawn point; one per player.
- Burns down after 24 hours offline.
- Can't be placed within 100 m of a hub.

**Base** (crew, on claimed plots in territories):
- Snap-grid building pieces: walls, gates, towers, workshop, pet stable, training dummy, element shrine
  (+5% XP for members of that element).
- Tiers: wood → stone → metal → spirit-warded.

**Raids**:
- Enemy factions can raid bases only during scheduled raid windows, set by the crew within limits.
- Earth/Metal benders deal bonus structure damage.
- The base core can be damaged but never fully deleted; losing a raid costs resources and loot.

Building data goes in `data/buildings/*.json`.

## 10a. Bending crafting (element combos)

Players can build and craft *through bending*: combining two elements, or an element with something in the
world, produces a material or a structure. Each character has one element, so most combos happen with a
partner (party member or hired NPC companion); a few use the environment so solo players can join in.

- **Party combos**: two players channel at the same spot within a short window (about 1.5 s). Examples:
  Water + Earth → mud/fertile dirt (farm plots, mud walls, slows enemies), Fire + Water → steam (vents,
  blinding cloud, powers machines), Fire + Earth → glass or magma brick, Air + Water → fog or ice crystals,
  Air + Fire → super-heated forge (smelting metal), Earth + Air → sandstone or dust storm.
- **Environment combos**: one element plus a world source: Fire on sand → glass, Water on a hot spring → steam,
  Earth on ore nodes → refined ore, Air on ash → charcoal.
- Results are either **materials** (go to inventory, used by bases, camps and gear) or **placed structures**
  (bridges, walls, steam vents, farm plots) that snap to the building grid.
- Same-side combos only; the server validates both casters, range and timing (server-authoritative like all building).
- Combo strength scales with both casters' Bending Levels; matching Special Arts unlock upgraded recipes
  (Metalbending → steel beams, Lavabending → obsidian).
- All recipes live in `data/crafting/combos.json` (inputs, window, range, chi cost, output, quantity, cooldown).

## 11. Pets and mounts

| Tier | Examples | How to get | Element requirement |
|---|---|---|---|
| Common | Fox-hound, shell turtle, glider lemur | Feed in the wild, then win a short trust minigame | None |
| Rare | Armored rhino (mount), polar-wolf, eel-hound | Questline plus a mini-boss fight | None, but matching your element gives +10% to their skills |
| Legendary | Sun Dragon (Fire), Cloud Bison (Air), Tide Serpent (Water), Burrow Titan (Earth) | World-boss fight (party or raid of 4–12), then a solo Bond Trial | Must match your element to bond |

**Legendary rules**:
- Each one spawns in only one region, a few times a day, with a server-wide announcement.
- Fights take 10+ minutes, with multiple phases and mechanics.
- After winning, each eligible player gets a small chance to start the Bond Trial (about 5%, raised by bad-luck protection).
- The Bond Trial is a hard solo challenge that uses your element.
- Legendary bonuses: a flying or swimming mount, a combo ability with the rider, and a +15% element power aura. Examples:
  - Sun Dragon: you can ride while using fire breath; your lightning charges 30% faster.
  - Cloud Bison: carries a party of 4 in flight.
- Pets level up with you, need feeding and care, have 1 active at a time, and stay in your base stable otherwise.

Pet data goes in `data/pets/*.json`.

## 12. Build phases (in order; each must be playable)

1. **Foundations**: Vite + TS + Three.js WebGPU setup, stylized terrain, sky, day/night cycle, grass, quality presets, FPS/debug overlay.
2. **Chunk streaming**: procedural chunk grid, load rings, prefetch, unload, Service Worker caching. Debug view shows chunk states.
3. **Character**: third-person controller (walk, run, jump, dodge), camera, animations, Rapier physics. Settings menu with control rebinding and display name.
4. **Bending v1**: one element (Fire) with 6 abilities, VFX, chi, block/counter, training-dummy NPCs. Then add the other three elements.
5. **Multiplayer**: Colyseus shard rooms, join flow, spawn points, interpolation, server-authoritative hits, interest management.
6. **Characters and factions**: account and character creation (element + faction picker), faction hubs, NPC members, safe/wild/contested zones, PvP flag.
7. **Progression**: XP, levels, mastery trees, parties and shared XP, anti-griefing rules. Party combat combos (e.g. steam blind).
8. **Special Arts**: master NPCs and quests, then implement the arts one at a time.
9. **Building**: camps, then bending crafting (element combo recipes, section 10a), then crew bases, raid windows.
10. **Pets**: common taming, then rare, then legendary world bosses and the Bond Trial.
11. **Territory wars, crews, polish, deployment**: CDN, servers, monitoring.

## 13. How we work

- Start each phase by briefly restating the plan. Then build, run it in the browser, and report what works and what doesn't. Be honest about failures.
- Keep `CLAUDE.md` with the architecture, folder layout, conventions and current phase. Update it as decisions change.
- Keep this document in sync when the design changes.
- Use placeholder art (primitives, free CC0 assets, Mixamo) until the mechanics are fun. Then upgrade the art.
- Keep all tunable numbers in JSON: abilities, XP curve, pets, buildings, factions.
- Optimize for 60 FPS on an M4 MacBook Air on the High preset and 30 FPS on Low hardware. Watch draw calls; use instancing.
- Ask before big irreversible choices, paid services, or anything involving real accounts or payments.
