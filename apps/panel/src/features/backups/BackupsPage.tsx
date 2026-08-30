import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createBackup, deleteBackup, listBackups, mintBackupDownloadLink, restoreBackup } from './backups.api';
import { Button } from '@/ui/primitives/Button';
import { ApiError } from '@/shared/api/client';

const CONFIRM_WORD = 'RESTAURAR';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR');
}

export function BackupsPage({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const { data: backups, isLoading, isError } = useQuery({ queryKey: ['backups', serverId], queryFn: () => listBackups(serverId) });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['backups', serverId] });
  }

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      await createBackup(serverId);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível criar o backup.');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Excluir este backup? Esta ação não pode ser desfeita.')) return;
    setError(null);
    try {
      await deleteBackup(serverId, id);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível excluir o backup.');
    }
  }

  async function handleDownload(id: string) {
    setError(null);
    try {
      const link = await mintBackupDownloadLink(serverId, id);
      const a = document.createElement('a');
      a.href = link.url;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível gerar o link de download.');
    }
  }

  async function handleConfirmRestore() {
    if (!restoreTarget || confirmText !== CONFIRM_WORD) return;
    setError(null);
    try {
      await restoreBackup(serverId, restoreTarget);
      setRestoreTarget(null);
      setConfirmText('');
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? 'O servidor precisa estar parado antes de restaurar um backup.'
          : err instanceof ApiError
            ? err.message
            : 'Não foi possível restaurar o backup.',
      );
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="font-medium text-text">Backups</h1>
        <Button variant="primary" disabled={creating} onClick={() => void handleCreate()}>
          {creating ? 'Criando…' : 'Criar backup'}
        </Button>
      </div>

      {error && <p className="rounded-md bg-fail-tint px-3 py-2 text-sm text-fail">{error}</p>}

      {restoreTarget && (
        <div className="rounded-lg border border-fail/30 bg-fail-tint p-4">
          <p className="mb-2 text-sm text-fail">
            Restaurar este backup substitui TODOS os arquivos atuais do servidor. Digite <strong>{CONFIRM_WORD}</strong> para
            confirmar.
          </p>
          <div className="flex gap-2">
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={CONFIRM_WORD}
              className="flex-1 rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-text outline-none focus:border-accent"
            />
            <Button variant="danger" disabled={confirmText !== CONFIRM_WORD} onClick={() => void handleConfirmRestore()}>
              Restaurar
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setRestoreTarget(null);
                setConfirmText('');
              }}
            >
              Cancelar
            </Button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-surface">
        {isLoading && <p className="p-4 text-sm text-text-muted">Carregando…</p>}
        {isError && <p className="p-4 text-sm text-fail">Não foi possível carregar os backups.</p>}
        {backups && backups.length === 0 && <p className="p-4 text-sm text-text-muted">Nenhum backup ainda.</p>}
        {backups && backups.length > 0 && (
          <table className="w-full text-sm">
            <tbody>
              {backups.map((b) => (
                <tr key={b.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                  <td className="px-4 py-2">
                    <p className="font-mono text-text">{b.id}</p>
                    <p className="text-xs text-text-faint">{formatDate(b.createdAt)}</p>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-text-faint">{formatBytes(b.sizeBytes)}</td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" onClick={() => void handleDownload(b.id)}>
                        Baixar
                      </Button>
                      <Button variant="secondary" onClick={() => setRestoreTarget(b.id)}>
                        Restaurar
                      </Button>
                      <Button variant="ghost" onClick={() => void handleDelete(b.id)}>
                        Excluir
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
