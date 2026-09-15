#!/bin/sh
# Starts nginx in the background, the control API in the foreground, and
# forwards SIGTERM/SIGINT to both on container stop — the two-process-
# one-container tradeoff this sidecar deliberately accepts (see
# apps/gateway's own package.json description) because they share one
# filesystem path (the rendered routes config) and splitting them into
# two containers would need a shared volume for no real benefit at this
# scale.
set -e

touch /etc/nginx/gxhost-routes.conf
nginx -g 'daemon off;' &
NGINX_PID=$!

term_handler() {
  kill -TERM "$NGINX_PID" 2>/dev/null || true
  kill -TERM "$NODE_PID" 2>/dev/null || true
}
trap term_handler TERM INT

node dist/main.js &
NODE_PID=$!
wait "$NODE_PID"
