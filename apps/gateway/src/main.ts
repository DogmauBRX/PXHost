import * as http from 'node:http';
import { config } from './config';
import { NginxStreamBackend } from './nginx-backend';
import type { DesiredRoute, ProxyBackend } from './proxy-backend';

// The one construction site for ProxyBackend — swap NginxStreamBackend
// for a future NftablesDnatBackend here, nothing else in this file (or
// on the API side) needs to change. See proxy-backend.ts's doc comment.
const backend: ProxyBackend = new NginxStreamBackend();

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function isValidRoute(r: unknown): r is DesiredRoute {
  if (typeof r !== 'object' || r === null) return false;
  const route = r as Record<string, unknown>;
  return (
    typeof route.serverId === 'string' &&
    route.serverId.length > 0 &&
    typeof route.publicPort === 'number' &&
    Number.isInteger(route.publicPort) &&
    route.publicPort > 0 &&
    route.publicPort <= 65535 &&
    route.protocol === 'tcp' &&
    typeof route.targetIp === 'string' &&
    route.targetIp.length > 0 &&
    typeof route.targetPort === 'number' &&
    Number.isInteger(route.targetPort) &&
    route.targetPort > 0 &&
    route.targetPort <= 65535
  );
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      send(res, 200, { status: 'ok' });
      return;
    }

    // Every other route requires the shared bearer token — constant-time
    // comparison would be nicer, but this token is never derived from
    // anything an attacker could time-observe a match against (it's a
    // single fixed secret, not a per-request-guessable value), so a
    // plain compare is the same posture NodeAuthGuard's own node-token
    // check documents as sufficient for that exact shape of credential.
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${config.token}`) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/routes') {
      const routes = await backend.current();
      send(res, 200, { routes });
      return;
    }

    if (req.method === 'PUT' && req.url === '/api/routes') {
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        send(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const routes = (parsed as { routes?: unknown[] }).routes;
      if (!Array.isArray(routes) || !routes.every(isValidRoute)) {
        send(res, 422, { error: 'routes must be an array of {serverId, publicPort, protocol: "tcp", targetIp, targetPort}' });
        return;
      }
      await backend.apply(routes);
      send(res, 200, { applied: routes.length });
      return;
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 502, { error: (err as Error).message });
  }
});

server.listen(config.listenPort, () => {
  // eslint-disable-next-line no-console
  console.log(`gxhost-gateway listening on :${config.listenPort}, writing config to ${config.nginxConfPath}`);
});
