# Four Winds

A browser-based multiplayer open-world game about elemental bending (Water, Earth, Fire, Air).
Players open a link and play: no installs.

- Design: [docs/DESIGN.md](docs/DESIGN.md)
- Engineering notes: [CLAUDE.md](CLAUDE.md)

## Build phases

Each phase is playable on its own. Status is updated as each one lands.

| # | Phase | Status | What's in it |
|---|---|---|---|
| 1 | Foundations | ✅ Done | Vite + TypeScript + three.js WebGPU (WebGL2 fallback), stylized terrain, sky, day/night cycle, wind-animated grass, Low/Medium/High quality presets with auto-detect, FPS/debug overlay (F3) |
| 2 | Chunk streaming | ✅ Done | 64 m chunk grid with manifest + version hashes, near/mid/far load rings, prefetch in the direction of travel, unloading, worker mesh building, Service Worker cache, chunk-state map (F4) |
| 3 | Character | ✅ Done | Third-person controller (walk, sprint, jump, dodge, swim, block) on Rapier physics, over-the-shoulder camera, procedural avatar, settings menu with rebindable controls and display name |
| 4 | Bending v1 | ✅ Done | All four elements with 6 abilities each, chi, block and perfect-block counters, dodge i-frames, burn/slow/root/stagger, shields, day/night and terrain bonuses, soft matchups, target assist, particle VFX, combat HUD, training and sparring dummies |
| 5 | Multiplayer | ✅ Done | Colyseus shard rooms of 80 players, join flow, spawn points, server-authoritative combat, movement checks, interest management, interpolated remote players, offline fallback |
| 6 | Characters and factions | 🔨 In progress | Guest accounts that upgrade to real ones, PostgreSQL saves, title screen with up to 4 characters (element + faction picker), six faction hub towns, NPC members (vendors, trainers, envoys, guards, patrols), safe/wild/contested zones, PvP flag |
| 7 | Progression | Planned | XP, levels 1–50, mastery trees, parties with shared XP, anti-griefing rules, party combat combos |
| 8 | Special Arts | Planned | Master NPCs and quests, then lightning, metalbending, flight, bloodbending and the rest one at a time |
| 9 | Building | Planned | Camps, bending crafting (element combo recipes), crew bases, raid windows |
| 10 | Pets | Planned | Common taming, rare pets, legendary world bosses and the Bond Trial |
| 11 | Territory wars, crews, polish, deployment | Planned | Shrine and outpost capture, crews, CDN hosting, game servers, monitoring |

## Run it

```bash
npm install
npm run dev:all   # game server on :2567 + client on http://localhost:5173
```

`npm run dev` runs the client alone; without a server it plays offline. PostgreSQL is optional in
development (the server falls back to memory); set `DATABASE_URL` in production.

## Controls

WASD move, Shift sprint, Space jump, V dodge, left click basic attack, Q/E/R/F/X abilities, hold right click
to block (time it to counter), Tab target, G talk, P PvP flag, Esc settings. All rebindable in Settings.

A full README (deployment, architecture, tuning guide) comes when the build is finished.
