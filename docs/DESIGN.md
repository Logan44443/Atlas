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
- **As built (Phase 11)**, numbers in `data/standing.json`, `data/factions.json` and `data/shop.json`:
  - **Rank 1-10** comes from rank points (100, 250, 500 ... 5000): faction orders, captures, holding points when a
    war ends, PvP kills that give XP (15), enemy faction NPCs (3) and collected bounties (10% of the bounty). Titles
    run Recruit to Legend. Rank 2 founds a crew, 3 unlocks the faction banner, pet stable and workshop, 4 a common
    pet egg, 5 the metal gate, 6 spirit-warded walls and gates, 7 and 10 rare pet eggs. Eggs hatch at your own
    faction's Beastkeeper. Bloodbending outside the Hollow Moon still costs whole ranks.
  - **Envoy orders**: your faction's Envoy hands out one order at a time (hunt creatures, defeat rival patrols or
    players, visit a territory point, take part in a capture, deliver materials, help beat a boss). Hand it in for
    rank points, coins and XP; the next one follows.
  - **Bounties**: an Outlaw who wins a PvP fight that gives XP gets +50 bounty (max 1000), which wears off at 60 an
    hour of real time and shows as a skull on their nameplate. An Order player who defeats them collects it as
    coins, honour, XP and rank points.
  - **Coins** drop from creatures, rival faction NPCs and bosses, and come from orders and captures. They pay for
    mastery respecs from level 10, crew founding, the Quartermaster and fast travel.
  - **Quartermaster** (hub vendor): sells basic materials, buys anything back at 40%. Red Fang members also see the
    black market (refined materials) and can buy a bounty pardon. Fast travel from a hub to the other hubs of your
    side, your camp or your crew hall, priced by distance, not right after a fight and not with a bounty above 300.
  - **Perks**: Sentinel +10% damage to bountied targets; Lantern +15% healing and chi regeneration within 90 m of a
    shrine; Free Isles +20% mount speed and half-price fast travel; Red Fang +10% PvP XP and the black market; Ash
    raids camps and bases outside their window at 35% damage, down to half health; Hollow Moon learns Bloodbending
    freely.

## 5. Zones and PvP rules

- **Safe zones**: faction hubs. No PvP.
- **Wilds**: PvE plus opt-in PvP (toggle a flag; flagged players get +25% XP).
- **Contested territories**: always-on PvP. Factions capture shrines and outposts for buffs and resource income.
  Territory wars run on a schedule (for example, twice a day).
- **Anti-griefing**:
  - Players 10+ levels below you give 0 XP and take reduced damage from you.
  - Repeatedly killing the same player gives diminishing XP (halved each time within 10 minutes, nothing after
    the 4th), and killing a player within 30 s of their respawn gives none.
  - 10 seconds of spawn protection.
  - Levels 1–9 cannot be flagged.
- **As built (Phase 6)**: the flag toggles with `P` (10 s cooldown). Hub locations and safe radii live in
  `data/factions.json`, the three contested shrines (Ember, Tide, Stone) and all PvP numbers in `data/zones.json`.
  Each hub has 7 NPC members (vendor, trainer, envoy, two gate guards, two patrols); patrols attack players of the
  other side nearby, guards only fight back. Dummies and NPCs never fight each other.
- **Territory wars as built (Phase 11)**, `data/territory.json`:
  - Nine points: the three shrines plus six outposts (palisade, watchtower, flag), all contested zones. In a new world
    each outpost belongs to the faction whose hub is nearest; shrines belong to nobody.
  - Wars run twice a day (02:00 and 17:00 UTC, 45 minutes each). Only then do points change hands. Living players
    of one side inside a point's capture circle push its meter (more players push faster, up to 3x); equal numbers
    hold it still. Attackers drain the holder to neutral, then fill it for their side; the faction with the most
    capturers takes it, and their crew (if any) collects its income.
  - Holding a point gives every member of the faction +2% XP; each shrine adds a buff (Ember +5% bending damage,
    Tide +10% chi regeneration, Stone 5% less damage taken). Every 10 minutes each held point pays materials and
    coins to the crew that took it (crew bank), or straight to the faction's players online when no crew did.
    Capturers get XP, coins and rank points; at the end of a war every member of a holding faction gets rank
    points per point held.
  - During a war, faction NPC war bands (2 per side at every point) fight each other and enemy players.
  - One territory state for the whole server (all shards), saved in PostgreSQL; offline play keeps its own.

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
| Mastery tree / invite to party / accept / decline | K / I / Y / N |
| Special Art (equipped) / Arts & quests panel | T / J |
| Camp panel (bag, build, chest, forge) / channel (bend-craft) | B / C |
| While placing a piece: place / rotate / cancel | Left click / R / B |
| Pets panel / ride your pet / tame (near a wild animal, with food) | O / H / G |

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
- **As built (Phase 7)**: XP to next level = 100 × level^1.5. Kill XP depends on the target (patrol 90, guard 160,
  player 150, training dummies only up to level 5) times a level-difference factor (0.25×–1.6×, nothing for targets
  10+ levels below). First visits to each hub (120) and contested shrine (250) give discovery XP. Each tree has 5
  skills per branch in 4 tiers (tier unlocks at 0/5/10/15 points in that branch, capstones are 1 rank); skills add
  damage, crit chance, range, area size, status duration/strength, cooldown and chi-cost reductions, max health,
  chi regen and armor. Respec is free until gold exists (`respecGold` in `data/progression.json`). Numbers live in
  `data/progression.json` and `data/mastery.json`.

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

**As built (Phase 8)**: every art except the Glider has a **master NPC** with a camp somewhere in the world and a
quest of steps (`talk`, `visit` points, `kill` enemies, `meditate` = stand still at a point for N seconds). Talk to
the master with the interact key once you reach the level; the **Arts panel (J)** lists your element's arts with
quest progress, the master's whereabouts hint and a **Track** button that drives a compass under the zone name. Quest
points are marked by stone cairns. A learned art goes in the new **Art slot (T)**; you can equip one at a time.
Everything lives in `data/arts.json` and runs in the shared sim (server-authoritative online).

| Art | Master and quest | What it does in game |
|---|---|---|
| Healing | Mother Senna, west of the Lantern Monastery: visit 3 spirit springs | 3 s circle that follows you, heals allies 11 per 0.5 s and cleanses burn; half healing within 8 s of PvP |
| Lightning | Old Kazan, Storm Peak: defeat 3 enemies, meditate 10 s on the summit | Roots you for a 1.5 s charge, then an instant 45 m line strike (80 damage). Walls stop it. A firebender who knows Lightning and perfect-blocks it sends it back |
| Metalbending | Forgemaster Ruk, Ironhollow: touch 3 ore veins | Metal cable: pulls a hit enemy to you (harder if shielded/armored); hitting ground zips you there |
| Lavabending | Ashmother Vey, Ember Crater: 5 kills in contested land, meditate 15 s in the crater | Lava pool where you aim (burn + damage for 8 s), then a rock wall for 10 s that blocks projectiles and lightning |
| Combustion | The Third Eye, the southern summit: 8 kills, walk all three shrines | 1 s glowing wind-up, then a 70 m explosive shot. The world-boss scroll arrives with Phase 10 |
| Glider | none: automatic for airbenders at level 10 | Jump in the air to open/close; glides at 8.5 m/s, falling 3.2 m/s; a hit closes it |
| Flight | Abbot Wen, Windspire: stand on 3 summits | 12 s stamina bar (T again lands); jump climbs, sprint dives; no attacks while flying; drains 2× in combat |
| Bloodbending | The Pale Lady, far southern hills: talk at night, 3 kills at night, return at night | Night only: seize one enemy within 10 m, root and drag them for 2 s (stronger at full moon). Order players lose a faction rank and get a bounty; Hollow Moon is exempt |
| Spirit Projection | The Wanderer, Heart Hill: meditate 20 s at each of the 3 shrines | 15 s: body stays still and takes 50% more damage, a spirit camera roams up to 90 m and marks every enemy in range; T again returns |

Not built yet: Lavabending stepping stones, metal-only targeting (needs armor/base parts from Phase 9) and the
Combustion scroll drop (Phase 10). Faction rank exists as a number on the character (default 1) until Phase 11 gives
it meaning.

## 9. Teams

- **Parties** of up to 4 same-side players: shared XP within 50 m, party markers, combo moves (for example
  Water + Fire make a steam cloud that blinds).
- **As built (Phase 7)**: invite with `I` while looking at a same-side player within 20 m; accept/decline with
  `Y`/`N`. Kill XP is split among members within 50 m with +20% per extra member (dead members miss out). Combos
  (`data/partyCombos.json`): Water + Fire steam (blinds: 50% miss chance), Earth + Fire magma (burn), Air + Fire
  firestorm (burn), Water + Air blizzard (slow), Water + Earth mudslide (root), Air + Earth sandstorm (blinds). A
  combo needs two different members' elements on one target within 2.5 s, then that target is immune for 6 s.
- **Crews** (guilds) of up to 30 players, within one faction. They share a base, a bank and a crew rank.
- Faction NPCs fight alongside you in territory wars, and you can hire 1 NPC companion.
- **Crews as built (Phase 11)**, `data/crews.json`, online only: found one at level 8 and faction rank 2 for 300
  coins (name 3-20 characters, tag 2-4 letters shown on nameplates). Roles leader / officer / member: officers
  invite, kick members and write the message of the day; the leader promotes, demotes and sets the raid window.
  The leader's crown passes to the senior officer when they leave; the last one out disbands it. Crew XP is 10% of
  members' XP and raises the crew level (1-10), which grows the bank (400 + 150 per level) and the base. The bank
  (materials and coins) opens at the crew hall or in your faction hub; officers withdraw. Faction war bands are
  built; the hired NPC companion is not.
- **Chat (Phase 11)**: Enter opens the chat box. `/s` nearby (40 m), `/g` the whole shard, `/f` your faction
  (every shard), `/c` crew, `/p` party, `/w name` whisper, `/r` reply. Rate-limited on the server.

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

**As built (Phase 9)**: camps do more than the design above asked, because crews (and so crew bases) arrive in
Phase 11. Until then every character's camp is their base:
- One camp per character, anchored by its **campfire** (the core and respawn point). Only in the Wilds, at least
  100 m beyond a hub's safe radius, and two campfires keep 56 m apart. Every other piece must stand within 28 m of
  your own campfire; at most 40 pieces.
- 18 pieces in `data/buildings/pieces.json`: campfire, tent, chest (storage), wood/stone/mud/magma-brick/obsidian/
  metal walls, wood gate, glass window wall, watchtower, sandstone bridge (walkable, can cross water), steam vent
  (blinds enemies who step on it), forge (forge recipes), ice lantern, element shrine (+5% XP for your side's
  players near it), training post. Snap to a 1 m grid, quarter-turn rotation, a ghost shows where it goes and why
  it can't (red).
- Pieces cost materials; taking one down refunds half. The campfire comes down last and a chest must be empty.
- **Raids**: structures take bending damage only from the **other side**, only during the **raid window**
  (19:00-22:00 UTC every day for now; crews set their own in Phase 11) and never in a safe zone. Earth deals 1.5x.
  Solid pieces stop projectiles. The campfire can be damaged but never destroyed (it holds at 1 hp).
- A camp burns down after its owner has been offline for 24 hours.
- XP milestones: first camp (100), a 10-piece camp (150), first metal wall (200).
- Online, the server keeps one structure registry for all shards (PostgreSQL `structures` table); offline camps
  are saved in the browser.

**Crew bases as built (Phase 11)**: 27 base plots across the Wilds near the outposts (`data/territory.json`,
marked on the world map). An officer raises the **crew hall** (the base core, 6000 hp) on a free plot; it snaps to
the plot's centre. Members then build within 36 m of the hall with their own materials, without a campfire: 60
pieces plus 10 per crew level, plus 10 per workshop (up to 2). The hall is a respawn point, its chest-like pieces are
shared by the crew, and nobody may start a camp next to a base. New pieces: crew hall, faction banner, pet stable
(keeps your pets fed nearby), workshop, metal gate, spirit-warded wall and gate (they shrug off 30% of damage).
The crew leader picks the base's daily 3-hour raid window (at most once a day, not while it is open). Beating the
hall down to 1 hp during the window **sacks** the base once: the raider carries off 20% of each material in the
crew bank (up to 200 items) plus XP and rank points. A base nobody from the crew visits for 7 days burns down.

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

**As built (Phase 9)**:
- **Resource nodes** (timber, boulder, sand bank, ore vein, hot spring, ash pile) are scattered through the world
  deterministically from the seed (`shared/resources.ts`), with 8 starter nodes outside every hub gate. Interact (G)
  gathers by hand (wood, stone, sand, raw ore); each node regrows per player.
- **Channel (C)**: next to a node of the right kind, your element makes the environment material (fire + sand →
  glass, water + hot spring → steam core, earth + ore vein → refined ore, air + ash → charcoal). Otherwise you
  wait up to 1.5 s for an ally of your side with a different element to channel within range: both get the
  output (mud, steam core, magma brick, ice crystal, forge heat, sandstone). Lava and Metal Special Arts upgrade
  magma brick → obsidian and forge heat → steel beams.
- Outputs are materials only (structures are built from them in the camp panel). Combo strength doesn't scale
  with level yet.
- **Forge** recipes at a placed forge: refined ore + charcoal → metal plate, refined ore + forge heat → steel beam.
- Bag holds 120 items, a chest 400 (`data/crafting/materials.json`).

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

**As built (Phase 10)**:
- **Common**: Fox-hounds, Shellback Tortoises and Glider Lemurs live in dens in the Wilds. Walk up with berries
  (fallen timber) or meat (hunting) and press G: the animal eats one, calms down, and a trust game starts (a marker
  sweeps a bar; press G in the green 3 times before missing twice, and not faster than 1.5 s). Win and it joins your
  stable. Animals that were just in a fight are too wild to tame.
- **Rare**: every hub has a **Beastkeeper**. Talking to one starts the next rare quest (from level guardian - 4): beat
  the named mini boss guarding the young one (Ironhide the Rhino Matriarch, Frostfang, Old Coil; friends welcome,
  they respawn 3 minutes after dying), then win a harder trust game with the young (4 hits, narrower zone).
- **Legendary**: Sun Dragon, Cloud Bison, Tide Serpent and Burrow Titan are world bosses on a wall-clock schedule
  (same on every shard), each in its own region, announced to the whole server when they rise and when they fall.
  Everyone of the matching element who dealt at least 2% of the damage rolls for the bond: 5%, +5% per failed roll
  (bad-luck protection, saved per character), capped at 60%. Winning the roll opens a solo **Bond Trial** against
  the boss's spirit right there (no one else can hit it or be hit by it; 150 s; it uses the boss's moves at 60%
  strength). If the boss took you down in the same exchange, the spirit waits up to 60 s and finds you once you are
  back on your feet. Beat it and the legendary pet is yours. While it is out: +15% element power aura (matching
  element), and the Sun Dragon makes lightning charge 30% faster. Sun Dragon and Cloud Bison fly, the Tide Serpent
  swims fast.
- **Pets**: one out at a time; it follows you, attacks what you attack (or what attacks you), levels with you
  (health grows per level), and is knocked out for 45 s if it goes down. Hunger drains 6% per hour of real time;
  under 30% it fights at reduced strength and won't carry you. Feed it from the pets panel (O): berries 15,
  meat 30, spirit shards 100. Stable of 8; the rest wait there. Pet kills count as yours.
- **Mounts** (H with a mount out, not in the first 3 s after a fight): rhino x1.35 run speed, polar wolf x1.25,
  eel-hound x1.2 and swims x2; legendary mounts x1.4-1.5: the Sun Dragon and Cloud Bison fly (Space climbs, Shift
  dives, you hover in place), the Tide Serpent swims x2.6, the Burrow Titan is armoured. You can bend from the saddle; a hit for more than 15% of your health throws you off.

### 11a. Wildlife and bosses (as built in Phase 10)

- **Dens** are a pure function of the world seed: one possible den per 120 m cell in the Wilds (none within 125 m of
  a hub), each with one species and a pack size. A den fills when a player comes within 180 m and empties when nobody
  is within 240 m; a wiped-out den refills after 45 s. Creature level = 1 + distance from the nearest hub / 28 m,
  clamped to the species' range, so the far Wilds are dangerous.
- **9 species**: passive (Hop-hare, Glider Lemur, Shellback Tortoise: flee when hurt), neutral (Fox-hound, Bristle
  Boar: fight back) and aggressive (Ridge Wolf packs, Thorn Bear, Ash Buzzard, Marsh Eel: attack within 15 m). They
  wind up before their bites and charges (the body rears back), leash back home past 36 m, and never fight each
  other. They give XP (their bounty x the usual level-difference factor, shared with the party like NPC kills) and
  loot: meat, hide, fang. Nothing fights inside a safe hub.
- **Bosses** (`data/bosses.json`): 3 rare beasts (mini bosses), 3 world bosses (Ashmaw the Magma Toad, the Gale Roc,
  the Hollow Stag) and the 4 legendaries. Health = max(minimum, per-player x challengers in the arena) and grows as
  people join. Phases at health thresholds switch move sets and enrage. Moves (melee, ground rings, cones,
  projectile volleys, charges, summoned adds) are **telegraphed**: a red ring, cone or lane is painted on the ground
  and fills up until it goes off. Everyone within 140 m who dealt at least 2% of the damage gets the XP and loot.
- **Solid world**: tree trunks and boulders are solid. The player's capsule collides with them (Rapier cylinders for
  the near chunks, built from the same deterministic scatter as the chunk files), and projectiles and lightning stop
  on them on both the server and offline. Bushes stay walk-through.
- **Bending marks**: bending that lands leaves a decal on what it hit: scorch on a trunk or the ground (fire, 90 s),
  cracked craters (earth, 120 s), wet splashes that dry (water, 25 s) and wind-scoured swirls (air, 45 s). Client
  only, instanced (4 draw calls).
- **Hub NPCs give advice that fits you**: trainers point out unspent mastery points, what your element is good at
  right now (day/night) and where to learn your next Special Art; quest givers name hunting grounds at your level
  with directions, bosses that are up or rising soon, and landmarks you have not discovered; vendors talk food,
  bag space, refining and camps; guards explain PvP flags and the raid window; patrols warn about aggressive dens
  nearby; Beastkeepers check on your pet's hunger and explain taming and mounts.

## 12. Build phases (in order; each must be playable)

1. **Foundations**: Vite + TS + Three.js WebGPU setup, stylized terrain, sky, day/night cycle, grass, quality presets, FPS/debug overlay.
2. **Chunk streaming**: procedural chunk grid, load rings, prefetch, unload, Service Worker caching. Debug view shows chunk states.
3. **Character**: third-person controller (walk, run, jump, dodge), camera, animations, Rapier physics. Settings menu with control rebinding and display name.
4. **Bending v1**: one element (Fire) with 6 abilities, VFX, chi, block/counter, training-dummy NPCs. Then add the other three elements.
5. **Multiplayer**: Colyseus shard rooms, join flow, spawn points, interpolation, server-authoritative hits, interest management.
6. **Characters and factions**: account and character creation (element + faction picker), faction hubs, NPC members, safe/wild/contested zones, PvP flag.
7. **Progression**: XP, levels, mastery trees, parties and shared XP, anti-griefing rules. Party combat combos (e.g. steam blind).
8. **Special Arts**: master NPCs and quests, then implement the arts one at a time.
9. **Building**: camps, then bending crafting (element combo recipes, section 10a), then crew bases, raid windows. *(Done, except crew bases and crew-set raid windows, which move to Phase 11 with crews.)*
10. **Pets**: common taming, then rare, then legendary world bosses and the Bond Trial. *(Done, together with wildlife, world bosses, solid trees/rocks, bending marks and NPC advice.)*
11. **Territory wars, crews, polish, deployment**: CDN, servers, monitoring. *(Done: territory wars, faction rank and orders, bounties, perks, coins and the Quartermaster, crews with banks and bases, chat, the world map. Deployment is prepared (Dockerfile, Fly.io and Cloudflare Pages config, metrics, CI, `docs/DEPLOY.md`) but nothing is deployed until the owner picks the accounts.)*

## 13. How we work

- Start each phase by briefly restating the plan. Then build, run it in the browser, and report what works and what doesn't. Be honest about failures.
- Keep `CLAUDE.md` with the architecture, folder layout, conventions and current phase. Update it as decisions change.
- Keep this document in sync when the design changes.
- Use placeholder art (primitives, free CC0 assets, Mixamo) until the mechanics are fun. Then upgrade the art.
- Keep all tunable numbers in JSON: abilities, XP curve, pets, buildings, factions.
- Optimize for 60 FPS on an M4 MacBook Air on the High preset and 30 FPS on Low hardware. Watch draw calls; use instancing.
- Ask before big irreversible choices, paid services, or anything involving real accounts or payments.
