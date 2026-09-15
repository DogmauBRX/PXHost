/**
 * The one seam this whole sidecar exists around. `NginxStreamBackend` is
 * the only implementation today; an `NftablesDnatBackend` (kernel-level
 * DNAT, preserving the real player IP — public-exposure plan's
 * documented upgrade path, see docs/PUBLIC-EXPOSURE.md) can be added
 * later and swapped in `main.ts`'s one construction site without
 * touching the HTTP surface or GatewayService on the API side at all —
 * neither of them know this interface exists.
 */
export interface DesiredRoute {
  serverId: string;
  publicPort: number;
  protocol: 'tcp';
  targetIp: string;
  targetPort: number;
}

export interface ProxyBackend {
  /** Makes reality equal `routes` — the full desired set, not a diff. Must throw on failure. */
  apply(routes: DesiredRoute[]): Promise<void>;
  /** The real, currently-applied set — read back from persisted state, never from a request-scoped variable, so it survives this process restarting. */
  current(): Promise<DesiredRoute[]>;
}
