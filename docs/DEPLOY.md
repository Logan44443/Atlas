# Deploying Four Winds

Nothing is deployed yet. The steps below need accounts the owner has not approved
(Fly.io, Cloudflare, a PostgreSQL host). The repo only holds the files; nothing in
it signs up or deploys on its own.

## What goes where

| Part | Where | What it is |
| --- | --- | --- |
| Client | Cloudflare Pages | `dist/` from `npm run build`: `index.html`, `assets/` (hashed bundles), `sw.js`, `_headers`, and `world/` |
| World chunks | Cloudflare Pages, in `dist/world/` | `manifest.json` plus 8,192 files in `world/chunks/` (about 65 MB), copied from `client/public/world/` |
| Shard server | Fly.io, one machine | The `Dockerfile` image: Colyseus rooms, `/api`, `/health`, `/metrics`, `/shards`, all on one port |
| Database | Managed PostgreSQL (Fly Postgres, Neon, Supabase, ...) | Accounts, characters, camps, crews, territory. Anything that gives a `postgres://` URL works |

Pages allows 20,000 files and 25 MiB per file in a deployment on the free plan, so the
world fits. Moving chunks to R2 later is a code change, not only a config change: the
client fetches chunks from its own origin (`ChunkStore` base `/world`), and `sw.js`
only caches same-origin `/world/chunks/` requests. R2 would need a configurable base
URL, CORS on the bucket and an updated Service Worker check (or a Worker that serves
R2 under the Pages domain).

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `PORT` | server | Listen port. Defaults to `port` in `data/net.json` (2567); the image and `fly.toml` set 2567. |
| `DATABASE_URL` | server (secret) | PostgreSQL URL. When set it must connect, or the server exits. When unset the server tries a local dev database, then falls back to memory, where nothing persists. Always set it in production. Add `?sslmode=require` if the provider asks for it. |
| `NODE_ENV` | server | `production` turns off dev-only room messages (`tp`, `dev:*`). Set in the `Dockerfile` and `fly.toml`. |
| `LOG_FORMAT` | server | `json` makes `log()` from `server/metrics.ts` print one JSON object per line. Existing `console.log` calls still print plain text. |
| `METRICS_TOKEN` | server (secret, optional) | When set, `/metrics` needs `Authorization: Bearer <token>`. |
| `CLIENT_IP_HEADER` | server | Header that carries the player's real address behind a proxy (`Fly-Client-IP` on Fly, set in `fly.toml`). Only trusted when set. |
| `VITE_SERVER_URL` | client, build time | Shard server address baked into the bundle, e.g. `wss://four-winds-shards.fly.dev`. |

How the client picks its server (`defaultServerUrl()` in `client/src/net/netCombat.ts`):

1. `?server=` in the page URL, if present.
2. `VITE_SERVER_URL` from the build, if set.
3. Otherwise `ws://<page host>:2567` (`wss` on https pages). This is the dev setup.

The account API base comes from the same address with `ws` replaced by `http`
(`wss://...` becomes `https://...`), so one variable covers both.

## First deploy

These commands assume the owner has approved the accounts and is logged in to each CLI.

### 1. Database

Create a PostgreSQL database with the provider of choice and copy its `postgres://`
connection string. The schema is created by the server itself on first start (see
"Database migrations").

### 2. Shard server on Fly.io

```bash
fly auth login
fly launch --no-deploy      # keeps fly.toml and the Dockerfile; say yes to copying the existing config
fly secrets set DATABASE_URL='postgres://user:pass@host:5432/db'
fly deploy --ha=false       # exactly one machine (see "Scaling and known limits")
fly status
curl https://four-winds-shards.fly.dev/health      # -> ok
fly logs
```

If the app name `four-winds-shards` is taken, change `app` in `fly.toml` and use the
new name in `VITE_SERVER_URL`. Change `primary_region` in `fly.toml` to the region
nearest most players before the first deploy. When `fly launch` offers to create a
Postgres or Redis instance, decline unless that is the chosen database.

To try the image locally first: `docker build -t four-winds-shards .` then
`docker run --rm -p 2567:2567 -e DATABASE_URL='postgres://...' four-winds-shards`
(without `DATABASE_URL` it runs on in-memory storage).

### 3. Client on Cloudflare Pages

```bash
npm ci
VITE_SERVER_URL=wss://four-winds-shards.fly.dev npm run build   # world (if changed) + typecheck + vite build -> dist/
ls dist/world/manifest.json                                     # the world must be in dist/
npx wrangler login
npx wrangler pages project create four-winds --production-branch main   # first time only
npx wrangler pages deploy dist --project-name four-winds
```

`client/public/_headers` ends up in `dist/` and sets caching: hashed `assets/` are
immutable, chunks get a long max-age because their URLs carry `?v=<hash>`, and
`manifest.json` and `sw.js` are always revalidated. Pages serves `.wasm` as
`application/wasm` by itself (Rapier inlines its wasm in the JS today anyway).

If `dist/world/` is missing, Pages answers `/world/manifest.json` with `index.html`
(its single-page-app fallback), and the game fails with a JSON parse error instead
of "world manifest missing".

Pages can also build from Git instead of `wrangler`: build command `npm run build`,
output directory `dist`, environment variables `VITE_SERVER_URL` and `NODE_VERSION=22`.
The world is then generated during the Pages build (about 15 s).

## Updating

- Server: `fly deploy`. The single machine restarts. Connected players lose the
  connection for a few seconds, keep playing offline and rejoin on their own
  (`reconnectDelaysMs` in `data/net.json`). Colyseus shuts down on SIGTERM, so rooms
  save their players and camps, crews and territory flush before exit
  (`kill_timeout` is 30 s).
- Client: `npm run build` with `VITE_SERVER_URL`, then `npx wrangler pages deploy dist`.
  Chunks whose hash changed are downloaded again; the Service Worker keeps the rest.
- When a change touches the wire protocol (`shared/net.ts`, room messages), deploy the
  server and the client together. Open tabs keep the old bundle until they reload.

## Database migrations

They run at server startup. `PgStore.migrate()` in `server/db/store.ts` applies every
`server/db/*.sql` file not yet listed in the `schema_migrations` table, in file name
order, each in its own transaction. There is no separate release step.

- A failing migration is rolled back and the server exits. On Fly this shows as a
  crash loop in `fly logs`; fix the file and deploy again.
- Add schema changes as a new numbered file (`007_....sql`). Never edit a file that
  has already run in production: it will not run again.
- Backups are the database provider's job; turn them on when creating the database.

## Scaling and known limits

- **One process is the whole world.** The camps registry (`server/camps.ts`), crews
  (`server/crews.ts`), territory (`server/territory.ts`), the online directory used
  for cross-shard chat (`server/online.ts`) and the "one live session per character"
  check all live in the process's memory. Colyseus uses its default local presence and
  driver, and the API rate limiter is in memory too. Several shard rooms of 80 players
  run inside that one process, but a second process (a second Fly machine, or
  `fly scale count 2`) would show a different world. Run exactly one machine and
  scale up (`fly scale vm`, `fly scale memory`), not out.
- Scaling out needs real work: those registries moved into PostgreSQL or Redis with
  change notifications between processes, Colyseus `RedisPresence` and `RedisDriver`,
  and a shared rate limiter.
- **Rate limits behind the proxy.** `server/api.ts` keys the guest and login limits
  on the client's address. Behind Fly's proxy the socket is the proxy, so `fly.toml`
  sets `CLIENT_IP_HEADER=Fly-Client-IP` and the server reads the address from that
  header. Leave it unset anywhere the server is reachable directly, or players could
  fake the header to dodge the limits.
- `fly.toml` sets the connection limit to 1,000 (soft 800). Fly's default of 25 would
  turn players away. Lower it once a load test shows what the VM can hold.
- The VM is `shared-cpu-1x` with 1 GB. An idle server uses about 145 MB RSS; watch
  `fw_memory_rss_bytes` and resize after real load.
- One region: players far from `primary_region` get higher latency.
- `auto_stop_machines` is off because rooms hold state, so the machine runs (and is
  billed) all the time.

## Monitoring

- `GET /health` answers `ok`. Fly checks it every 15 s and stops routing to a machine
  that fails it (`fly checks list`).
- `GET /metrics` returns Prometheus text from `server/metrics.ts`:
  - `fw_rooms`, `fw_clients`: shard rooms and connected players in this process
  - `fw_uptime_seconds`, `fw_process_cpu_seconds_total`
  - `fw_memory_rss_bytes`, `fw_memory_heap_used_bytes`, `fw_memory_heap_total_bytes`
  - `fw_event_loop_lag_seconds{stat="mean|p50|p99|max"}`: event-loop delay since the
    previous scrape. The sim ticks every 50 ms (20 Hz), so a p99 that stays above
    about 0.05 means ticks are running late.
  - any counter added with `count('fw_<thing>_total', { label: 'value' })`. Keep label
    values to small fixed sets (element, kind), never player or room ids.
- The `[metrics]` section in `fly.toml` lets Fly's managed Prometheus scrape
  `/metrics` (dashboards at fly-metrics.net). That scraper cannot send a token, so
  either leave `METRICS_TOKEN` unset (the metrics then are public at
  `https://<app>.fly.dev/metrics`; they hold counts only, no player data), or set it,
  remove `[metrics]` and scrape with a Prometheus of your own that sends the token.
- Logs: `fly logs`. With `LOG_FORMAT=json` (set in `fly.toml`), `log(level, msg, fields)`
  lines are JSON that log tools can filter by field.
- Suggested alerts: health check failing, `fw_event_loop_lag_seconds{stat="p99"}`
  above 0.05 for 5 minutes, `fw_memory_rss_bytes` above 80% of the VM's memory.

## CI

`.github/workflows/ci.yml` runs on every push and pull request: `npm ci`,
`npx tsc --noEmit`, the browser-free rule checks (`progression-check`,
`building-check`, `pets-check`) and `npx vite build`. It does not generate the world
(the bundle does not import it) and runs no browser tests. It does not deploy.
