# Shard server image: Colyseus rooms + the account API on one port (PORT, default 2567).
# The browser client is static and deploys separately (docs/DEPLOY.md), so client/
# and the generated world are not in the image.
FROM node:22-slim

WORKDIR /app

# The server runs its TypeScript through tsx, which is a devDependency, so dev
# dependencies are installed too. Playwright (browser tests) needs no browsers here.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
# package.json overrides nanoid with vendor/nanoid-compat: it must exist before npm ci.
COPY vendor ./vendor
RUN npm ci --include=dev --no-audit --no-fund && npm cache clean --force

COPY tsconfig.json ./
COPY data ./data
COPY shared ./shared
COPY server ./server

# production: no dev-only room messages (tp, dev:*). DATABASE_URL comes from the host's secrets.
ENV NODE_ENV=production
ENV PORT=2567
EXPOSE 2567
USER node
# Same as `npx tsx server/index.ts`, but node is the main process (no npx/tsx wrapper),
# so SIGTERM reaches Colyseus's graceful shutdown directly: rooms save players, camps flush.
CMD ["node", "--import", "tsx", "server/index.ts"]
