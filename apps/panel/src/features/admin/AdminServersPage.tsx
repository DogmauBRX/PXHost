import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { initiateTransfer, listAdminServers, listNodes, listTransfers, suspendServer, unsuspendServer } from './admin.api';
import { Button } from '@/ui/primitives/Button';
import { ApiError } from '@/shared/api/client';

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
    <div className="mt-2 space-y-1 rounded-md bg-surface-2 p-3">
      <p className="mb-1 text-xs font-medium uppercase text-text-faint">Transferências</p>
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

  async function handleSuspend(serverId: string) {
    const reason = prompt('Motivo da suspensão:');
    if (!reason) return;
    setBusyServer(serverId);
    setError(null);
    try {
      await suspendServer(serverId, reason);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'servers'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível suspender o servidor.');
    } finally {
      setBusyServer(null);
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
    <div className="flex h-full flex-col gap-4">
      <h1 className="font-medium text-text">Servers</h1>
      <p className="text-sm text-text-muted">Transferência de servidores entre nodes ao vivo (roadmap M13) — sem perda de dados.</p>

      {error && <p className="rounded-md bg-fail-tint px-3 py-2 text-sm text-fail">{error}</p>}

      <div className="min-h-0 flex-1 space-y-3 overflow-auto">
        {isLoading && <p className="text-sm text-text-muted">Carregando…</p>}
        {isError && <p className="text-sm text-fail">Não foi possível carregar os servidores.</p>}
        {servers && servers.length === 0 && <p className="text-sm text-text-muted">Nenhum servidor ainda.</p>}
        {servers?.map((s) => {
          const otherNodes = nodes?.filter((n) => n.id !== s.node.id) ?? [];
          const canTransfer = s.status === 'ready';
          return (
            <div key={s.id} className="rounded-lg border border-border bg-surface p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-text">{s.name}</p>
                  <p className="font-mono text-xs text-text-faint">
                    {s.shortId} · node: {s.node.name} · {STATUS_LABELS[s.status] ?? s.status}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={targetByServer[s.id] ?? ''}
                    onChange={(e) => setTargetByServer((prev) => ({ ...prev, [s.id]: e.target.value }))}
                    disabled={!canTransfer}
                    className="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-xs text-text outline-none focus:border-accent disabled:opacity-50"
                  >
                    <option value="">Node de destino…</option>
                    {otherNodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="secondary"
                    disabled={!canTransfer || !targetByServer[s.id] || busyServer === s.id}
                    onClick={() => void handleTransfer(s.id)}
                  >
                    {busyServer === s.id ? 'Iniciando…' : 'Transferir'}
                  </Button>
                  <Button variant="ghost" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                    Histórico
                  </Button>
                  {s.status === 'suspended' ? (
                    <Button variant="secondary" disabled={busyServer === s.id} onClick={() => void handleUnsuspend(s.id)}>
                      Reativar
                    </Button>
                  ) : (
                    <Button variant="danger" disabled={busyServer === s.id} onClick={() => void handleSuspend(s.id)}>
                      Suspender
                    </Button>
                  )}
                </div>
              </div>
              {expanded === s.id && <TransferHistory serverId={s.id} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
