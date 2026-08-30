import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { ServerAccessService } from '../authorization/server-access.service';
import { AgentClient } from '../nodes/agent-client.service';
import { CapabilityTokenService } from '../../core/capability-token/capability-token.service';
import { AuditService } from '../audit/audit.service';
import { ActivityService } from '../activity/activity.service';

const DOWNLOAD_TOKEN_TTL_SECONDS = 60; // single-use, architecture doc 3.4

// A node's own defaults would live in node config (later milestone); for
// M8, every backup at minimum skips its own in-progress backup archives
// so a backup never tries to include itself.
const DEFAULT_IGNORE_PATTERNS: string[] = [];

@Injectable()
export class BackupsService {
  constructor(
    private readonly access: ServerAccessService,
    private readonly agent: AgentClient,
    private readonly capabilityTokens: CapabilityTokenService,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
  ) {}

  async list(userId: string, serverId: string) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('backup.read')) throw new ForbiddenException('Missing permission: backup.read');
    return this.agent.listBackups(server.nodeId, server.id);
  }

  async create(userId: string, serverId: string, ignorePatterns: string[] | undefined) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('backup.create')) throw new ForbiddenException('Missing permission: backup.create');
    // Found while building M9's equivalent database quota: server.maxBackups
    // (snapshotted from the plan at creation time, architecture doc 2.6)
    // was never actually enforced here — a customer could create unlimited
    // backups regardless of their plan's limit.
    const existing = await this.agent.listBackups(server.nodeId, server.id);
    if (existing.length >= server.maxBackups) {
      throw new ConflictException('Backup limit reached for this server’s plan');
    }
    const backup = await this.agent.createBackup(server.nodeId, server.id, ignorePatterns ?? DEFAULT_IGNORE_PATTERNS);
    await this.audit.record({
      action: 'server.backup.create',
      targetType: 'server',
      targetId: server.id,
      actorId: userId,
      metadata: { backupId: backup.id, sizeBytes: backup.sizeBytes },
    });
    await this.activity.record({ actorId: userId, serverId: server.id, event: 'server.backup.create', properties: { backupId: backup.id, sizeBytes: backup.sizeBytes } });
    return backup;
  }

  async delete(userId: string, serverId: string, backupId: string) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('backup.delete')) throw new ForbiddenException('Missing permission: backup.delete');
    await this.agent.deleteBackup(server.nodeId, server.id, backupId);
    await this.audit.record({
      action: 'server.backup.delete',
      targetType: 'server',
      targetId: server.id,
      actorId: userId,
      metadata: { backupId },
    });
    await this.activity.record({ actorId: userId, serverId: server.id, event: 'server.backup.delete', properties: { backupId } });
  }

  /**
   * Restoring is destructive (the server's CURRENT files are replaced —
   * the agent keeps the pre-restore directory for a grace window, but
   * the panel doesn't expose recovering from it in M8), so it's audited
   * with the same weight as a delete, not folded silently into a
   * generic "backup op" action.
   */
  async restore(userId: string, serverId: string, backupId: string) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('backup.restore')) throw new ForbiddenException('Missing permission: backup.restore');
    await this.agent.restoreBackup(server.nodeId, server.id, backupId);
    await this.audit.record({
      action: 'server.backup.restore',
      targetType: 'server',
      targetId: server.id,
      actorId: userId,
      metadata: { backupId },
    });
    await this.activity.record({ actorId: userId, serverId: server.id, event: 'server.backup.restore', properties: { backupId } });
  }

  async mintDownloadLink(userId: string, serverId: string, backupId: string) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('backup.read')) throw new ForbiddenException('Missing permission: backup.read');
    const token = this.capabilityTokens.mint({
      serverUuid: server.id,
      nodeUuid: server.nodeId,
      userId,
      cap: 'backup.download',
      permissions: [],
      ttlSeconds: DOWNLOAD_TOKEN_TTL_SECONDS,
      ctx: { path: backupId },
    });
    const url = this.agent.backupDownloadUrl(server.node.scheme, server.node.fqdn, server.node.daemonPort, server.id, backupId);
    return { url: `${url}?token=${token}`, expiresIn: DOWNLOAD_TOKEN_TTL_SECONDS };
  }
}
