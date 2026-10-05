import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { MailService } from '../../core/mail/mail.service';
import type { AccessActor } from '../authorization/server-access.service';
import { DiagnosticsService } from '../diagnostics/diagnostics.service';
import { ModpacksService } from '../modpacks/modpacks.service';
import { ModrinthProvider } from '../modpacks/modrinth.provider';
import { AgentClient } from '../nodes/agent-client.service';
import { deriveHealthStatus } from '../nodes/nodes.service';
import { PluginsService } from '../plugins/plugins.service';
import { ClientServersService } from '../servers/client-servers.service';
import { ServerSetupService } from '../servers/server-setup.service';
import { ServersService } from '../servers/servers.service';
import {
  CANARY_SCENARIOS,
  assignScenarios,
  dayOffset,
  pickModpackVersion,
  pickPlanForNode,
  type CanaryAssignment,
  type CanaryNodeTarget,
} from './canary-plan';
import { ConsoleWatch } from './console-watch';

export const CANARY_NAME_PREFIX = 'canary-';
const MIN = 60_000;
const INSTALL_TIMEOUT_MS = 15 * MIN;
const STOP_TIMEOUT_MS = 3 * MIN;
const STALE_RUN_MS = 3 * 60 * MIN;
const MARKER_FILE = 'canary-marker.txt';

export type CanaryStepStatus = 'passed' | 'failed';
export type CanaryScenarioStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface CanaryStepResult {
  name: string;
  status: CanaryStepStatus;
  durationMs: number;
  detail?: string;
}

export interface CanaryScenarioResult {
  softwareKind: string;
  nodeName: string;
  status: CanaryScenarioStatus;
  minecraftVersion?: string;
  detail?: string;
  steps: CanaryStepResult[];
  logTail?: string[];
}

class StepFailed extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class CanaryService {
  private readonly logger = new Logger(CanaryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly servers: ServersService,
    private readonly clientServers: ClientServersService,
    private readonly setup: ServerSetupService,
    private readonly plugins: PluginsService,
    private readonly modpacks: ModpacksService,
    private readonly modrinth: ModrinthProvider,
    private readonly agent: AgentClient,
    private readonly diagnostics: DiagnosticsService,
  ) {}

  private asAdmin<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }

  async run(trigger: 'schedule' | 'manual'): Promise<string | null> {
    const now = Date.now();
    const running = await this.asAdmin((tx) => tx.canaryRun.findFirst({ where: { status: 'running' }, orderBy: { startedAt: 'desc' } }));
    if (running && now - running.startedAt.getTime() < STALE_RUN_MS) {
      this.logger.warn(`canary run ${running.id} still in progress — skipping`);
      return null;
    }
    if (running) {
      await this.asAdmin((tx) =>
        tx.canaryRun.update({ where: { id: running.id }, data: { status: 'failed', finishedAt: new Date(), summary: 'Interrompido (o worker reiniciou no meio da execução).' } }),
      );
    }

    const run = await this.asAdmin((tx) => tx.canaryRun.create({ data: { trigger } }));
    const results: CanaryScenarioResult[] = [];
    const save = () => this.asAdmin((tx) => tx.canaryRun.update({ where: { id: run.id }, data: { results: results as never } }));

    try {
      const admin = await this.asAdmin((tx) => tx.user.findFirst({ where: { globalRole: 'root_admin', deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } }));
      if (!admin) throw new Error('nenhum root_admin para ser dono dos servidores de teste');
      const actor: AccessActor = { id: admin.id, isAdmin: true };

      await this.sweepLeftovers();
      const diagnostics = await this.diagnostics.run();
      await this.asAdmin((tx) => tx.canaryRun.update({ where: { id: run.id }, data: { diagnostics: diagnostics as never } }));

      const { assignments, missingTemplates, targets } = await this.plan();
      for (const kind of missingTemplates) results.push({ softwareKind: kind, nodeName: '—', status: 'skipped', detail: 'sem template ativo', steps: [] });
      for (const a of assignments) results.push({ softwareKind: a.scenario.softwareKind, nodeName: a.target.nodeName, status: 'pending', steps: [] });
      if (targets.length === 0) throw new Error('nenhum node online e com plano à venda para receber os testes');
      await save();

      const byNode = new Map<string, Array<{ a: CanaryAssignment; r: CanaryScenarioResult }>>();
      assignments.forEach((a) => {
        const r = results.find((x) => x.softwareKind === a.scenario.softwareKind && x.status === 'pending')!;
        byNode.set(a.target.nodeId, [...(byNode.get(a.target.nodeId) ?? []), { a, r }]);
      });
      await Promise.all(
        [...byNode.values()].map(async (queue) => {
          for (const { a, r } of queue) {
            r.status = 'running';
            await save();
            await this.runScenario(actor, a, r);
            await save();
          }
        }),
      );

      const diagFailed = diagnostics.status === 'fail';
      const failed = results.filter((r) => r.status === 'failed');
      const status = failed.length > 0 || diagFailed ? 'failed' : 'passed';
      const summary = this.summarize(results, diagFailed);
      await this.asAdmin((tx) => tx.canaryRun.update({ where: { id: run.id }, data: { status, summary, finishedAt: new Date(), results: results as never } }));
      if (status === 'failed') await this.alert(summary, results);
      return run.id;
    } catch (err) {
      const summary = `Erro ao executar o canário: ${(err as Error).message}`;
      this.logger.error(summary);
      await this.asAdmin((tx) => tx.canaryRun.update({ where: { id: run.id }, data: { status: 'failed', summary, finishedAt: new Date(), results: results as never } }));
      await this.alert(summary, results);
      return run.id;
    }
  }

  private summarize(results: CanaryScenarioResult[], diagFailed: boolean): string {
    const count = (s: CanaryScenarioStatus) => results.filter((r) => r.status === s).length;
    const parts = [`${count('passed')} ok`, `${count('failed')} com falha`];
    if (count('skipped')) parts.push(`${count('skipped')} pulado(s)`);
    const failed = results.filter((r) => r.status === 'failed').map((r) => `${r.softwareKind}@${r.nodeName}`);
    return `${parts.join(', ')}${failed.length ? ` — falhou: ${failed.join(', ')}` : ''}${diagFailed ? ' — diagnóstico dos nodes com falha' : ''}`;
  }

  private async plan(): Promise<{ assignments: CanaryAssignment[]; missingTemplates: string[]; targets: CanaryNodeTarget[] }> {
    const [nodes, plans, templates] = await Promise.all([
      this.asAdmin((tx) => tx.node.findMany({ where: { deletedAt: null, maintenanceMode: false, isPublic: true }, orderBy: { name: 'asc' } })),
      this.asAdmin((tx) => tx.plan.findMany({ where: { deletedAt: null, isPublic: true }, select: { id: true, priceCents: true, nodes: { select: { nodeId: true } } } })),
      this.asAdmin((tx) => tx.serverTemplate.findMany({ where: { deletedAt: null, isActive: true }, orderBy: { name: 'asc' }, select: { id: true, softwareKind: true } })),
    ]);
    const planRows = plans.map((p) => ({ id: p.id, priceCents: p.priceCents, nodeIds: p.nodes.map((n) => n.nodeId) }));
    const targets: CanaryNodeTarget[] = [];
    for (const node of nodes) {
      if (deriveHealthStatus(node.lastHeartbeatAt) !== 'online') continue;
      const planId = pickPlanForNode(node.id, planRows);
      if (planId) targets.push({ nodeId: node.id, nodeName: node.name, planId });
    }
    const templateIdByKind = new Map<string, string>();
    for (const t of templates) {
      const kind = t.softwareKind?.toLowerCase();
      if (kind && !templateIdByKind.has(kind)) templateIdByKind.set(kind, t.id);
    }
    const { assignments, missingTemplates } = assignScenarios(CANARY_SCENARIOS, templateIdByKind, targets, dayOffset(new Date()));
    return { assignments, missingTemplates, targets };
  }

  /** Servers left behind by a run that died mid-way (worker restart, deploy). */
  private async sweepLeftovers(): Promise<void> {
    const leftovers = await this.asAdmin((tx) => tx.server.findMany({ where: { name: { startsWith: CANARY_NAME_PREFIX } }, select: { id: true, name: true } }));
    for (const s of leftovers) {
      try {
        await this.servers.remove(s.id);
        this.logger.warn(`removed leftover canary server ${s.name}`);
      } catch (err) {
        this.logger.error(`could not remove leftover canary server ${s.name}: ${(err as Error).message}`);
      }
    }
  }

  private async runScenario(actor: AccessActor, a: CanaryAssignment, r: CanaryScenarioResult): Promise<void> {
    const { scenario, target } = a;
    let serverId: string | null = null;
    let watch: ConsoleWatch | null = null;

    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const started = Date.now();
      try {
        const value = await fn();
        r.steps.push({ name, status: 'passed', durationMs: Date.now() - started });
        return value;
      } catch (err) {
        r.steps.push({ name, status: 'failed', durationMs: Date.now() - started, detail: (err as Error).message.slice(0, 500) });
        throw new StepFailed((err as Error).message);
      }
    };

    const boot = async (name: string, action: 'start' | 'restart') => {
      watch?.close();
      const { token, wsUrl } = await this.clientServers.mintConsoleToken(actor, serverId!);
      watch = await ConsoleWatch.open(wsUrl, token);
      watch.arm();
      await step(name, async () => {
        await this.clientServers.power(actor, serverId!, action);
        await watch!.waitFor(/Done \([\d.,]+s\)!/, scenario.bootTimeoutMs);
      });
    };

    try {
      let variables: Record<string, string> | undefined;
      let modpack: Awaited<ReturnType<CanaryService['resolveModpack']>> = null;
      if (scenario.addon?.type === 'modpack') {
        modpack = await this.resolveModpack(scenario.addon.slugs, scenario.softwareKind);
        if (!modpack) {
          r.status = 'skipped';
          r.detail = `nenhum modpack da lista (${scenario.addon.slugs.join(', ')}) tem versão para ${scenario.softwareKind}`;
          return;
        }
        variables = { MINECRAFT_VERSION: modpack.minecraftVersion };
        r.minecraftVersion = modpack.minecraftVersion;
      }

      const created = await step('Criar servidor', () =>
        this.servers.create({
          ownerId: actor.id,
          nodeId: target.nodeId,
          templateId: a.templateId,
          planId: target.planId,
          name: `${CANARY_NAME_PREFIX}${scenario.softwareKind}-${new Date().toISOString().slice(0, 10)}`,
          variables,
        }),
      );
      serverId = created.id;

      await step(`Instalar ${scenario.softwareKind}`, () => this.waitForStatus(serverId!, 'ready', INSTALL_TIMEOUT_MS));
      if (!r.minecraftVersion) r.minecraftVersion = await this.currentVersion(serverId);

      if (scenario.addon?.type === 'plugin') {
        const addon = scenario.addon;
        await step(`Instalar plugin ${addon.name}`, () => this.plugins.install(actor, serverId!, addon.projectId));
      }
      if (modpack) {
        const pack = modpack;
        await step(`Instalar modpack ${pack.slug}`, async () => {
          await this.modpacks.install(actor, serverId!, { source: 'modrinth', projectId: pack.projectId, versionId: pack.versionId });
          await this.waitForModpack(actor, serverId!);
        });
      }

      await boot('Primeira inicialização', 'start');

      if (scenario.addon?.type === 'plugin') {
        const addon = scenario.addon;
        await step(`Plugin ${addon.name} carregado`, async () => {
          const parent = addon.dataDir.split('/').slice(0, -1).join('/');
          const name = addon.dataDir.split('/').pop();
          const entries = await this.agent.listFiles(target.nodeId, serverId!, parent);
          if (!entries.some((e) => e.name === name && e.isDir)) throw new Error(`${addon.dataDir} não foi criado — o plugin não habilitou`);
        });
      }

      await boot('Reiniciar', 'restart');

      await step('Desligar', async () => {
        await this.clientServers.power(actor, serverId!, 'stop');
        await this.waitForPowerState(target.nodeId, serverId!, ['offline'], STOP_TIMEOUT_MS);
      });

      await step('Reinstalar versão atual', async () => {
        await this.agent.writeFile(target.nodeId, serverId!, MARKER_FILE, `canary ${new Date().toISOString()}\n`);
        await this.setup.reinstallCurrent(actor, serverId!);
        await this.waitForStatus(serverId!, 'ready', INSTALL_TIMEOUT_MS);
      });

      await step('Mundo e arquivos preservados', async () => {
        const root = await this.agent.listFiles(target.nodeId, serverId!, '');
        if (!root.some((e) => e.name === MARKER_FILE)) throw new Error('um arquivo do cliente sumiu na reinstalação');
        const world = root.find((e) => e.name === 'world' && e.isDir);
        if (!world) throw new Error('a pasta world sumiu na reinstalação');
        const worldFiles = await this.agent.listFiles(target.nodeId, serverId!, 'world');
        if (!worldFiles.some((e) => e.name === 'level.dat')) throw new Error('world/level.dat sumiu na reinstalação');
      });

      await boot('Inicializar após reinstalar', 'start');

      await step('Desligar no final', async () => {
        await this.clientServers.power(actor, serverId!, 'stop');
        await this.waitForPowerState(target.nodeId, serverId!, ['offline'], STOP_TIMEOUT_MS);
      });

      r.status = 'passed';
    } catch (err) {
      r.status = 'failed';
      if (!(err instanceof StepFailed)) r.detail = (err as Error).message.slice(0, 500);
      r.logTail = (watch as ConsoleWatch | null)?.tail(30);
    } finally {
      (watch as ConsoleWatch | null)?.close();
      if (serverId) {
        const id = serverId;
        try {
          await this.servers.remove(id);
        } catch (err) {
          r.status = 'failed';
          r.steps.push({ name: 'Remover servidor de teste', status: 'failed', durationMs: 0, detail: (err as Error).message.slice(0, 300) });
        }
      }
    }
  }

  private async resolveModpack(slugs: string[], loader: string) {
    for (const slug of slugs) {
      try {
        const versions = await this.modrinth.getVersions(slug, { loader });
        const picked = pickModpackVersion(versions, loader);
        if (picked) return { ...picked, slug };
      } catch (err) {
        this.logger.warn(`modpack ${slug} unavailable: ${(err as Error).message}`);
      }
    }
    return null;
  }

  private async currentVersion(serverId: string): Promise<string | undefined> {
    const row = await this.asAdmin((tx) =>
      tx.serverVariable.findFirst({ where: { serverId, variable: { envVariable: 'MINECRAFT_VERSION' } }, select: { value: true } }),
    );
    return row?.value ?? undefined;
  }

  private async waitForStatus(serverId: string, want: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await this.asAdmin((tx) => tx.server.findUnique({ where: { id: serverId }, select: { status: true } }));
      if (s?.status === want) return;
      if (s?.status === 'install_failed') throw new Error('a instalação falhou (install_failed)');
      await sleep(5000);
    }
    throw new Error(`não chegou em "${want}" em ${Math.round(timeoutMs / 60000)} min`);
  }

  private async waitForPowerState(nodeId: string, serverId: string, want: string[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      last = (await this.agent.getServerStatus(nodeId, serverId)).state;
      if (want.includes(last)) return;
      await sleep(3000);
    }
    throw new Error(`continuou em "${last}" por ${Math.round(timeoutMs / 1000)}s`);
  }

  private async waitForModpack(actor: AccessActor, serverId: string): Promise<void> {
    const deadline = Date.now() + INSTALL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const inst = (await this.modpacks.latestInstallation(actor, serverId)) as { status: string; errorMessage?: string | null; retries?: unknown } | null;
      if (inst?.status === 'completed') return;
      if (inst?.status === 'failed') throw new Error(`instalação do modpack falhou: ${inst.errorMessage ?? 'sem detalhe'}`);
      await sleep(5000);
    }
    throw new Error('a instalação do modpack não terminou em 15 min');
  }

  private async alert(summary: string, results: CanaryScenarioResult[]): Promise<void> {
    try {
      const admins = await this.asAdmin((tx) => tx.user.findMany({ where: { globalRole: 'root_admin', deletedAt: null }, select: { email: true } }));
      const lines = results
        .filter((r) => r.status === 'failed')
        .map((r) => {
          const bad = r.steps.find((s) => s.status === 'failed');
          return `- ${r.softwareKind} no ${r.nodeName}: ${bad ? `${bad.name} — ${bad.detail ?? ''}` : r.detail ?? 'falhou'}`;
        });
      const url = `${this.config.get<string>('PANEL_URL')}/admin/system`;
      const text = `O teste canário do GXhost encontrou problemas.\n\n${summary}\n\n${lines.join('\n')}\n\nDetalhes: ${url}`;
      await Promise.all(admins.map((a) => this.mail.sendAdminAlert(a.email, `[GXhost] Canário com falha — ${summary.slice(0, 80)}`, text)));
    } catch (err) {
      this.logger.error(`could not send canary alert: ${(err as Error).message}`);
    }
  }
}
