/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Shard server for production builds, e.g. wss://four-winds-shards.fly.dev (docs/DEPLOY.md). Unset in dev. */
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
