# Deploy plan (VPS + Cloudflare + WireGuard) — produces a single image
# used by BOTH the "api" and "worker" services in docker-compose.prod.yml
# (architecture doc 3.7: the worker is a separate PROCESS from the API,
# not a separate codebase — `nest build` compiles the whole src tree in
# one pass, so dist/src/main.js and dist/src/worker.js both exist after one
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
# pnpm 10+ skips native/postinstall scripts (prisma, argon2, msgpackr-extract)
# by default unless explicitly approved — `install` alone exits non-zero even
# though it already linked every package, so the two are chained rather than
# `&&`'d; `approve-builds --all` then runs the scripts it deferred. See
# apps/api/package.json's own `pnpm.onlyBuiltDependencies` (kept for pnpm
# versions that still read it; this version doesn't, hence the explicit step).
RUN pnpm install --frozen-lockfile; pnpm approve-builds --all
COPY prisma ./prisma
RUN pnpm exec prisma generate
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN pnpm exec nest build

# ---- prune: same install, production-only, for a slim runtime node_modules ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod; pnpm approve-builds --all
COPY prisma ./prisma
# `prisma generate` needs the `prisma` CLI, a devDependency this --prod-only
# install never installs. Copying the client `build` already generated
# doesn't work either — with pnpm's virtual store, the generated output
# lands inside a `.pnpm/@prisma+client@...` folder keyed by that stage's
# own dependency graph (build's includes `typescript`/`prisma` as peers,
# this stage's doesn't), so the two stages' folder names never match.
# `dlx` runs a pinned, disposable `prisma` instead — matches @prisma/client's
# own resolved version above, not a devDependency of this image.
RUN pnpm dlx --allow-build=prisma --allow-build=@prisma/engines prisma@6.19.3 generate

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
CMD ["node", "dist/src/main.js"]
