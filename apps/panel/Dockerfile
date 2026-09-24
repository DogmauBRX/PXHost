# Deploy plan (VPS + Cloudflare + WireGuard) — builds the static panel
# and serves it with Caddy in the SAME container (a second, independent
# Caddy instance from the VPS-root one that fronts api/panel together —
# see the root Caddyfile's own comment on why the split exists). VITE_API_URL
# is build-time (Vite inlines import.meta.env at build, not at container
# start — see client.ts's own fallback), so it MUST be passed as a
# --build-arg pointing at the real production API origin
# (https://api.gxhost.com.br), never left at its localhost default.

FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ARG VITE_API_URL
ARG VITE_TURNSTILE_SITE_KEY
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_TURNSTILE_SITE_KEY=${VITE_TURNSTILE_SITE_KEY}
RUN pnpm run build

FROM caddy:2-alpine AS runtime
COPY --from=build /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
