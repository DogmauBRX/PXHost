import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { History, ServerCog } from 'lucide-react';
import { initiateTransfer, listAdminServers, listNodes, listTransfers, suspendServer, unsuspendServer } from './admin.api';
import { ApiError } from '@/shared/api/client';
import {
  Alert,
  Button,
  Card,
  CardBody,
  EmptyState,
  LoadingRow,
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

export function AdminServersPage() {
  const queryClient = useQueryClient();
  const { data: servers, isLoading, isError } = useQuery({ queryKey: ['admin', 'servers'], queryFn: () => listAdminServers() });
  const { data: nodes } = useQuery({ queryKey: ['admin', 'nodes'], queryFn: listNodes });

  const [targetByServer, setTargetByServer] = useState<Record<string, string>>({});
  const [busyServer, setBusyServer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [suspendTarget, setSuspendTarget] = useState<string | null>(null);

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
      <PageHeader title="Todos os servidores" subtitle="Transferência de servidores entre nodes ao vivo, sem perda de dados, e suspensão administrativa." />

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
    </>
  );
}
