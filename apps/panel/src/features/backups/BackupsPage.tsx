import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive } from 'lucide-react';
import { createBackup, deleteBackup, listBackups, mintBackupDownloadLink, restoreBackup } from './backups.api';
import { ApiError } from '@/shared/api/client';
import {
  Alert,
  Button,
  ConfirmDialog,
  EmptyState,
  LoadingRow,
  PageHeader,
  TBody,
  TD,
  TR,
  Table,
  TableWrap,
} from '@/ui/primitives';

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
  const [restoring, setRestoring] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

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

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setError(null);
    try {
      await deleteBackup(serverId, deleteTarget);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível excluir o backup.');
    } finally {
      setDeleteTarget(null);
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
    if (!restoreTarget) return;
    setRestoring(true);
    setError(null);
    try {
      await restoreBackup(serverId, restoreTarget);
      setRestoreTarget(null);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? 'O servidor precisa estar parado antes de restaurar um backup.'
          : err instanceof ApiError
            ? err.message
            : 'Não foi possível restaurar o backup.',
      );
    } finally {
      setRestoring(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Backups"
        subtitle="Snapshots dos arquivos deste servidor."
        actions={
          <Button variant="primary" disabled={creating} onClick={() => void handleCreate()}>
            {creating ? 'Criando…' : 'Criar backup'}
          </Button>
        }
      />

      {error && <Alert className="mb-6">{error}</Alert>}
      {isError && <Alert className="mb-6">Não foi possível carregar os backups.</Alert>}

      {isLoading ? (
        <LoadingRow />
      ) : !backups || backups.length === 0 ? (
        <EmptyState icon={Archive} title="Nenhum backup ainda" description="Crie o primeiro acima." />
      ) : (
        <TableWrap>
          <Table>
            <TBody>
              {backups.map((b) => (
                <TR key={b.id}>
                  <TD>
                    <p className="font-mono text-text">{b.id}</p>
                    <p className="text-xs text-text-faint">{formatDate(b.createdAt)}</p>
                  </TD>
                  <TD className="text-right font-mono text-xs text-text-faint">{formatBytes(b.sizeBytes)}</TD>
                  <TD>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => void handleDownload(b.id)}>
                        Baixar
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setRestoreTarget(b.id)}>
                        Restaurar
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(b.id)}>
                        Excluir
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      )}

      <ConfirmDialog
        open={restoreTarget !== null}
        title="Restaurar backup"
        message="Restaurar este backup substitui TODOS os arquivos atuais do servidor."
        confirmLabel="Restaurar"
        tone="danger"
        loading={restoring}
        confirmPhrase={CONFIRM_WORD}
        onConfirm={() => void handleConfirmRestore()}
        onCancel={() => setRestoreTarget(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Excluir backup"
        message="Esta ação não pode ser desfeita."
        confirmLabel="Excluir"
        tone="danger"
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}
