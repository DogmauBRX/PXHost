import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ServerAccessService, type AccessActor } from '../authorization/server-access.service';
import { AgentClient } from '../nodes/agent-client.service';
import { AuditService } from '../audit/audit.service';
import { ActivityService } from '../activity/activity.service';
import { ModrinthProvider } from '../modpacks/modrinth.provider';
import type { ModpackSort, ModpackVersion } from '../modpacks/modpack-provider';

const MAX_PLUGIN_BYTES = 128 * 1024 * 1024;
const COMPATIBLE_LOADERS: Record<string, string[]> = {
  paper: ['paper', 'spigot', 'bukkit'], purpur: ['purpur', 'paper', 'spigot', 'bukkit'],
  spigot: ['spigot', 'bukkit'], bukkit: ['bukkit'], velocity: ['velocity'], bungeecord: ['bungeecord', 'waterfall'],
};

@Injectable()
export class PluginsService {
  constructor(
    private readonly access: ServerAccessService,
    private readonly agent: AgentClient,
    private readonly modrinth: ModrinthProvider,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
  ) {}

  async search(actor: AccessActor, serverId: string, query: string, sort: ModpackSort, offset = 0) {
    const { server, can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    if (!can('addons.catalog.read')) throw new ForbiddenException('Missing permission: addons.catalog.read');
    const loader = server.template?.softwareKind?.toLowerCase();
    if (!loader || !COMPATIBLE_LOADERS[loader]) throw new ConflictException('O software deste servidor não aceita plugins do Modrinth.');
    const minecraftVersion = server.variables[0]?.value;
    return this.modrinth.searchPlugins({ query, minecraftVersion, loader, sort, offset, limit: 20 });
  }

  async project(actor: AccessActor, serverId: string, projectId: string) {
    await this.assertCanRead(actor, serverId);
    return this.modrinth.getPluginProject(projectId);
  }

  async versions(actor: AccessActor, serverId: string, projectId: string) {
    const { minecraftVersion, compatibleLoaders } = await this.compatibility(actor, serverId, 'addons.catalog.read');
    const versions = await this.modrinth.getVersions(projectId, { minecraftVersion });
    return versions.filter((version) => this.isCompatible(version, compatibleLoaders, minecraftVersion));
  }

  async install(actor: AccessActor, serverId: string, projectId: string, versionId?: string) {
    const { server, can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    if (!can('addons.install')) throw new ForbiddenException('Missing permission: addons.install');
    const loader = server.template?.softwareKind?.toLowerCase();
    const compatibleLoaders = loader ? COMPATIBLE_LOADERS[loader] : undefined;
    const minecraftVersion = server.variables[0]?.value;
    if (!compatibleLoaders || !minecraftVersion) throw new ConflictException('O software ou a versão do Minecraft não foi identificado.');

    const versions = versionId
      ? [await this.modrinth.getVersion(versionId)]
      : await this.modrinth.getVersions(projectId, { minecraftVersion });
    const version = versions.find((candidate) => candidate.projectId === projectId && candidate.releaseType === 'release' && this.isCompatible(candidate, compatibleLoaders, minecraftVersion))
      ?? versions.find((candidate) => candidate.projectId === projectId && this.isCompatible(candidate, compatibleLoaders, minecraftVersion));
    if (!version) throw new UnprocessableEntityException('Não há versão compatível deste plugin para o software e Minecraft atuais.');
    const file = version.files.find((item) => item.primary && item.filename.endsWith('.jar')) ?? version.files.find((item) => item.filename.endsWith('.jar'));
    if (!file || file.size <= 0 || file.size > MAX_PLUGIN_BYTES || !/^[\w.-]+\.jar$/i.test(file.filename)) throw new UnprocessableEntityException('O arquivo do plugin não é instalável com segurança.');
    const source = new URL(file.url);
    if (source.protocol !== 'https:' || source.hostname !== 'cdn.modrinth.com') throw new UnprocessableEntityException('O arquivo principal não está hospedado no CDN permitido do Modrinth.');

    const response = await fetch(file.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) throw new ConflictException('Não foi possível baixar o plugin do Modrinth agora.');
    const content = Buffer.from(await response.arrayBuffer());
    if (content.byteLength > MAX_PLUGIN_BYTES || content.byteLength > file.size + 1024 * 1024) throw new UnprocessableEntityException('O download do plugin excede o limite seguro.');
    const expected = file.hashes.sha512 ?? file.hashes.sha1;
    const algorithm = file.hashes.sha512 ? 'sha512' : 'sha1';
    if (!expected || createHash(algorithm).update(content).digest('hex') !== expected.toLowerCase()) throw new UnprocessableEntityException('A verificação de integridade do plugin falhou.');

    try {
      await this.agent.listFiles(server.nodeId, server.id, 'plugins');
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      await this.agent.mkdir(server.nodeId, server.id, 'plugins');
    }
    await this.agent.writeBinaryFile(server.nodeId, server.id, `plugins/${file.filename}`, content);
    await Promise.allSettled([
      this.audit.record({ action: 'server.plugin.install', targetType: 'server', targetId: server.id, actorId: actor.id, metadata: { projectId, versionId: version.versionId, file: file.filename } }),
      this.activity.record({ actorId: actor.id, serverId: server.id, event: 'server.plugin.install', properties: { projectId, versionName: version.versionNumber } }),
    ]);
    return { fileName: file.filename, versionName: version.versionNumber, message: 'Plugin instalado. Reinicie o servidor para carregá-lo.' };
  }

  private async assertCanRead(actor: AccessActor, serverId: string) {
    const { can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    if (!can('addons.catalog.read')) throw new ForbiddenException('Missing permission: addons.catalog.read');
  }

  private async compatibility(actor: AccessActor, serverId: string, permission: 'addons.catalog.read' | 'addons.install') {
    const { server, can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    if (!can(permission)) throw new ForbiddenException(`Missing permission: ${permission}`);
    const loader = server.template?.softwareKind?.toLowerCase();
    const compatibleLoaders = loader ? COMPATIBLE_LOADERS[loader] : undefined;
    const minecraftVersion = server.variables[0]?.value;
    if (!compatibleLoaders || !minecraftVersion) throw new ConflictException('O software ou a versão do Minecraft não foi identificado.');
    return { compatibleLoaders, minecraftVersion };
  }

  private isCompatible(version: ModpackVersion, compatibleLoaders: string[], minecraftVersion: string) {
    return version.minecraftVersions.includes(minecraftVersion)
      && version.loaders.some((item) => compatibleLoaders.includes(item.toLowerCase()))
      && version.files.some((file) => file.filename.endsWith('.jar'));
  }
}
