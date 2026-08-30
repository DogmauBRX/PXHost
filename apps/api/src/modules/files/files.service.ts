import { ForbiddenException, Injectable } from '@nestjs/common';
import { ServerAccessService } from '../authorization/server-access.service';
import { AgentClient } from '../nodes/agent-client.service';
import { CapabilityTokenService } from '../../core/capability-token/capability-token.service';
import { AuditService } from '../audit/audit.service';
import { ActivityService } from '../activity/activity.service';

// Single-use, short-TTL per architecture doc 3.4: 60s for a download link
// (just long enough for the browser to follow the redirect it's given),
// 15min for an upload (large files take longer to actually transfer).
const DOWNLOAD_TOKEN_TTL_SECONDS = 60;
const UPLOAD_TOKEN_TTL_SECONDS = 15 * 60;
const DEFAULT_UPLOAD_MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB — matches the agent's own outer ceiling

@Injectable()
export class FilesService {
  constructor(
    private readonly access: ServerAccessService,
    private readonly agent: AgentClient,
    private readonly capabilityTokens: CapabilityTokenService,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
  ) {}

  async list(userId: string, serverId: string, path: string) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('file.read')) throw new ForbiddenException('Missing permission: file.read');
    return this.agent.listFiles(server.nodeId, server.id, path);
  }

  async read(userId: string, serverId: string, path: string) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('file.read')) throw new ForbiddenException('Missing permission: file.read');
    return this.agent.readFile(server.nodeId, server.id, path);
  }

  async write(userId: string, serverId: string, path: string, content: string) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('file.write')) throw new ForbiddenException('Missing permission: file.write');
    const result = await this.agent.writeFile(server.nodeId, server.id, path, content);
    await this.audit.record({ action: 'server.file.write', targetType: 'server', targetId: server.id, actorId: userId, metadata: { path } });
    await this.activity.record({ actorId: userId, serverId: server.id, event: 'server.file.write', properties: { path } });
    return result;
  }

  async rename(userId: string, serverId: string, from: string, to: string) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('file.write')) throw new ForbiddenException('Missing permission: file.write');
    await this.agent.renameFile(server.nodeId, server.id, from, to);
    await this.audit.record({ action: 'server.file.rename', targetType: 'server', targetId: server.id, actorId: userId, metadata: { from, to } });
    await this.activity.record({ actorId: userId, serverId: server.id, event: 'server.file.rename', properties: { from, to } });
  }

  async delete(userId: string, serverId: string, path: string, recursive: boolean) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('file.delete')) throw new ForbiddenException('Missing permission: file.delete');
    await this.agent.deleteFile(server.nodeId, server.id, path, recursive);
    await this.audit.record({ action: 'server.file.delete', targetType: 'server', targetId: server.id, actorId: userId, metadata: { path, recursive } });
    await this.activity.record({ actorId: userId, serverId: server.id, event: 'server.file.delete', properties: { path, recursive } });
  }

  async mkdir(userId: string, serverId: string, path: string) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('file.write')) throw new ForbiddenException('Missing permission: file.write');
    await this.agent.mkdir(server.nodeId, server.id, path);
  }

  async chmod(userId: string, serverId: string, path: string, mode: number) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('file.write')) throw new ForbiddenException('Missing permission: file.write');
    await this.agent.chmod(server.nodeId, server.id, path, mode);
  }

  async compress(userId: string, serverId: string, paths: string[], dest: string) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('file.write')) throw new ForbiddenException('Missing permission: file.write');
    await this.agent.compress(server.nodeId, server.id, paths, dest);
  }

  async decompress(userId: string, serverId: string, path: string, dest: string) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('file.write')) throw new ForbiddenException('Missing permission: file.write');
    return this.agent.decompress(server.nodeId, server.id, path, dest);
  }

  /**
   * Mints a single-use file.download capability token scoped to exactly
   * this path, then hands back the agent's own direct URL — the browser
   * fetches from THAT url with the token as a query param, never through
   * this API (architecture doc 3.4/4.4: the panel never proxies large
   * transfers).
   */
  async mintDownloadLink(userId: string, serverId: string, path: string) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('file.read')) throw new ForbiddenException('Missing permission: file.read');
    const token = this.capabilityTokens.mint({
      serverUuid: server.id,
      nodeUuid: server.nodeId,
      userId,
      cap: 'file.download',
      permissions: [],
      ttlSeconds: DOWNLOAD_TOKEN_TTL_SECONDS,
      ctx: { path },
    });
    const url = this.agent.fileTransferUrl(server.node.scheme, server.node.fqdn, server.node.daemonPort, server.id, 'download');
    return { url: `${url}?path=${encodeURIComponent(path)}&token=${token}`, expiresIn: DOWNLOAD_TOKEN_TTL_SECONDS };
  }

  async mintUploadLink(userId: string, serverId: string, path: string, maxBytes?: number) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('file.write')) throw new ForbiddenException('Missing permission: file.write');
    const cappedMaxBytes = Math.min(maxBytes ?? DEFAULT_UPLOAD_MAX_BYTES, DEFAULT_UPLOAD_MAX_BYTES);
    const token = this.capabilityTokens.mint({
      serverUuid: server.id,
      nodeUuid: server.nodeId,
      userId,
      cap: 'file.upload',
      permissions: [],
      ttlSeconds: UPLOAD_TOKEN_TTL_SECONDS,
      ctx: { path, maxBytes: cappedMaxBytes },
    });
    const url = this.agent.fileTransferUrl(server.node.scheme, server.node.fqdn, server.node.daemonPort, server.id, 'upload');
    return { url: `${url}?path=${encodeURIComponent(path)}&token=${token}`, expiresIn: UPLOAD_TOKEN_TTL_SECONDS, maxBytes: cappedMaxBytes };
  }
}
