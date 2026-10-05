import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AgentClient, type AgentDiagnosticCheck } from '../nodes/agent-client.service';
import { deriveHealthStatus } from '../nodes/nodes.service';
import { NodeSchedulerService } from '../scheduler/node-scheduler.service';
import { pickDockerImage } from '../templates/software-presets';

export type DiagnosticStatus = 'ok' | 'warn' | 'fail';

export interface DiagnosticCheck {
  key: string;
  label: string;
  status: DiagnosticStatus;
  detail: string;
}

export interface NodeDiagnostics {
  nodeId: string;
  name: string;
  maintenanceMode: boolean;
  status: DiagnosticStatus;
  checks: DiagnosticCheck[];
}

export interface PlanDiagnostics {
  planId: string;
  name: string;
  slug: string;
  status: DiagnosticStatus;
  detail: string;
}

export interface PlatformDiagnostics {
  ranAt: string;
  status: DiagnosticStatus;
  plans: PlanDiagnostics[];
  nodes: NodeDiagnostics[];
}

// Every host a customer's install or first boot depends on: the vanilla jar
// Paper patches at startup, the loaders' installers, and the mod/plugin CDNs.
export const PROBE_TARGETS = [
  'piston-data.mojang.com',
  'api.papermc.io',
  'api.modrinth.com',
  'cdn.modrinth.com',
  'edge.forgecdn.net',
  'maven.minecraftforge.net',
  'maven.neoforged.net',
  'meta.fabricmc.net',
];

const CLOCK_SKEW_WARN_MS = 60_000;

const CHECK_LABELS: Record<string, string> = {
  docker: 'Docker',
  allocation_ips: 'IPs das allocations',
  container_dns_config: 'DNS dos servidores existentes',
  egress: 'Internet dentro do container',
};

export function labelFor(key: string): string {
  if (key.startsWith('egress:')) return `Internet do container → ${key.slice('egress:'.length)}`;
  return CHECK_LABELS[key] ?? key;
}

export function worstStatus(statuses: DiagnosticStatus[]): DiagnosticStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'ok';
}

export function heartbeatCheck(lastHeartbeatAt: Date | null): DiagnosticCheck {
  const health = deriveHealthStatus(lastHeartbeatAt);
  const age = lastHeartbeatAt ? Math.round((Date.now() - lastHeartbeatAt.getTime()) / 1000) : null;
  const detail = age === null ? 'o agente nunca enviou heartbeat' : `último heartbeat há ${age}s`;
  const status: DiagnosticStatus = health === 'online' ? 'ok' : health === 'degraded' ? 'warn' : 'fail';
  return { key: 'heartbeat', label: 'Heartbeat do agente', status, detail };
}

export function clockCheck(agentTime: string, now = Date.now()): DiagnosticCheck {
  const skew = Math.abs(new Date(agentTime).getTime() - now);
  const status: DiagnosticStatus = Number.isNaN(skew) ? 'warn' : skew > CLOCK_SKEW_WARN_MS ? 'warn' : 'ok';
  const detail = Number.isNaN(skew) ? 'o agente não informou o horário' : `diferença de ${Math.round(skew / 1000)}s para o painel`;
  return { key: 'clock', label: 'Relógio do node', status, detail };
}

export function fromAgentCheck(check: AgentDiagnosticCheck): DiagnosticCheck {
  return { key: check.key, label: labelFor(check.key), status: check.ok ? 'ok' : 'fail', detail: check.detail };
}

@Injectable()
export class DiagnosticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentClient,
    private readonly scheduler: NodeSchedulerService,
  ) {}

  async run(): Promise<PlatformDiagnostics> {
    const asAdmin = { userId: null, isAdmin: true };
    const [nodes, plans, probeImage] = await Promise.all([
      this.prisma.withRLS(asAdmin, (tx) => tx.node.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } })),
      this.prisma.withRLS(asAdmin, (tx) => tx.plan.findMany({ where: { deletedAt: null, isPublic: true }, orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }] })),
      this.probeImage(),
    ]);

    const [nodeResults, planResults] = await Promise.all([
      Promise.all(nodes.map((node) => this.diagnoseNode(node, probeImage))),
      Promise.all(plans.map((plan) => this.diagnosePlan(plan))),
    ]);

    return {
      ranAt: new Date().toISOString(),
      status: worstStatus([...nodeResults.map((n) => n.status), ...planResults.map((p) => p.status)]),
      plans: planResults,
      nodes: nodeResults,
    };
  }

  private async diagnoseNode(
    node: { id: string; name: string; maintenanceMode: boolean; lastHeartbeatAt: Date | null },
    probeImage: string | undefined,
  ): Promise<NodeDiagnostics> {
    const checks: DiagnosticCheck[] = [heartbeatCheck(node.lastHeartbeatAt)];
    const allocations = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.allocation.findMany({ where: { nodeId: node.id }, select: { ip: true }, distinct: ['ip'] }),
    );

    try {
      const result = await this.agent.diagnostics(node.id, { image: probeImage, targets: PROBE_TARGETS, ips: allocations.map((a) => a.ip) });
      checks.push(clockCheck(result.agentTime), ...result.checks.map(fromAgentCheck));
    } catch (err) {
      if (err instanceof NotFoundException) {
        checks.push({ key: 'agent', label: 'Agente acessível pelo painel', status: 'warn', detail: 'o agente deste node é anterior ao diagnóstico — atualize o binário para rodar os testes internos' });
      } else {
        checks.push({ key: 'agent', label: 'Agente acessível pelo painel', status: 'fail', detail: (err as Error).message.slice(0, 300) });
      }
    }

    return { nodeId: node.id, name: node.name, maintenanceMode: node.maintenanceMode, status: worstStatus(checks.map((c) => c.status)), checks };
  }

  // A public plan no node will take is a checkout that fails after payment.
  // Asking the real scheduler keeps this in lockstep with what a purchase
  // would actually do (plan restrictions, health, capacity, free ports).
  private async diagnosePlan(plan: { id: string; name: string; slug: string }): Promise<PlanDiagnostics> {
    const base = { planId: plan.id, name: plan.name, slug: plan.slug };
    try {
      const { selected, candidates } = await this.scheduler.selectNode(plan.id);
      if (selected) return { ...base, status: 'ok', detail: `novas compras vão para ${selected.name}` };
      const reasons = candidates.map((c) => `${c.name}: ${c.reason ?? 'eliminado'}`);
      return { ...base, status: 'fail', detail: reasons.length ? `nenhum node aceita — ${reasons.join('; ')}` : 'nenhum node cadastrado' };
    } catch (err) {
      return { ...base, status: 'fail', detail: (err as Error).message };
    }
  }

  private async probeImage(): Promise<string | undefined> {
    const template = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.serverTemplate.findFirst({ where: { softwareKind: 'paper', deletedAt: null, isActive: true } }),
    );
    if (!template) return undefined;
    return pickDockerImage(template.dockerImages as Record<string, string>, undefined);
  }
}
