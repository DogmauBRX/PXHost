import { ConflictException, ForbiddenException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ServerAccessService, type AccessActor } from '../authorization/server-access.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AgentClient } from '../nodes/agent-client.service';
import { AuditService } from '../audit/audit.service';
import { ActivityService } from '../activity/activity.service';
import type { InstallModpackDto, ModpackProgressDto, ResolveCurseForgeFilesDto } from './dto/install-modpack.dto';
import type { ListModpackVersionsDto, SearchModpacksDto } from './dto/modpack-query.dto';
import type { ModpackProvider, ModpackSource } from './modpack-provider';
import { ModrinthProvider } from './modrinth.provider';
import { CurseForgeProvider } from '../plugins/curseforge.provider';

@Injectable()
export class ModpacksService {
  private readonly providers: Map<ModpackSource, ModpackProvider>;

  constructor(
    private readonly access: ServerAccessService,
    private readonly prisma: PrismaService,
    private readonly agent: AgentClient,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
    modrinth: ModrinthProvider,
    curseforge: CurseForgeProvider,
  ) {
    this.providers = new Map<ModpackSource, ModpackProvider>([
      [modrinth.source, modrinth],
      [curseforge.source, curseforge],
    ]);
  }

  async install(actor: AccessActor, serverId: string, dto: InstallModpackDto) {
    const { server, can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    if (!can('addons.install')) throw new ForbiddenException('Missing permission: addons.install');
    if (!server.template?.softwareKind) throw new ConflictException('O software atual do servidor não foi identificado.');

    const runtime = await this.agent.getServerStatus(server.nodeId, server.id);
    if (runtime.state !== 'offline') throw new ConflictException('Desligue o servidor antes de instalar um modpack.');

    const provider = this.provider(dto.source);
    const [project, version] = await Promise.all([provider.getProject(dto.projectId), provider.getVersion(dto.versionId, dto.projectId)]);
    if (version.projectId !== dto.projectId) throw new UnprocessableEntityException('A versão selecionada não pertence a este modpack.');
    const minecraftVersion = server.variables[0]?.value;
    const loader = server.template.softwareKind.toLowerCase();
    if (!minecraftVersion || !version.minecraftVersions.includes(minecraftVersion) || !version.loaders.includes(loader)) {
      throw new ConflictException('Escolha uma versão compatível com o Minecraft e o loader atuais do servidor.');
    }
    const extension = dto.source === 'curseforge' ? '.zip' : '.mrpack';
    const file = version.files.find((candidate) => candidate.primary && candidate.filename.toLowerCase().endsWith(extension))
      ?? version.files.find((candidate) => candidate.filename.toLowerCase().endsWith(extension));
    if (!file) throw new UnprocessableEntityException(`Esta versão não possui um pacote ${extension} instalável.`);
    if (!file.url) {
      throw new UnprocessableEntityException('O autor deste modpack não permite download por aplicativos de terceiros. Baixe-o manualmente pelo site do CurseForge.');
    }
    const source = new URL(file.url);
    const allowedHosts = dto.source === 'curseforge' ? ['edge.forgecdn.net', 'mediafilez.forgecdn.net'] : ['cdn.modrinth.com'];
    if (source.protocol !== 'https:' || !allowedHosts.includes(source.hostname)) {
      throw new UnprocessableEntityException(`O arquivo principal não está hospedado no CDN permitido do ${dto.source === 'curseforge' ? 'CurseForge' : 'Modrinth'}.`);
    }

    const operation = await this.prisma.withRLS({ userId: actor.isAdmin ? null : actor.id, isAdmin: actor.isAdmin }, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${serverId}))`;
      const active = await tx.modpackInstallation.findFirst({
        where: { serverId, status: { in: ['pending', 'downloading', 'installing', 'configuring', 'rolling_back'] } },
      });
      if (active && active.updatedAt > new Date(Date.now() - 2 * 60 * 60 * 1_000)) {
        throw new ConflictException('Já existe uma instalação de modpack em andamento.');
      }
      if (active) {
        await tx.modpackInstallation.update({
          where: { id: active.id },
          data: { status: 'failed', progress: 100, message: 'Operação expirada', errorMessage: 'O Agent não concluiu a operação dentro do prazo.', completedAt: new Date() },
        });
      }
      return tx.modpackInstallation.create({ data: {
        serverId,
        requestedBy: actor.id,
        source: dto.source,
        projectId: dto.projectId,
        versionId: dto.versionId,
        projectName: project.name,
        versionName: version.versionNumber,
        minecraftVersion,
        loader,
        message: 'Aguardando o Agent',
      } });
    });

    try {
      await this.agent.installModpack(server.nodeId, server.id, {
        source: dto.source,
        operationId: operation.id,
        sourceUrl: file.url,
        filename: file.filename,
        size: file.size,
        sha1: file.hashes.sha1,
        sha512: file.hashes.sha512,
        diskLimitMb: server.diskMb,
      });
    } catch (error) {
      await this.updateOperation(server.id, operation.id, {
        status: 'failed', progress: 0, message: 'O Agent recusou a instalação', errorMessage: error instanceof Error ? error.message : 'Falha desconhecida',
      });
      throw error;
    }
    await Promise.allSettled([
      this.audit.record({ action: 'server.modpack.install', targetType: 'server', targetId: server.id, actorId: actor.id, metadata: { operationId: operation.id, source: dto.source, projectId: dto.projectId, versionId: dto.versionId } }),
      this.activity.record({ actorId: actor.id, serverId: server.id, event: 'server.modpack.install', properties: { operationId: operation.id, projectName: project.name, versionName: version.versionNumber } }),
    ]);
    return this.latestInstallation(actor, serverId);
  }

  async latestInstallation(actor: AccessActor, serverId: string) {
    const { can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    if (!can('addons.catalog.read')) throw new ForbiddenException('Missing permission: addons.catalog.read');
    return this.prisma.withRLS({ userId: actor.isAdmin ? null : actor.id, isAdmin: actor.isAdmin }, (tx) =>
      tx.modpackInstallation.findFirst({ where: { serverId }, orderBy: { createdAt: 'desc' } }),
    );
  }

  /**
   * A modpack installation always creates a backup before it replaces the
   * server tree. Uninstalling restores that exact snapshot instead of trying
   * to guess which files belong to a pack (overrides can replace configs,
   * worlds, or arbitrary paths). This is intentionally only available while
   * the server is offline, like a normal backup restore.
   */
  async uninstallLatest(actor: AccessActor, serverId: string) {
    const { server, can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    if (!can('addons.install')) throw new ForbiddenException('Missing permission: addons.install');

    const installation = await this.prisma.withRLS(
      { userId: actor.isAdmin ? null : actor.id, isAdmin: actor.isAdmin },
      (tx) => tx.modpackInstallation.findFirst({ where: { serverId }, orderBy: { createdAt: 'desc' } }),
    );
    if (!installation) throw new ConflictException('Não há um modpack instalado para remover.');
    // DELETE is idempotent. A repeated request can arrive while the browser
    // still renders the pre-removal query result; treating the newest
    // already-uninstalled operation as success keeps the UI aligned with
    // the filesystem state. Looking at the newest operation first also
    // prevents a second DELETE from walking backwards to an older completed
    // installation and restoring the wrong pre-install backup.
    if (installation.status === 'uninstalled') return;
    if (installation.status !== 'completed') throw new ConflictException('Não há um modpack instalado para remover.');
    if (!installation.backupId) throw new ConflictException('O backup de segurança desta instalação não está disponível para remoção segura.');

    const runtime = await this.agent.getServerStatus(server.nodeId, server.id);
    if (runtime.state !== 'offline') throw new ConflictException('Desligue o servidor antes de remover o modpack.');

    await this.agent.restoreBackup(server.nodeId, server.id, installation.backupId);
    await this.prisma.withRLS({ userId: actor.isAdmin ? null : actor.id, isAdmin: actor.isAdmin }, (tx) =>
      tx.modpackInstallation.update({
        where: { id: installation.id },
        data: {
          status: 'uninstalled',
          progress: 100,
          message: 'Modpack removido; backup anterior restaurado.',
          completedAt: new Date(),
        },
      }),
    );
    await Promise.allSettled([
      this.audit.record({ action: 'server.modpack.uninstall', targetType: 'server', targetId: server.id, actorId: actor.id, metadata: { operationId: installation.id, backupId: installation.backupId } }),
      this.activity.record({ actorId: actor.id, serverId: server.id, event: 'server.modpack.uninstall', properties: { operationId: installation.id, projectName: installation.projectName, backupId: installation.backupId } }),
    ]);
  }

  async reportProgress(nodeId: string, serverId: string, dto: ModpackProgressDto) {
    const server = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.server.findFirst({ where: { id: serverId, nodeId }, select: { id: true } }),
    );
    if (!server) throw new ForbiddenException('Este node não controla o servidor informado.');
    await this.updateOperation(serverId, dto.operationId, dto);
  }

  /**
   * The Agent calls this after it has verified the CurseForge manifest inside
   * the downloaded pack. Binding the resolution to the active operation and
   * its owning node prevents a node token from becoming a general API-key
   * proxy for arbitrary CurseForge downloads.
   */
  async resolveCurseForgeFiles(nodeId: string, serverId: string, dto: ResolveCurseForgeFilesDto) {
    const operation = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.modpackInstallation.findFirst({
      where: {
        id: dto.operationId,
        serverId,
        source: 'curseforge',
        status: { in: ['pending', 'downloading', 'installing'] },
        server: { nodeId },
      },
      select: { id: true },
    }));
    if (!operation) throw new ForbiddenException('A instalação do CurseForge não está ativa neste node.');
    const provider = this.providers.get('curseforge');
    if (!(provider instanceof CurseForgeProvider)) throw new ForbiddenException('O catálogo do CurseForge não está disponível.');
    const files = await provider.resolveFiles(dto.files);
    const manualFiles = files.flatMap((file) => file.manual ? [{ name: file.manual.name, filename: file.filename, pageUrl: file.manual.pageUrl }] : []);
    await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.modpackInstallation.update({
      where: { id: operation.id },
      data: { manualFiles: manualFiles.length > 0 ? manualFiles : Prisma.DbNull },
    }));
    return { files: files.map(({ manual: _manual, ...file }) => file) };
  }

  private async updateOperation(serverId: string, operationId: string, dto: Pick<ModpackProgressDto, 'status' | 'progress' | 'message' | 'backupId' | 'errorMessage'>) {
    await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.modpackInstallation.updateMany({
      where: { id: operationId, serverId },
      data: {
        status: dto.status,
        progress: Math.max(0, Math.min(100, dto.progress)),
        message: dto.message,
        backupId: dto.backupId,
        errorMessage: dto.errorMessage,
        completedAt: ['completed', 'failed'].includes(dto.status) ? new Date() : null,
      },
    }));
  }

  async search(actor: AccessActor, serverId: string, query: SearchModpacksDto) {
    await this.assertCanView(actor, serverId);
    return this.provider(query.source).search(query);
  }

  async metadata(actor: AccessActor, serverId: string, source: ModpackSource) {
    await this.assertCanView(actor, serverId);
    return this.provider(source).getMetadata();
  }

  async project(actor: AccessActor, serverId: string, source: ModpackSource, projectId: string) {
    await this.assertCanView(actor, serverId);
    return this.provider(source).getProject(projectId);
  }

  async versions(actor: AccessActor, serverId: string, source: ModpackSource, projectId: string, filters: ListModpackVersionsDto) {
    await this.assertCanView(actor, serverId);
    return this.provider(source).getVersions(projectId, filters);
  }

  private provider(source: ModpackSource): ModpackProvider {
    const provider = this.providers.get(source);
    if (!provider) throw new ForbiddenException('Esta fonte de modpacks ainda não está disponível.');
    return provider;
  }

  private async assertCanView(actor: AccessActor, serverId: string): Promise<void> {
    const { can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    if (!can('addons.catalog.read')) throw new ForbiddenException('Missing permission: addons.catalog.read');
  }
}
