# Deploy plan (VPS + Cloudflare + WireGuard) — produces a single image
# used by BOTH the "api" and "worker" services in docker-compose.prod.yml
# (architecture doc 3.7: the worker is a separate PROCESS from the API,
# not a separate codebase — `nest build` compiles the whole src tree in
# one pass, so dist/main.js and dist/worker.js both exist after one
# build; the two services just run a different CMD against the same
# image). Migrations are deliberately NOT run here — `prisma migrate
# deploy` is a separate one-shot step in the deploy runbook, never
# embedded in a container's start command, so it can never race across
# multiple replicas or run implicitly on every restart.

# ---- deps: install once, reused by both the build and (implicitly) ----
FROM node:24-alpine AS base
WORKDIR /app
RUN corepack enable

# ---- build: full devDependencies, compiles TS + generates the Prisma client ----
FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY prisma ./prisma
RUN pnpm exec prisma generate
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN pnpm exec nest build

# ---- prune: same install, production-only, for a slim runtime node_modules ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY prisma ./prisma
RUN pnpm exec prisma generate

# ---- runtime: non-root, only what's needed to run `node dist/*.js` ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S gxhost && adduser -S gxhost -G gxhost
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/prisma ./prisma
COPY --from=build /app/dist ./dist
COPY package.json ./
USER gxhost
EXPOSE 3000
CMD ["node", "dist/main.js"]
