import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { HardDrive, ListCollapse, Pencil, Trash2 } from 'lucide-react';
import {
  createAllocationRange,
  createNode,
  deleteNode,
  getCapacityDashboard,
  issueBootstrapToken,
  listAllocations,
  listLocations,
  listNodes,
  rotateNodeToken,
  updateNode,
  type UpdateNodeInput,
} from './admin.api';
import { ApiError } from '@/shared/api/client';
import type { AdminNode, BootstrapTokenResponse, NodeCapacitySnapshot } from '@/shared/api/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  LoadingRow,
  Meter,
  Modal,
  PageHeader,
  Select,
  Toggle,
} from '@/ui/primitives';

const HEALTH_LABELS: Record<string, string> = { online: 'Online', offline: 'Offline', degraded: 'Degradado', unknown: 'Desconhecido' };
const HEALTH_TONE: Record<string, 'ok' | 'warn' | 'fail' | 'neutral'> = { online: 'ok', degraded: 'warn', offline: 'fail', unknown: 'neutral' };

function NodeAllocations({ nodeId }: { nodeId: string }) {
  const queryClient = useQueryClient();
  const { data: allocations } = useQuery({ queryKey: ['admin', 'allocations', nodeId], queryFn: () => listAllocations(nodeId) });
  const [ip, setIp] = useState('');
  const [startPort, setStartPort] = useState('26000');
  const [endPort, setEndPort] = useState('26010');
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    if (!ip.trim()) return;
    setError(null);
    try {
      await createAllocationRange(nodeId, { ip: ip.trim(), startPort: Number(startPort), endPort: Number(endPort) });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'allocations', nodeId] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível criar as alocações.');
    }
  }

  return (
    <div className="mt-4 rounded-lg bg-surface-2 p-3">
      <p className="mb-2 text-xs font-semibold tracking-wide text-text-faint uppercase">Alocações ({allocations?.length ?? 0})</p>
      <div className="flex flex-wrap items-end gap-2">
        <Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="203.0.113.10" className="w-36 font-mono text-xs" />
        <Input value={startPort} onChange={(e) => setStartPort(e.target.value)} className="w-20 font-mono text-xs" />
        <span className="pb-2.5 text-xs text-text-faint">até</span>
        <Input value={endPort} onChange={(e) => setEndPort(e.target.value)} className="w-20 font-mono text-xs" />
        <Button variant="secondary" size="sm" onClick={() => void handleCreate()}>
          + Adicionar faixa
        </Button>
      </div>
      {error && <p className="mt-1 text-xs text-fail">{error}</p>}
    </div>
  );
}

// ---- capacity meters on each node card ----

function NodeCapacityMeters({ snapshot }: { snapshot: NodeCapacitySnapshot | undefined }) {
  if (!snapshot) return null;
  return (
    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Meter
        usedPct={snapshot.memory.usedPct}
        tone={snapshot.memory.status}
        label="RAM"
        hint={`${snapshot.memory.allocated} / ${snapshot.memory.commercial}${snapshot.memory.isUnlimited ? '+' : ''} MB`}
      />
      <Meter
        usedPct={snapshot.disk.usedPct}
        tone={snapshot.disk.status}
        label="Disco"
        hint={`${snapshot.disk.allocated} / ${snapshot.disk.commercial}${snapshot.disk.isUnlimited ? '+' : ''} MB`}
      />
      {snapshot.cpu.accountingEnabled ? (
        <Meter
          usedPct={snapshot.cpu.usedPct}
          tone={snapshot.cpu.status}
          label="CPU"
          hint={`${snapshot.cpu.allocated} / ${snapshot.cpu.commercial}${snapshot.cpu.isUnlimited ? '+' : ''}%`}
        />
      ) : (
        <div className="flex items-center text-xs text-text-faint">CPU: sem controle neste node</div>
      )}
    </div>
  );
}

// ---- edit modal ----

interface OverallocateValue {
  enabled: boolean;
  unlimited: boolean;
  pct: string;
}

function pctToOverallocate(pct: number): OverallocateValue {
  if (pct === -1) return { enabled: true, unlimited: true, pct: '0' };
  if (pct === 0) return { enabled: false, unlimited: false, pct: '0' };
  return { enabled: true, unlimited: false, pct: String(pct) };
}

function overallocateToPct(v: OverallocateValue): number {
  if (!v.enabled) return 0;
  if (v.unlimited) return -1;
  return Number(v.pct) || 0;
}

function OverallocateControl({ value, onChange }: { value: OverallocateValue; onChange: (v: OverallocateValue) => void }) {
  return (
    <div className="space-y-2 rounded-lg bg-surface-2 p-3">
      <Toggle
        checked={value.enabled}
        onChange={(enabled) => onChange({ ...value, enabled })}
        label="Permitir vender além do físico"
        description="Overallocate — a soma das vagas vendidas pode passar do total menos a reserva."
      />
      {value.enabled && (
        <div className="flex flex-wrap items-center gap-4 pt-1 pl-1">
          <Toggle checked={value.unlimited} onChange={(unlimited) => onChange({ ...value, unlimited })} label="Sem limite superior" />
          {!value.unlimited && (
            <Field label="Percentual de overallocate" className="w-44">
              <Input value={value.pct} onChange={(e) => onChange({ ...value, pct: e.target.value })} />
            </Field>
          )}
        </div>
      )}
    </div>
  );
}

interface NodeFormValues {
  name: string;
  description: string;
  isPublic: boolean;
  maintenanceMode: boolean;
  memoryTotalMb: string;
  memoryReservedMb: string;
  memoryOverallocate: OverallocateValue;
  diskTotalMb: string;
  diskReservedMb: string;
  diskOverallocate: OverallocateValue;
  cpuTotalPercent: string;
  cpuReservedPercent: string;
  cpuOverallocate: OverallocateValue;
}

function nodeToForm(n: AdminNode): NodeFormValues {
  return {
    name: n.name,
    description: n.description ?? '',
    isPublic: n.isPublic,
    maintenanceMode: n.maintenanceMode,
    memoryTotalMb: String(n.memoryTotalMb),
    memoryReservedMb: String(n.memoryReservedMb),
    memoryOverallocate: pctToOverallocate(n.memoryOverallocatePct),
    diskTotalMb: String(n.diskTotalMb),
    diskReservedMb: String(n.diskReservedMb),
    diskOverallocate: pctToOverallocate(n.diskOverallocatePct),
    cpuTotalPercent: String(n.cpuTotalPercent),
    cpuReservedPercent: String(n.cpuReservedPercent),
    cpuOverallocate: pctToOverallocate(n.cpuOverallocatePct),
  };
}

function formToInput(v: NodeFormValues): UpdateNodeInput {
  return {
    name: v.name.trim(),
    description: v.description.trim() || undefined,
    isPublic: v.isPublic,
    maintenanceMode: v.maintenanceMode,
    memoryTotalMb: Number(v.memoryTotalMb) || 0,
    memoryReservedMb: Number(v.memoryReservedMb) || 0,
    memoryOverallocatePct: overallocateToPct(v.memoryOverallocate),
    diskTotalMb: Number(v.diskTotalMb) || 0,
    diskReservedMb: Number(v.diskReservedMb) || 0,
    diskOverallocatePct: overallocateToPct(v.diskOverallocate),
    cpuTotalPercent: Number(v.cpuTotalPercent) || 0,
    cpuReservedPercent: Number(v.cpuReservedPercent) || 0,
    cpuOverallocatePct: overallocateToPct(v.cpuOverallocate),
  };
}

function NodeEditModal({ node, onClose }: { node: AdminNode | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<NodeFormValues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (node) {
      setValues(nodeToForm(node));
      setError(null);
    }
  }, [node]);

  function patch(p: Partial<NodeFormValues>) {
    setValues((v) => (v ? { ...v, ...p } : v));
  }

  async function handleSave() {
    if (!node || !values) return;
    setSaving(true);
    setError(null);
    try {
      await updateNode(node.id, formToInput(values));
      void queryClient.invalidateQueries({ queryKey: ['admin', 'nodes'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'capacity'] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar o node.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={node !== null}
      onClose={onClose}
      title={node ? `Editar “${node.name}”` : ''}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" disabled={!values || saving} onClick={() => void handleSave()}>
            {saving ? 'Salvando…' : 'Salvar node'}
          </Button>
        </>
      }
    >
      {!values ? null : (
        <div className="space-y-6">
          {error && (
            <Alert className="mb-2" onDismiss={() => setError(null)}>
              {error}
            </Alert>
          )}

          <fieldset className="space-y-4">
            <legend className="text-xs font-semibold tracking-wide text-text-faint uppercase">Geral</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Nome" htmlFor="node-edit-name">
                <Input id="node-edit-name" value={values.name} onChange={(e) => patch({ name: e.target.value })} />
              </Field>
              <Field label="Descrição" htmlFor="node-edit-desc">
                <Input id="node-edit-desc" value={values.description} onChange={(e) => patch({ description: e.target.value })} />
              </Field>
            </div>
            <Toggle checked={values.isPublic} onChange={(isPublic) => patch({ isPublic })} label="Público" description="Visível como destino de novos servidores." />
            <Toggle
              checked={values.maintenanceMode}
              onChange={(maintenanceMode) => patch({ maintenanceMode })}
              label="Manutenção (impede novas alocações)"
              description="Servidores já existentes neste node continuam rodando normalmente — isto só bloqueia CRIAR ou TRANSFERIR novos servidores para cá."
            />
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold tracking-wide text-text-faint uppercase">Memória</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Total físico (MB)" htmlFor="node-edit-mem-total">
                <Input id="node-edit-mem-total" value={values.memoryTotalMb} onChange={(e) => patch({ memoryTotalMb: e.target.value })} />
              </Field>
              <Field label="Reservado (MB)" htmlFor="node-edit-mem-reserved" hint="Consumo do próprio host (Proxmox, outras VMs) — nunca vendido.">
                <Input id="node-edit-mem-reserved" value={values.memoryReservedMb} onChange={(e) => patch({ memoryReservedMb: e.target.value })} />
              </Field>
            </div>
            {node?.reportedMemoryTotalMb != null && Number(values.memoryTotalMb) > node?.reportedMemoryTotalMb && (
              <p className="text-xs text-warn">⚠️ Acima do detectado pelo agente ({node?.reportedMemoryTotalMb} MB).</p>
            )}
            <OverallocateControl value={values.memoryOverallocate} onChange={(memoryOverallocate) => patch({ memoryOverallocate })} />
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold tracking-wide text-text-faint uppercase">Disco</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Total físico (MB)" htmlFor="node-edit-disk-total">
                <Input id="node-edit-disk-total" value={values.diskTotalMb} onChange={(e) => patch({ diskTotalMb: e.target.value })} />
              </Field>
              <Field label="Reservado (MB)" htmlFor="node-edit-disk-reserved">
                <Input id="node-edit-disk-reserved" value={values.diskReservedMb} onChange={(e) => patch({ diskReservedMb: e.target.value })} />
              </Field>
            </div>
            {node?.reportedDiskTotalMb != null && Number(values.diskTotalMb) > node?.reportedDiskTotalMb && (
              <p className="text-xs text-warn">⚠️ Acima do detectado pelo agente ({node?.reportedDiskTotalMb} MB).</p>
            )}
            <OverallocateControl value={values.diskOverallocate} onChange={(diskOverallocate) => patch({ diskOverallocate })} />
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold tracking-wide text-text-faint uppercase">CPU</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Total (%)" htmlFor="node-edit-cpu-total" hint="0 = sem controle de CPU neste node (padrão). 100% = 1 core inteiro.">
                <Input id="node-edit-cpu-total" value={values.cpuTotalPercent} onChange={(e) => patch({ cpuTotalPercent: e.target.value })} />
              </Field>
              <Field label="Reservado (%)" htmlFor="node-edit-cpu-reserved">
                <Input id="node-edit-cpu-reserved" value={values.cpuReservedPercent} onChange={(e) => patch({ cpuReservedPercent: e.target.value })} />
              </Field>
            </div>
            {node?.reportedCpuCount != null && Number(values.cpuTotalPercent) / 100 > node?.reportedCpuCount && (
              <p className="text-xs text-warn">⚠️ Acima do detectado pelo agente ({node?.reportedCpuCount} vCPU).</p>
            )}
            <OverallocateControl value={values.cpuOverallocate} onChange={(cpuOverallocate) => patch({ cpuOverallocate })} />
          </fieldset>
        </div>
      )}
    </Modal>
  );
}

export function NodesPage() {
  const queryClient = useQueryClient();
  const { data: nodes, isLoading, isError } = useQuery({ queryKey: ['admin', 'nodes'], queryFn: listNodes });
  const { data: locations } = useQuery({ queryKey: ['admin', 'locations'], queryFn: listLocations });
  const { data: capacity } = useQuery({ queryKey: ['admin', 'capacity', 'dashboard'], queryFn: getCapacityDashboard });
  const capacityByNode = new Map((capacity?.perNode ?? []).map((n) => [n.id, n]));

  const [locationId, setLocationId] = useState('');
  const [name, setName] = useState('');
  const [fqdn, setFqdn] = useState('');
  const [scheme, setScheme] = useState<'http' | 'https'>('https');
  const [daemonPort, setDaemonPort] = useState('8443');
  const [memoryTotalMb, setMemoryTotalMb] = useState('8192');
  const [diskTotalMb, setDiskTotalMb] = useState('102400');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapTokenResponse | null>(null);
  const [rotateTarget, setRotateTarget] = useState<{ id: string; name: string } | null>(null);
  const [editTarget, setEditTarget] = useState<AdminNode | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleCreate() {
    if (!locationId || !name.trim() || !fqdn.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createNode({ locationId, name: name.trim(), fqdn: fqdn.trim(), scheme, daemonPort: Number(daemonPort), memoryTotalMb: Number(memoryTotalMb), diskTotalMb: Number(diskTotalMb) });
      setName('');
      setFqdn('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'nodes'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível criar o node.');
    } finally {
      setCreating(false);
    }
  }

  async function handleIssueBootstrap(nodeId: string) {
    setError(null);
    try {
      const res = await issueBootstrapToken(nodeId);
      setBootstrap(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível emitir o token de bootstrap.');
    }
  }

  async function handleConfirmRotate() {
    if (!rotateTarget) return;
    setError(null);
    try {
      const res = await rotateNodeToken(rotateTarget.id);
      setBootstrap(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível rotacionar o token.');
    } finally {
      setRotateTarget(null);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setDeleteError(null);
    try {
      await deleteNode(deleteTarget.id);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'nodes'] });
      setDeleteTarget(null);
    } catch (err) {
      // Left open (not cleared) on failure — the 409 "has servers" case is
      // exactly when the admin needs to keep seeing why it didn't work.
      setDeleteError(err instanceof ApiError ? err.message : 'Não foi possível remover o node.');
    }
  }

  return (
    <>
      <PageHeader title="Nodes" subtitle="Máquinas físicas ou virtuais que rodam o agente e hospedam servidores." />

      <Card className="mb-6">
        <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Location" htmlFor="node-location">
            <Select id="node-location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Selecione…</option>
              {locations?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.shortCode})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Nome" htmlFor="node-name">
            <Input id="node-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="node-01" />
          </Field>
          <Field label="FQDN" htmlFor="node-fqdn">
            <Input id="node-fqdn" value={fqdn} onChange={(e) => setFqdn(e.target.value)} placeholder="node01.exemplo.com" />
          </Field>
          <Field label="Esquema" htmlFor="node-scheme">
            <Select id="node-scheme" value={scheme} onChange={(e) => setScheme(e.target.value as 'http' | 'https')}>
              <option value="https">https</option>
              <option value="http">http</option>
            </Select>
          </Field>
          <Field label="Porta do daemon" htmlFor="node-port">
            <Input id="node-port" value={daemonPort} onChange={(e) => setDaemonPort(e.target.value)} />
          </Field>
          <Field label="Memória total (MB)" htmlFor="node-mem">
            <Input id="node-mem" value={memoryTotalMb} onChange={(e) => setMemoryTotalMb(e.target.value)} />
          </Field>
          <Field label="Disco total (MB)" htmlFor="node-disk" className="sm:col-span-2">
            <Input id="node-disk" value={diskTotalMb} onChange={(e) => setDiskTotalMb(e.target.value)} />
          </Field>
          <div className="flex items-end sm:col-span-1">
            <Button variant="primary" disabled={creating || !locationId || !name.trim() || !fqdn.trim()} onClick={() => void handleCreate()} className="w-full">
              {creating ? 'Criando…' : 'Criar node'}
            </Button>
          </div>
        </CardBody>
      </Card>

      {error && <Alert className="mb-6">{error}</Alert>}
      {isError && <Alert className="mb-6">Não foi possível carregar os nodes.</Alert>}

      {bootstrap && (
        <Alert tone="ok" title="Anote agora — não será exibido novamente" className="mb-6">
          <p className="mt-1 mb-2">Rode isto no node (expira em {new Date(bootstrap.expiresAt).toLocaleString('pt-BR')}):</p>
          <code className="block overflow-x-auto rounded-lg bg-surface px-3 py-2 font-mono text-xs whitespace-pre text-text">
            pxagent bootstrap --panel {'<panel-url>'} --token {bootstrap.token}
          </code>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => setBootstrap(null)}>
            Ok, anotei
          </Button>
        </Alert>
      )}

      {isLoading ? (
        <LoadingRow />
      ) : !nodes || nodes.length === 0 ? (
        <EmptyState icon={HardDrive} title="Nenhum node ainda" description="Cadastre o primeiro acima." />
      ) : (
        <div className="space-y-3">
          {nodes.map((n) => (
            <Card key={n.id}>
              <CardBody>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-text">{n.name}</p>
                      <Badge tone={HEALTH_TONE[n.healthStatus] ?? 'neutral'}>{HEALTH_LABELS[n.healthStatus] ?? n.healthStatus}</Badge>
                      {n.maintenanceMode && <Badge tone="warn">Manutenção</Badge>}
                      {!n.isPublic && <Badge tone="neutral">Privado</Badge>}
                      {Object.values(n.telemetryDivergence).includes('over') && (
                        <Badge tone="fail">Declarado acima do reportado</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 font-mono text-xs text-text-faint">
                      {n.scheme}://{n.fqdn}:{n.daemonPort}
                    </p>
                    {n.reportedAt && (
                      <p className="mt-0.5 text-xs text-text-faint">
                        Agente reporta: {n.reportedMemoryTotalMb ?? '—'} MB RAM · {n.reportedCpuCount ?? '—'} vCPU · {n.reportedDiskFreeMb ?? '—'} MB disco livre
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Link to="/admin/nodes/$nodeId" params={{ nodeId: n.id }}>
                      <Button variant="ghost" size="sm">
                        Detalhes
                      </Button>
                    </Link>
                    <Button variant="ghost" size="sm" onClick={() => setEditTarget(n)}>
                      <Pencil className="h-4 w-4" aria-hidden="true" />
                      Editar
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => void handleIssueBootstrap(n.id)}>
                      Emitir bootstrap token
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => setRotateTarget({ id: n.id, name: n.name })}>
                      Rotar token
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setExpanded(expanded === n.id ? null : n.id)}>
                      <ListCollapse className="h-4 w-4" aria-hidden="true" />
                      {expanded === n.id ? 'Ocultar alocações' : 'Alocações'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleteTarget({ id: n.id, name: n.name })}>
                      <Trash2 className="h-4 w-4 text-fail" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                <NodeCapacityMeters snapshot={capacityByNode.get(n.id)} />
                {expanded === n.id && <NodeAllocations nodeId={n.id} />}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={rotateTarget !== null}
        title="Rotar token do node"
        message={`Revogar o token atual de "${rotateTarget?.name}" agora? O node ficará offline até ser re-bootstrapped com o novo token.`}
        confirmLabel="Rotar token"
        tone="danger"
        onConfirm={() => void handleConfirmRotate()}
        onCancel={() => setRotateTarget(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Remover node"
        message={
          deleteError ?? `Remover "${deleteTarget?.name}" permanentemente? Só é possível se ele não tiver nenhum servidor (ativo ou não).`
        }
        confirmLabel="Remover"
        tone="danger"
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteError(null);
        }}
      />

      <NodeEditModal node={editTarget} onClose={() => setEditTarget(null)} />
    </>
  );
}
