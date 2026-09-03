import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronLeft, Pencil } from 'lucide-react';
import { getNode, getNodeCapacity } from './admin.api';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  LoadingRow,
  Meter,
} from '@/ui/primitives';
import type { AdminNode } from '@/shared/api/types';

const HEALTH_LABELS: Record<string, string> = { online: 'Online', offline: 'Offline', degraded: 'Degradado', unknown: 'Desconhecido' };
const HEALTH_TONE: Record<string, 'ok' | 'warn' | 'fail' | 'neutral'> = { online: 'ok', degraded: 'warn', offline: 'fail', unknown: 'neutral' };
const VIRT_SYSTEM_LABELS: Record<string, string> = { kvm: 'KVM', lxc: 'LXC', vmware: 'VMware', xen: 'Xen', hyperv: 'Hyper-V', docker: 'Docker' };

function mb(value: number | null): string {
  if (value == null) return 'N/A';
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${value} MB`;
}

function pct(value: number | null): string {
  return value == null ? 'N/A' : `${value}%`;
}

function minutesAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return 'agora mesmo';
  if (mins < 60) return `${mins} minuto${mins === 1 ? '' : 's'} atrás`;
  const hours = Math.round(mins / 60);
  return `${hours} hora${hours === 1 ? '' : 's'} atrás`;
}

// "Capacidade vendável" is what the admin declared, read-only here — actual
// editing stays on NodesPage's NodeEditModal (single source of truth for
// that form) rather than duplicating it.
function SellableCapacityCard({ node }: { node: AdminNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Capacidade vendável</CardTitle>
        <Link to="/admin/nodes">
          <Button variant="ghost" size="sm">
            <Pencil className="h-4 w-4" aria-hidden="true" />
            Editar em Nodes
          </Button>
        </Link>
      </CardHeader>
      <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <p className="text-xs text-text-faint uppercase">RAM</p>
          <p className="mt-1 font-mono text-sm text-text">{mb(node.memoryTotalMb)}</p>
          {node.telemetryDivergence.memory === 'over' && <Badge tone="fail">Acima do detectado</Badge>}
        </div>
        <div>
          <p className="text-xs text-text-faint uppercase">CPU</p>
          <p className="mt-1 font-mono text-sm text-text">{node.cpuTotalPercent > 0 ? `${node.cpuTotalPercent}%` : 'sem controle'}</p>
          {node.telemetryDivergence.cpu === 'over' && <Badge tone="fail">Acima do detectado</Badge>}
        </div>
        <div>
          <p className="text-xs text-text-faint uppercase">Disco</p>
          <p className="mt-1 font-mono text-sm text-text">{mb(node.diskTotalMb)}</p>
          {node.telemetryDivergence.disk === 'over' && <Badge tone="fail">Acima do detectado</Badge>}
        </div>
      </CardBody>
    </Card>
  );
}

function HardwareDetectedCard({ node }: { node: AdminNode }) {
  const memTotal = node.reportedMemoryUsedMb != null && node.reportedMemoryAvailableMb != null ? node.reportedMemoryUsedMb + node.reportedMemoryAvailableMb : null;
  const diskUsed = node.reportedDiskTotalMb != null && node.reportedDiskFreeMb != null ? node.reportedDiskTotalMb - node.reportedDiskFreeMb : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Hardware detectado</CardTitle>
      </CardHeader>
      <CardBody className="space-y-5">
        <div>
          <p className="mb-2 text-xs font-semibold tracking-wide text-text-faint uppercase">CPU</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-text-faint">Modelo</dt>
              <dd className="font-mono text-text">{node.reportedCpuModel ?? 'N/A'}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-faint">vCPUs disponíveis</dt>
              <dd className="font-mono text-text">{node.reportedCpuCount ?? 'N/A'}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-faint">Cores físicos</dt>
              <dd className="font-mono text-text">{node.reportedCpuPhysicalCores ?? 'N/A'}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-faint">Sockets</dt>
              <dd className="font-mono text-text">{node.reportedCpuSockets ?? 'N/A'}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-faint">Uso atual</dt>
              <dd className="font-mono text-text">{pct(node.reportedCpuUsagePercent)}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-faint">Carga (1 min)</dt>
              <dd className="font-mono text-text">{node.reportedLoadAvg1 ?? 'N/A'}</dd>
            </div>
          </dl>
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold tracking-wide text-text-faint uppercase">Memória</p>
          {node.reportedMemoryUsedMb != null && memTotal != null ? (
            <Meter
              usedPct={(node.reportedMemoryUsedMb / memTotal) * 100}
              tone="normal"
              hint={`${mb(node.reportedMemoryUsedMb)} usados / ${mb(memTotal)}`}
            />
          ) : (
            <p className="font-mono text-sm text-text-faint">N/A</p>
          )}
          <p className="mt-1 text-xs text-text-faint">Disponível: {mb(node.reportedMemoryAvailableMb)}</p>
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold tracking-wide text-text-faint uppercase">Armazenamento ({node.daemonDataPath})</p>
          {diskUsed != null && node.reportedDiskTotalMb != null ? (
            <Meter usedPct={(diskUsed / node.reportedDiskTotalMb) * 100} tone="normal" hint={`${mb(diskUsed)} usados / ${mb(node.reportedDiskTotalMb)}`} />
          ) : (
            <p className="font-mono text-sm text-text-faint">N/A</p>
          )}
          <p className="mt-1 text-xs text-text-faint">Livre: {mb(node.reportedDiskFreeMb)}</p>
        </div>
      </CardBody>
    </Card>
  );
}

function EnvironmentCard({ node }: { node: AdminNode }) {
  const system = node.reportedVirtualizationSystem;
  const role = node.reportedVirtualizationRole;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Ambiente</CardTitle>
      </CardHeader>
      <CardBody>
        {!system ? (
          <p className="text-sm text-text-faint">Virtualização não detectada.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={role === 'guest' ? 'warn' : 'neutral'}>{role === 'guest' ? 'Virtualizado' : 'Host'}</Badge>
            <span className="text-text-muted">Hypervisor: {VIRT_SYSTEM_LABELS[system] ?? system}</span>
          </div>
        )}
        {system === 'lxc' && (
          <p className="mt-2 text-xs text-text-faint">
            Contêiner LXC — cores físicos e sockets não são reportados (não são confiáveis dentro de um LXC), apenas o modelo de CPU e os vCPUs disponíveis.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function UsageCard({ node }: { node: AdminNode }) {
  const { data: snapshot } = useQuery({ queryKey: ['admin', 'capacity', 'node', node.id], queryFn: () => getNodeCapacity(node.id) });
  if (!snapshot) return null;
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Capacidade utilizada pelos servidores</CardTitle>
        </CardHeader>
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Meter usedPct={snapshot.memory.usedPct} tone={snapshot.memory.status} label="RAM" hint={`${snapshot.memory.allocated} / ${snapshot.memory.commercial}${snapshot.memory.isUnlimited ? '+' : ''} MB`} />
          <Meter usedPct={snapshot.disk.usedPct} tone={snapshot.disk.status} label="Disco" hint={`${snapshot.disk.allocated} / ${snapshot.disk.commercial}${snapshot.disk.isUnlimited ? '+' : ''} MB`} />
          {snapshot.cpu.accountingEnabled ? (
            <Meter usedPct={snapshot.cpu.usedPct} tone={snapshot.cpu.status} label="CPU" hint={`${snapshot.cpu.allocated} / ${snapshot.cpu.commercial}${snapshot.cpu.isUnlimited ? '+' : ''}%`} />
          ) : (
            <div className="flex items-center text-xs text-text-faint">CPU: sem controle neste node</div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Disponível para novos servidores</CardTitle>
        </CardHeader>
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs text-text-faint uppercase">RAM</p>
            <p className="mt-1 font-mono text-sm text-text">{snapshot.memory.available == null ? 'ilimitado' : mb(snapshot.memory.available)}</p>
          </div>
          <div>
            <p className="text-xs text-text-faint uppercase">Disco</p>
            <p className="mt-1 font-mono text-sm text-text">{snapshot.disk.available == null ? 'ilimitado' : mb(snapshot.disk.available)}</p>
          </div>
          <div>
            <p className="text-xs text-text-faint uppercase">CPU</p>
            <p className="mt-1 font-mono text-sm text-text">
              {!snapshot.cpu.accountingEnabled ? 'sem controle' : snapshot.cpu.available == null ? 'ilimitado' : `${snapshot.cpu.available}%`}
            </p>
          </div>
        </CardBody>
      </Card>
    </>
  );
}

export function NodeDetailPage({ nodeId }: { nodeId: string }) {
  const { data: node, isLoading, isError } = useQuery({ queryKey: ['admin', 'node', nodeId], queryFn: () => getNode(nodeId) });

  return (
    <>
      <Link to="/admin/nodes" className="mb-4 inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        Todos os nodes
      </Link>

      {isLoading && <LoadingRow />}
      {isError && <Alert className="mb-6">Não foi possível carregar este node.</Alert>}

      {node && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-text">{node.name}</h1>
            <Badge tone={HEALTH_TONE[node.healthStatus] ?? 'neutral'}>{HEALTH_LABELS[node.healthStatus] ?? node.healthStatus}</Badge>
            {node.maintenanceMode && <Badge tone="warn">Manutenção</Badge>}
            {!node.isPublic && <Badge tone="neutral">Privado</Badge>}
          </div>
          <p className="-mt-4 font-mono text-xs text-text-faint">
            {node.scheme}://{node.fqdn}:{node.daemonPort}
          </p>

          {node.healthStatus !== 'online' && node.reportedAt && (
            <Alert tone="warn">
              ⚠️ Node {node.healthStatus === 'offline' ? 'offline' : 'degradado'} — última atualização de hardware: {minutesAgo(node.reportedAt)}. Os dados de hardware abaixo são os últimos conhecidos, não necessariamente o estado atual.
            </Alert>
          )}
          {!node.reportedAt && <Alert tone="warn">Este node ainda não enviou nenhuma telemetria de hardware.</Alert>}

          <HardwareDetectedCard node={node} />
          <EnvironmentCard node={node} />
          <SellableCapacityCard node={node} />
          <UsageCard node={node} />
        </div>
      )}
    </>
  );
}
