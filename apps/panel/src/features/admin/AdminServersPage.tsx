import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { History, Plus, ServerCog } from 'lucide-react';
import {
  createAdminServer,
  initiateTransfer,
  listAdminServers,
  listNodes,
  listPlans,
  listTemplates,
  listUsers,
  listTransfers,
  simulateCapacity,
  suspendServer,
  unsuspendServer,
} from './admin.api';
import { ApiError } from '@/shared/api/client';
import type { CapacitySimulateResult } from '@/shared/api/types';
import {
  Alert,
  Button,
  Card,
  CardBody,
  EmptyState,
  Field,
  Input,
  LoadingRow,
  Modal,
  PageHeader,
  PromptDialog,
  Select,
  StatusBadge,
} from '@/ui/primitives';

const STATUS_LABELS: Record<string, string> = {
  installing: 'Instalando',
  install_failed: 'Falha na instalação',
  ready: 'Pronto',
  suspended: 'Suspenso',
  restoring_backup: 'Restaurando backup',
  transferring: 'Transferindo',
  deleting: 'Excluindo',
};

function TransferHistory({ serverId }: { serverId: string }) {
  const { data: transfers } = useQuery({
    queryKey: ['admin', 'transfers', serverId],
    queryFn: () => listTransfers(serverId),
    refetchInterval: 3000, // live progress through pending -> archiving -> uploading -> restoring -> success/failed
  });
  if (!transfers || transfers.length === 0) return null;
  return (
    <div className="mt-3 space-y-1 rounded-lg bg-surface-2 p-3">
      <p className="mb-1 text-xs font-medium text-text-faint uppercase">Transferências</p>
      {transfers.map((t) => (
        <div key={t.id} className="font-mono text-xs text-text-muted">
          {new Date(t.createdAt).toLocaleString('pt-BR')} · <span className="text-text">{t.status}</span>
          {t.errorMessage && <span className="text-fail"> — {t.errorMessage}</span>}
        </div>
      ))}
    </div>
  );
}

// ---- create server (capacity plan Fase 5) ----

const AUTO_NODE = ''; // Select's "automatic" option value — maps to `nodeId: undefined` in the request

function SimulatePreview({ result, loading }: { result: CapacitySimulateResult | null; loading: boolean }) {
  if (loading) return <p className="text-xs text-text-faint">Calculando…</p>;
  if (!result) return null;
  if (result.results.length === 0) return <p className="text-xs text-text-faint">Nenhum node elegível para este plano.</p>;
  return (
    <div className="space-y-1.5 rounded-lg bg-surface-2 p-3">
      <p className="text-xs font-semibold tracking-wide text-text-faint uppercase">Prévia de capacidade</p>
      {result.results.map((r) => (
        <div key={r.nodeId} className="flex items-start justify-between gap-3 text-xs">
          <span className={r.fits ? 'text-text' : 'text-text-faint'}>{r.name}</span>
          {r.fits ? (
            <span className="text-ok">cabe</span>
          ) : (
            <span className="text-right text-fail">{r.reasons.join('; ') || 'não cabe'}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function CreateServerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data: templates } = useQuery({ queryKey: ['admin', 'templates'], queryFn: () => listTemplates() });
  const { data: plans } = useQuery({ queryKey: ['admin', 'plans'], queryFn: listPlans });
  const { data: nodes } = useQuery({ queryKey: ['admin', 'nodes'], queryFn: listNodes });

  const [ownerQuery, setOwnerQuery] = useState('');
  const { data: ownerResults } = useQuery({
    queryKey: ['admin', 'users', { q: ownerQuery, limit: 20 }],
    queryFn: () => listUsers({ q: ownerQuery || undefined, limit: 20 }),
  });

  const [ownerId, setOwnerId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [planId, setPlanId] = useState('');
  const [nodeId, setNodeId] = useState(AUTO_NODE);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [preview, setPreview] = useState<CapacitySimulateResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setOwnerId('');
    setOwnerQuery('');
    setTemplateId('');
    setPlanId('');
    setNodeId(AUTO_NODE);
    setName('');
    setError(null);
    setPreview(null);
  }, [open]);

  // Live preview (capacity plan Fase 5's "prévia ao vivo") — debounced,
  // never blocks the actual create: `simulateCapacity` is a pure read
  // that never reserves anything (see the backend's own doc comment on
  // `nodeFitReasons`), so a stale preview is at worst momentarily wrong,
  // never a source of double-booking.
  useEffect(() => {
    if (!open || !planId) {
      setPreview(null);
      return;
    }
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      simulateCapacity({ planId, nodeId: nodeId || undefined })
        .then((r) => setPreview(r))
        .catch(() => setPreview(null))
        .finally(() => setPreviewLoading(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [open, planId, nodeId]);

  const canSubmit = ownerId && templateId && planId && name.trim();

  async function handleCreate() {
    if (!canSubmit) return;
    setCreating(true);
    setError(null);
    try {
      await createAdminServer({
        ownerId,
        templateId,
        planId,
        name: name.trim(),
        nodeId: nodeId || undefined,
      });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'servers'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'capacity'] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível criar o servidor.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Novo servidor"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" disabled={!canSubmit || creating} onClick={() => void handleCreate()}>
            {creating ? 'Criando…' : 'Criar servidor'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <Alert onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Field label="Nome" htmlFor="cs-name" required>
          <Input id="cs-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Servidor do cliente" />
        </Field>

        <Field label="Cliente" htmlFor="cs-owner" required hint="Digite para buscar por nome ou e-mail.">
          <Input id="cs-owner-search" value={ownerQuery} onChange={(e) => setOwnerQuery(e.target.value)} placeholder="Buscar cliente…" className="mb-1.5" />
          <Select id="cs-owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">Selecione…</option>
            {ownerResults?.items.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username} ({u.email})
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Template" htmlFor="cs-template" required>
            <Select id="cs-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Selecione…</option>
              {templates?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Plano" htmlFor="cs-plan" required>
            <Select id="cs-plan" value={planId} onChange={(e) => setPlanId(e.target.value)}>
              <option value="">Selecione…</option>
              {plans?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.memoryMb} MB)
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Node" htmlFor="cs-node" hint="Automático escolhe o node com mais folga usando o scheduler.">
          <Select id="cs-node" value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
            <option value={AUTO_NODE}>Automático ▾</option>
            {nodes?.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </Select>
        </Field>

        {planId && <SimulatePreview result={preview} loading={previewLoading} />}
      </div>
    </Modal>
  );
}

export function AdminServersPage() {
  const queryClient = useQueryClient();
  const { data: servers, isLoading, isError } = useQuery({ queryKey: ['admin', 'servers'], queryFn: () => listAdminServers() });
  const { data: nodes } = useQuery({ queryKey: ['admin', 'nodes'], queryFn: listNodes });

  const [targetByServer, setTargetByServer] = useState<Record<string, string>>({});
  const [busyServer, setBusyServer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [suspendTarget, setSuspendTarget] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  async function handleTransfer(serverId: string) {
    const targetNodeId = targetByServer[serverId];
    if (!targetNodeId) return;
    setBusyServer(serverId);
    setError(null);
    try {
      await initiateTransfer(serverId, { targetNodeId });
      setExpanded(serverId);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'servers'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'transfers', serverId] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível iniciar a transferência.');
    } finally {
      setBusyServer(null);
    }
  }

  async function handleConfirmSuspend(reason: string) {
    if (!suspendTarget) return;
    setBusyServer(suspendTarget);
    setError(null);
    try {
      await suspendServer(suspendTarget, reason);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'servers'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível suspender o servidor.');
    } finally {
      setBusyServer(null);
      setSuspendTarget(null);
    }
  }

  async function handleUnsuspend(serverId: string) {
    setBusyServer(serverId);
    setError(null);
    try {
      await unsuspendServer(serverId);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'servers'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível reativar o servidor.');
    } finally {
      setBusyServer(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Todos os servidores"
        subtitle="Transferência de servidores entre nodes ao vivo, sem perda de dados, e suspensão administrativa."
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Novo servidor
          </Button>
        }
      />

      {error && <Alert className="mb-6">{error}</Alert>}
      {isError && <Alert className="mb-6">Não foi possível carregar os servidores.</Alert>}

      {isLoading ? (
        <LoadingRow />
      ) : !servers || servers.length === 0 ? (
        <EmptyState icon={ServerCog} title="Nenhum servidor ainda" />
      ) : (
        <div className="space-y-3">
          {servers.map((s) => {
            const otherNodes = nodes?.filter((n) => n.id !== s.node.id) ?? [];
            const canTransfer = s.status === 'ready';
            return (
              <Card key={s.id}>
                <CardBody className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Link
                        to="/admin/servers/$serverId"
                        params={{ serverId: s.id }}
                        className="font-medium text-text hover:text-accent-strong hover:underline"
                      >
                        {s.name}
                      </Link>
                      <StatusBadge status={s.status} />
                    </div>
                    <p className="mt-0.5 font-mono text-xs text-text-faint">
                      {s.shortId} · node: {s.node.name} · {STATUS_LABELS[s.status] ?? s.status}
                    </p>
                    <p className="text-xs text-text-faint">Cliente: {s.owner ? `${s.owner.username} (${s.owner.email})` : '—'}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="w-44">
                      <Select
                        value={targetByServer[s.id] ?? ''}
                        onChange={(e) => setTargetByServer((prev) => ({ ...prev, [s.id]: e.target.value }))}
                        disabled={!canTransfer}
                        aria-label="Node de destino"
                      >
                        <option value="">Node de destino…</option>
                        {otherNodes.map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!canTransfer || !targetByServer[s.id] || busyServer === s.id}
                      onClick={() => void handleTransfer(s.id)}
                    >
                      {busyServer === s.id ? 'Iniciando…' : 'Transferir'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                      <History className="h-4 w-4" aria-hidden="true" />
                      Histórico
                    </Button>
                    {s.status === 'suspended' ? (
                      <Button variant="secondary" size="sm" disabled={busyServer === s.id} onClick={() => void handleUnsuspend(s.id)}>
                        Reativar
                      </Button>
                    ) : (
                      <Button variant="danger" size="sm" disabled={busyServer === s.id} onClick={() => setSuspendTarget(s.id)}>
                        Suspender
                      </Button>
                    )}
                  </div>
                  {expanded === s.id && (
                    <div className="w-full">
                      <TransferHistory serverId={s.id} />
                    </div>
                  )}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      <PromptDialog
        open={suspendTarget !== null}
        title="Suspender servidor"
        label="Motivo da suspensão"
        confirmLabel="Suspender"
        loading={busyServer === suspendTarget}
        onSubmit={(reason) => void handleConfirmSuspend(reason)}
        onCancel={() => setSuspendTarget(null)}
      />

      <CreateServerModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}
