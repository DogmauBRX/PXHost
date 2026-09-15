# Public-exposure plan (docs/PUBLIC-EXPOSURE.md) — the VPS gateway
# sidecar: nginx (the actual TCP proxy) + a tiny Node control API in one
# container, since both need the same filesystem path (the rendered
# routes config) and this runs on exactly one VPS, not a fleet.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM nginx:1.27-alpine AS runtime
RUN apk add --no-cache nodejs
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY nginx.conf /etc/nginx/nginx.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh && touch /etc/nginx/gxhost-routes.conf

# The control API's own port (GATEWAY_LISTEN_PORT, default 9443) is
# reached only over the WireGuard tunnel from the panel/API — never
# published to the public internet. Game ports themselves are NOT
# EXPOSEd here (they're dynamic, opened by nginx at runtime per
# gxhost-routes.conf) — the VPS's own firewall, not Docker, is what
# actually decides which host ports reach this container (see
# docs/PUBLIC-EXPOSURE.md's firewall section); this image is meant to
# run with `network_mode: host` in production for exactly that reason.
EXPOSE 9443

ENTRYPOINT ["/docker-entrypoint.sh"]
