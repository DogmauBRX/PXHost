import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { NodeBootstrapService } from './node-bootstrap.service';

// Longer than the agent's OWN internal graceful-stop grace period
// (agent/internal/srv/server.go's stopTimeout, 30s) — found live: a
// `power stop` against a container that genuinely takes close to the
// full 30s to react to SIGTERM (not unusual for a real game server, and
// the entire reason that grace period exists) would have this client
// give up and report a false "Agent request failed: aborted" the
// instant Docker's own stop actually succeeds a moment later. 45s
// leaves real margin for the agent's own HTTP handling on top of
// Docker's 30s ceiling, for every call this client makes — power is the
// one that actually reaches the ceiling today, but the same client is
// used for backups/files/transfer too, so one shared, generous timeout
// is simpler than a per-endpoint table for a difference that doesn't
// matter to the caller either way.
const AGENT_REQUEST_TIMEOUT_MS = 45_000;

export interface AgentServerLimits {
  cpuPercent: number;
  memoryMb: number;
  swapMb: number;
  diskMb: number;
  ioWeight: number;
  pidsLimit?: number;
}

export interface AgentAllocation {
  ip: string;
  port: number;
  primary: boolean;
  protocols?: string[];
}

export interface AgentFileEntry {
  name: string;
  isDir: boolean;
  size: number;
  mode: string;
  modTime: string;
}

// Mirrors agent/internal/stats/frame.go's json tags exactly. disk_bytes /
// disk_limit_bytes are ALWAYS 0 — the agent passes a nil diskBytesFn to
// its stats collector (srv/server.go), so the collector skips the disk
// calculation entirely rather than doing a per-tick recursive tree walk.
// Never surface these two fields to a customer as if they were real.
export interface AgentStatsFrame {
  state: string;
  cpu_percent: number;
  cpu_limit_percent: number;
  memory_bytes: number;
  memory_limit_bytes: number;
  disk_bytes: number;
  disk_limit_bytes: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  uptime_ms: number;
}

// Mirrors handleGetServer's response shape (agent/internal/api/routes_server.go).
// `stats` is absent (not null) until the agent has pushed at least one
// frame for this container — e.g. a server that was created but never started.
export interface AgentServerStatus {
  uuid: string;
  state: string;
  containerId: string;
  memoryLimitMb: number;
  cpuLimitPercent: number;
  consoleSubscribers: number;
  stats?: AgentStatsFrame;
}

export interface AgentBackup {
  id: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface CreateAgentServerRequest {
  uuid: string;
  uid: number;
  image: string;
  imageDigest?: string;
  startupTemplate: string;
  stopSignal?: string;
  declaredVariables: string[];
  variables: Record<string, string>;
  limits: AgentServerLimits;
  allocations: AgentAllocation[];
  installImage: string;
  installEntrypoint: string;
  installScript: string;
}

/**
 * The Panel's single outbound client to a Node Agent's control API
 * (architecture doc 3.4/7 — "one place, with timeouts, retries, circuit
 * breaker per node"; the breaker/retry logic itself is a follow-up, this
 * milestone is the plumbing it will wrap). Every call authenticates with
 * the SAME node-token secret the agent was issued at bootstrap, decrypted
 * from `nodes.control_token_enc` — see that column's doc comment in
 * schema.prisma for why a shared secret is today's answer instead of mTLS.
 */
@Injectable()
export class AgentClient {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async createServer(nodeId: string, req: CreateAgentServerRequest): Promise<{ state: string }> {
    return this.call(nodeId, 'POST', '/api/servers', req);
  }

  async deleteServer(nodeId: string, serverUuid: string): Promise<void> {
    await this.call(nodeId, 'DELETE', `/api/servers/${serverUuid}`, undefined);
  }

  async power(nodeId: string, serverUuid: string, action: 'start' | 'stop' | 'restart' | 'kill'): Promise<{ state: string; previous: string }> {
    return this.call(nodeId, 'POST', `/api/servers/${serverUuid}/power`, { action });
  }

  /** The agent's half of architecture doc roadmap M14's two independent enforcement points — suspending force-kills a running container immediately; see agent/internal/srv/suspend.go's doc comment. */
  async setSuspended(nodeId: string, serverUuid: string, suspended: boolean): Promise<{ suspended: boolean; state: string }> {
    return this.call(nodeId, 'PATCH', `/api/servers/${serverUuid}/suspend`, { suspended });
  }

  /** Live half of plan-apply (architecture doc roadmap M12) — pushes new cgroup limits onto an already-running container via Docker's own ContainerUpdate, no recreate/restart. See agent/internal/srv/server.go's UpdateLimits doc comment. */
  async updateLimits(nodeId: string, serverUuid: string, limits: AgentServerLimits): Promise<{ updated: boolean }> {
    return this.call(nodeId, 'PATCH', `/api/servers/${serverUuid}/limits`, {
      cpuPercent: limits.cpuPercent,
      memoryMb: limits.memoryMb,
      swapMb: limits.swapMb,
      diskMb: limits.diskMb,
      ioWeight: limits.ioWeight,
      pidsLimit: limits.pidsLimit,
    });
  }

  /**
   * The agent's half of the Configurações tab (client-features Fase 7):
   * Docker env is immutable after a container is created, so this removes
   * and recreates the container with a new environment — see
   * agent/internal/srv/server.go's UpdateVariables doc comment for why the
   * data directory and the in-memory Server handle both survive that.
   * Callers must confirm the server is stopped BEFORE calling this — the
   * agent itself refuses otherwise, but the panel-side check exists so a
   * 409 is the rare case, not the expected one.
   */
  async updateVariables(nodeId: string, serverUuid: string, declaredVariables: string[], variables: Record<string, string>): Promise<{ updated: boolean }> {
    return this.call(nodeId, 'PATCH', `/api/servers/${serverUuid}/variables`, { declaredVariables, variables });
  }

  /**
   * The agent's cached last stats frame (`agent/internal/api/routes_server.go`'s
   * `handleGetServer`, `target.LatestStats()`) — it's already collecting
   * this every 2s for the console's WS push; this just asks for the copy
   * it's already holding. Costs no new agent code. `stats` is absent when
   * the agent hasn't pushed a frame yet (e.g. a server that was just
   * created and never started).
   */
  getServerStatus(nodeId: string, serverUuid: string): Promise<AgentServerStatus> {
    return this.call(nodeId, 'GET', `/api/servers/${serverUuid}`, undefined);
  }

  /**
   * A genuine recursive filesystem walk (fsx.Jail.DiskUsageBytes on the
   * agent), NOT the live stats frame's always-0 disk_bytes — see
   * AgentStatsFrame's doc comment above. Deliberately not cheap: the
   * caller (ClientServersService.diskUsage) is expected to rate-limit
   * on-demand refreshes, not poll this like `getServerStatus`.
   */
  getDiskUsage(nodeId: string, serverUuid: string): Promise<{ usedBytes: number; limitMb: number }> {
    return this.call(nodeId, 'GET', `/api/servers/${serverUuid}/disk-usage`, undefined);
  }

  /** The browser's direct connection target (architecture doc 4.5/5.2) — never proxied through this API. */
  wsUrl(scheme: string, fqdn: string, daemonPort: number, serverUuid: string): string {
    const wsScheme = scheme === 'https' ? 'wss' : 'ws';
    return `${wsScheme}://${fqdn}:${daemonPort}/api/servers/${serverUuid}/ws`;
  }

  /** The browser's direct signed-URL transfer target — same reasoning as wsUrl. */
  fileTransferUrl(scheme: string, fqdn: string, daemonPort: number, serverUuid: string, kind: 'download' | 'upload'): string {
    return `${scheme}://${fqdn}:${daemonPort}/api/servers/${serverUuid}/files/${kind}`;
  }

  // ---- files: "small ops", proxied (architecture doc 3.2/3.5) ----

  listFiles(nodeId: string, serverUuid: string, path: string): Promise<AgentFileEntry[]> {
    return this.call(nodeId, 'GET', `/api/servers/${serverUuid}/files/list?path=${encodeURIComponent(path)}`, undefined);
  }

  readFile(nodeId: string, serverUuid: string, path: string): Promise<{ content: string }> {
    return this.call(nodeId, 'GET', `/api/servers/${serverUuid}/files/contents?path=${encodeURIComponent(path)}`, undefined);
  }

  writeFile(nodeId: string, serverUuid: string, path: string, content: string): Promise<{ bytesWritten: number }> {
    return this.callRaw(nodeId, 'PUT', `/api/servers/${serverUuid}/files/contents?path=${encodeURIComponent(path)}`, content);
  }

  renameFile(nodeId: string, serverUuid: string, from: string, to: string): Promise<void> {
    return this.call(nodeId, 'POST', `/api/servers/${serverUuid}/files/rename`, { from, to });
  }

  deleteFile(nodeId: string, serverUuid: string, path: string, recursive: boolean): Promise<void> {
    return this.call(nodeId, 'DELETE', `/api/servers/${serverUuid}/files?path=${encodeURIComponent(path)}&recursive=${recursive}`, undefined);
  }

  mkdir(nodeId: string, serverUuid: string, path: string): Promise<void> {
    return this.call(nodeId, 'POST', `/api/servers/${serverUuid}/files/mkdir`, { path });
  }

  chmod(nodeId: string, serverUuid: string, path: string, mode: number): Promise<void> {
    return this.call(nodeId, 'POST', `/api/servers/${serverUuid}/files/chmod`, { path, mode });
  }

  compress(nodeId: string, serverUuid: string, paths: string[], dest: string): Promise<void> {
    return this.call(nodeId, 'POST', `/api/servers/${serverUuid}/files/compress`, { paths, dest });
  }

  decompress(nodeId: string, serverUuid: string, path: string, dest: string): Promise<{ extracted: number; skipped: string[] }> {
    return this.call(nodeId, 'POST', `/api/servers/${serverUuid}/files/decompress`, { path, dest });
  }

  // ---- backups (architecture doc 3.2/4.5) ----

  listBackups(nodeId: string, serverUuid: string): Promise<AgentBackup[]> {
    return this.call(nodeId, 'GET', `/api/servers/${serverUuid}/backups`, undefined);
  }

  createBackup(nodeId: string, serverUuid: string, ignorePatterns: string[]): Promise<AgentBackup> {
    return this.call(nodeId, 'POST', `/api/servers/${serverUuid}/backups`, { ignorePatterns });
  }

  deleteBackup(nodeId: string, serverUuid: string, backupId: string): Promise<void> {
    return this.call(nodeId, 'DELETE', `/api/servers/${serverUuid}/backups/${backupId}`, undefined);
  }

  restoreBackup(nodeId: string, serverUuid: string, backupId: string): Promise<void> {
    return this.call(nodeId, 'POST', `/api/servers/${serverUuid}/backups/${backupId}/restore`, undefined);
  }

  /** The browser's direct signed-URL backup download target — same reasoning as fileTransferUrl. */
  backupDownloadUrl(scheme: string, fqdn: string, daemonPort: number, serverUuid: string, backupId: string): string {
    return `${scheme}://${fqdn}:${daemonPort}/api/servers/${serverUuid}/backups/${backupId}/download`;
  }

  // ---- node-to-node transfer (architecture doc roadmap M13) ----

  exportTransfer(sourceNodeId: string, serverUuid: string): Promise<{ id: string; sizeBytes: number; sha256: string }> {
    return this.call(sourceNodeId, 'POST', `/api/servers/${serverUuid}/transfer/export`, undefined);
  }

  deleteTransferArchive(nodeId: string, serverUuid: string, archiveId: string): Promise<void> {
    return this.call(nodeId, 'DELETE', `/api/servers/${serverUuid}/transfer/archive/${archiveId}`, undefined);
  }

  /** THE TARGET agent's own HTTP client fetches from this URL directly — the panel only tells the target where to pull from, it never proxies the bytes (same "agent pulls" posture as everything else in architecture doc 3.5). */
  transferDownloadUrl(scheme: string, fqdn: string, daemonPort: number, serverUuid: string, archiveId: string): string {
    return `${scheme}://${fqdn}:${daemonPort}/api/servers/${serverUuid}/transfer/archive/${archiveId}/download`;
  }

  importTransfer(
    targetNodeId: string,
    req: CreateAgentServerRequest & { transferId: string; archiveId: string; sourceUrl: string; sourceToken: string },
  ): Promise<{ uuid: string; state: string }> {
    return this.call(targetNodeId, 'POST', '/api/servers/transfer/import', req);
  }

  private async baseURL(nodeId: string): Promise<{ url: string; token: string }> {
    const node = await this.prisma.node.findFirst({
      where: { id: nodeId },
      select: { scheme: true, fqdn: true, daemonPort: true, controlTokenEnc: true },
    });
    if (!node || !node.controlTokenEnc) {
      throw new ServiceUnavailableException('Node has not completed bootstrap (no control token on file)');
    }
    const token = this.crypto.decrypt(
      Buffer.from(node.controlTokenEnc).toString('utf8'),
      NodeBootstrapService.controlTokenAad(nodeId),
    );
    return { url: `${node.scheme}://${node.fqdn}:${node.daemonPort}`, token };
  }

  private async call<T>(nodeId: string, method: string, path: string, body: unknown): Promise<T> {
    const { url, token } = await this.baseURL(nodeId);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AGENT_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        // A 409 from the agent (e.g. "server must be stopped before
        // restore") is a request/state conflict the caller can act on,
        // not an infrastructure failure — preserve it as a 409 instead
        // of collapsing it into the generic 503 below, or callers (like
        // BackupsService.restore) can never distinguish it from the
        // agent being unreachable.
        if (res.status === 409) {
          throw new ConflictException(`Agent returned 409: ${text.slice(0, 500)}`);
        }
        throw new ServiceUnavailableException(`Agent returned ${res.status}: ${text.slice(0, 500)}`);
      }
      return text ? (JSON.parse(text) as T) : (undefined as T);
    } catch (err) {
      if (err instanceof ServiceUnavailableException || err instanceof ConflictException) throw err;
      throw new ServiceUnavailableException(`Agent request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Like call(), but sends `body` as a raw string, not JSON — the agent's file-write endpoint takes the file's own bytes verbatim as the request body. */
  private async callRaw<T>(nodeId: string, method: string, path: string, body: string): Promise<T> {
    const { url, token } = await this.baseURL(nodeId);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AGENT_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url + path, {
        method,
        headers: { Authorization: `Bearer ${token}` },
        body,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        // A 409 from the agent (e.g. "server must be stopped before
        // restore") is a request/state conflict the caller can act on,
        // not an infrastructure failure — preserve it as a 409 instead
        // of collapsing it into the generic 503 below, or callers (like
        // BackupsService.restore) can never distinguish it from the
        // agent being unreachable.
        if (res.status === 409) {
          throw new ConflictException(`Agent returned 409: ${text.slice(0, 500)}`);
        }
        throw new ServiceUnavailableException(`Agent returned ${res.status}: ${text.slice(0, 500)}`);
      }
      return text ? (JSON.parse(text) as T) : (undefined as T);
    } catch (err) {
      if (err instanceof ServiceUnavailableException || err instanceof ConflictException) throw err;
      throw new ServiceUnavailableException(`Agent request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
