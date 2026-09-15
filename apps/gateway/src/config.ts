/**
 * Refuses to start on a missing required var, same posture the API's own
 * `env.schema.ts` uses — a control API with no auth token configured, or
 * pointed at no config path, is a misconfiguration worth failing loudly
 * on at boot rather than accepting requests it can't safely act on.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const config = {
  // The SAME shared secret GatewayService's HttpGatewayDriver presents
  // as a bearer token (apps/api's PUBLIC_GATEWAY_TOKEN) — two env names
  // because they're two different processes, one value.
  token: required('GATEWAY_TOKEN'),
  listenPort: parseInt(process.env.GATEWAY_LISTEN_PORT ?? '9443', 10),
  // Where the rendered nginx stream config is written — must be
  // `include`d from the real nginx.conf's `stream {}` block (see
  // deploy/gateway/nginx.conf's own comment). A sibling `.json` file
  // next to it (same path, `.json` suffix) is the persisted "what did
  // we last tell nginx" snapshot GET /api/routes reads back — real
  // observed state, not an in-memory belief that a process restart
  // would silently lose.
  nginxConfPath: process.env.GATEWAY_NGINX_CONF_PATH ?? '/etc/nginx/gxhost-routes.conf',
};

export const statePath = `${config.nginxConfPath}.json`;
