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
import { CurseForgeProvider, type CurseForgeProjectMeta } from '../plugins/curseforge.provider';
import { planCurseForgeRetrySkips } from './curseforge-retry-plan';
import { describeSoftware } from '../templates/software';

// See maybeRetryCurseForgeInstall's own comment for what this bounds. A
// pack like DeceasedCraft can need one round for a missing dependency and
// another for client-only mods that only fail once loading gets that far.
const MAX_CURSEFORGE_AUTO_RETRIES = 3;

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : [];
}

function asStringRecord(value: unknown): Record<string, string> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : {};
}

/** projectMeta when stored; otherwise slugs alone (rows written before it existed). */
function asProjectMeta(projectMeta: unknown, fileSlugs: unknown): Record<number, CurseForgeProjectMeta> {
  if (projectMeta && typeof projectMeta === 'object' && !Array.isArray(projectMeta)) return projectMeta as Record<number, CurseForgeProjectMeta>;
  const meta: Record<number, CurseForgeProjectMeta> = {};
  for (const [id, slug] of Object.entries(asStringRecord(fileSlugs))) meta[Number(id)] = { slug, name: slug, requires: [] };
  return meta;
}

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

    const operation = await this.dispatchInstall({
      serverId, nodeId: server.nodeId, diskMb: server.diskMb, requestedBy: actor.id, actorIsAdmin: actor.isAdmin,
      source: dto.source, projectId: dto.projectId, versionId: dto.versionId,
      projectName: project.name, versionName: version.versionNumber, minecraftVersion, loader, file,
    });
    await Promise.allSettled([
      this.audit.record({ action: 'server.modpack.install', targetType: 'server', targetId: server.id, actorId: actor.id, metadata: { operationId: operation.id, source: dto.source, projectId: dto.projectId, versionId: dto.versionId } }),
      this.activity.record({ actorId: actor.id, serverId: server.id, event: 'server.modpack.install', properties: { operationId: operation.id, projectName: project.name, versionName: version.versionNumber } }),
    ]);
    return this.latestInstallation(actor, serverId);
  }

  /**
   * Shared by a user-initiated install() and maybeRetryCurseForgeInstall():
   * creates the operation row (with the same conflict/advisory-lock guard
   * either way) and dispatches it to the Agent, rolling the row back to
   * 'failed' if the Agent itself refuses the dispatch.
   */
  private async dispatchInstall(params: {
    serverId: string; nodeId: string; diskMb: number; requestedBy: string; actorIsAdmin: boolean;
    source: ModpackSource; projectId: string; versionId: string; projectName: string; versionName: string;
    minecraftVersion: string; loader: string;
    file: { url: string; filename: string; size: number; hashes: { sha1?: string; sha512?: string } };
    retry?: { extraSkipProjectIds: number[]; retryCount: number; retriedFromId: string };
  }) {
    const { serverId, nodeId, diskMb, requestedBy, actorIsAdmin, source, projectId, versionId, projectName, versionName, minecraftVersion, loader, file, retry } = params;
    const operation = await this.prisma.withRLS({ userId: actorIsAdmin ? null : requestedBy, isAdmin: actorIsAdmin }, async (tx) => {
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
        requestedBy,
        source,
        projectId,
        versionId,
        projectName,
        versionName,
        minecraftVersion,
        loader,
        message: 'Aguardando o Agent',
        extraSkipProjectIds: retry ? retry.extraSkipProjectIds : undefined,
        retryCount: retry?.retryCount ?? 0,
        retriedFromId: retry?.retriedFromId,
      } });
    });

    try {
      await this.agent.installModpack(nodeId, serverId, {
        source,
        operationId: operation.id,
        sourceUrl: file.url,
        filename: file.filename,
        size: file.size,
        sha1: file.hashes.sha1,
        sha512: file.hashes.sha512,
        diskLimitMb: diskMb,
      });
    } catch (error) {
      await this.updateOperation(serverId, operation.id, {
        status: 'failed', progress: 0, message: 'O Agent recusou a instalação', errorMessage: error instanceof Error ? error.message : 'Falha desconhecida',
      });
      throw error;
    }
    return operation;
  }

  async latestInstallation(actor: AccessActor, serverId: string) {
    const { server, can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    if (!can('addons.catalog.read')) throw new ForbiddenException('Missing permission: addons.catalog.read');
    const installation = await this.prisma.withRLS({ userId: actor.isAdmin ? null : actor.id, isAdmin: actor.isAdmin }, (tx) =>
      tx.modpackInstallation.findFirst({ where: { serverId }, orderBy: { createdAt: 'desc' } }),
    );
    return this.withResolvedManualFiles(installation, server);
  }

  /**
   * manualFiles is a snapshot taken at install time. A customer who follows
   * the warning and uploads the restricted mods by hand has no other way to
   * make it go away — found live 2026-09-27: the alert stayed up after the
   * customer had genuinely added every listed file. Once an install is
   * 'completed', check which of the still-listed files are now actually
   * present in the addon directory and drop those from the stored list
   * (persisted, so this only costs an Agent call once per file that
   * appears, not on every subsequent page load).
   */
  private async withResolvedManualFiles<T extends { id: string; status: string; manualFiles: unknown }>(
    installation: T | null,
    server: { id: string; nodeId: string; template?: { softwareKind: string | null } | null },
  ): Promise<T | null> {
    if (!installation || installation.status !== 'completed') return installation;
    const manual = installation.manualFiles;
    if (!Array.isArray(manual) || manual.length === 0) return installation;
    const addonDir = describeSoftware(server.template?.softwareKind ?? null).addonDir;
    if (!addonDir) return installation;
    try {
      const entries = await this.agent.listFiles(server.nodeId, server.id, addonDir);
      const present = new Set(entries.filter((entry) => !entry.isDir).map((entry) => entry.name.toLowerCase()));
      const outstanding = (manual as Array<{ filename: string }>).filter((file) => !present.has(file.filename.toLowerCase()));
      if (outstanding.length === manual.length) return installation; // nothing resolved yet
      await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.modpackInstallation.update({
        where: { id: installation.id },
        data: { manualFiles: outstanding.length > 0 ? outstanding : Prisma.DbNull },
      }));
      return { ...installation, manualFiles: outstanding.length > 0 ? outstanding : null };
    } catch {
      return installation; // best-effort — an unreachable Agent shouldn't break the page, the stale list is still informative
    }
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
    if (dto.status === 'failed') {
      const operation = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.modpackInstallation.findUnique({ where: { id: dto.operationId } }));
      if (operation?.source === 'curseforge') await this.maybeRetryCurseForgeInstall(operation);
    }
  }

  /**
   * A CurseForge modpack can include a mod we correctly skipped (client-only,
   * or the author restricting distribution) that ANOTHER mod declares a
   * mandatory, non-client-scoped dependency on — the modpack itself is
   * misconfigured for dedicated-server use, but the missing companion is
   * usually cosmetic and safe to drop too. Forge/NeoForge report this at
   * boot as one "Mod §e<modid>§r requires §6<depId>§r" line per broken
   * dependency (BootFailureHint keeps every such line, uncapped by the
   * general hint budget — see its own comment). When the missing <depId>
   * matches the slug of a project we deliberately skipped in the attempt
   * that just failed, retrying once more with <modid> ALSO forced to skip
   * fixes exactly this class of failure without any customer action.
   *
   * Bounded to MAX_AUTO_RETRIES: a chain of dependents-of-dependents should
   * resolve well within that, and this must never become a silent retry
   * loop that never surfaces a REAL failure to the customer.
   */
  private async maybeRetryCurseForgeInstall(operation: {
    id: string; serverId: string; requestedBy: string; projectId: string; versionId: string; projectName: string; versionName: string;
    minecraftVersion: string; loader: string; errorMessage: string | null; retryCount: number;
    extraSkipProjectIds: unknown; skippedProjectIds: unknown; fileSlugs: unknown; projectMeta: unknown;
  }): Promise<void> {
    if (operation.retryCount >= MAX_CURSEFORGE_AUTO_RETRIES || !operation.errorMessage) return;
    const meta = asProjectMeta(operation.projectMeta, operation.fileSlugs);
    const existingExtraSkips = asNumberArray(operation.extraSkipProjectIds);
    const alreadySkipped = new Set([...asNumberArray(operation.skippedProjectIds), ...existingExtraSkips]);
    const newSkips = planCurseForgeRetrySkips(operation.errorMessage, meta, alreadySkipped);
    if (newSkips.length === 0) return;

    try {
      const server = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.server.findUniqueOrThrow({ where: { id: operation.serverId }, select: { nodeId: true, diskMb: true } }));
      const runtime = await this.agent.getServerStatus(server.nodeId, operation.serverId);
      if (runtime.state !== 'offline') return; // rollback should have left it offline; bail rather than fight a concurrent action
      const provider = this.providers.get('curseforge');
      if (!(provider instanceof CurseForgeProvider)) return;
      const version = await provider.getVersion(operation.versionId, operation.projectId);
      const file = version.files.find((candidate) => candidate.primary && candidate.filename.toLowerCase().endsWith('.zip')) ?? version.files.find((candidate) => candidate.filename.toLowerCase().endsWith('.zip'));
      if (!file?.url) return;

      const extraSkipProjectIds = [...existingExtraSkips, ...newSkips];
      const retried = await this.dispatchInstall({
        serverId: operation.serverId, nodeId: server.nodeId, diskMb: server.diskMb, requestedBy: operation.requestedBy, actorIsAdmin: true,
        source: 'curseforge', projectId: operation.projectId, versionId: operation.versionId,
        projectName: operation.projectName, versionName: operation.versionName, minecraftVersion: operation.minecraftVersion, loader: operation.loader,
        file, retry: { extraSkipProjectIds, retryCount: operation.retryCount + 1, retriedFromId: operation.id },
      });
      const skippedNames = newSkips.map((id) => meta[id]?.name ?? String(id));
      await Promise.allSettled([
        this.audit.record({ action: 'server.modpack.install.retry', targetType: 'server', targetId: operation.serverId, actorId: operation.requestedBy, metadata: { operationId: retried.id, retriedFromId: operation.id, retryCount: operation.retryCount + 1, additionallySkipped: skippedNames } }),
        this.activity.record({ actorId: operation.requestedBy, serverId: operation.serverId, event: 'server.modpack.install.retry', properties: { operationId: retried.id, projectName: operation.projectName, additionallySkipped: skippedNames } }),
      ]);
    } catch {
      // Best-effort: the original 'failed' status set by updateOperation()
      // above already stands, so the customer sees a real outcome either way.
    }
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
      select: { id: true, extraSkipProjectIds: true },
    }));
    if (!operation) throw new ForbiddenException('A instalação do CurseForge não está ativa neste node.');
    const provider = this.providers.get('curseforge');
    if (!(provider instanceof CurseForgeProvider)) throw new ForbiddenException('O catálogo do CurseForge não está disponível.');
    const { files: resolved, projectSlugs, projectMeta } = await provider.resolveFiles(dto.files);
    const extraSkipProjectIds = new Set(asNumberArray(operation.extraSkipProjectIds));
    // See maybeRetryCurseForgeInstall's comment: a retry forces skip=true on
    // projects that CurseForge itself would have resolved normally, because
    // something else in the pack declared a bad dependency on a project we
    // ALREADY skipped for an unrelated reason (client-only/author-restricted).
    const files = resolved.map((file) => extraSkipProjectIds.has(Number(file.projectId)) ? { ...file, skip: true } : file);
    const manualFiles = files.flatMap((file) => file.manual ? [{ name: file.manual.name, filename: file.filename, pageUrl: file.manual.pageUrl }] : []);
    const skippedProjectIds = [...new Set(files.filter((file) => file.skip).map((file) => Number(file.projectId)))];
    await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.modpackInstallation.update({
      where: { id: operation.id },
      data: {
        manualFiles: manualFiles.length > 0 ? manualFiles : Prisma.DbNull,
        skippedProjectIds,
        fileSlugs: projectSlugs,
        projectMeta: projectMeta as unknown as Prisma.InputJsonValue,
      },
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
