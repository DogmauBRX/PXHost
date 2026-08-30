import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Database } from 'lucide-react';
import { createDatabase, deleteDatabase, listDatabases } from './databases.api';
import { ApiError } from '@/shared/api/client';
import type { CreatedDatabase } from '@/shared/api/types';
import {
  Alert,
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  LoadingRow,
  PageHeader,
  TBody,
  TD,
  TR,
  Table,
  TableWrap,
} from '@/ui/primitives';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR');
}

export function DatabasesPage({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const { data: databases, isLoading, isError } = useQuery({ queryKey: ['databases', serverId], queryFn: () => listDatabases(serverId) });
  const [creating, setCreating] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<CreatedDatabase | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['databases', serverId] });
  }

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const created = await createDatabase(serverId, nameInput.trim() || undefined);
      setNameInput('');
      setRevealed(created);
      refresh();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? 'Limite de bancos de dados do plano atingido.'
          : err instanceof ApiError
            ? err.message
            : 'Não foi possível criar o banco de dados.',
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setError(null);
    try {
      await deleteDatabase(serverId, deleteTarget);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível excluir o banco de dados.');
    } finally {
      setDeleteTarget(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Bancos de dados"
        subtitle="Bancos MySQL provisionados para este servidor."
        actions={
          <div className="flex items-center gap-2">
            <Input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="nome (opcional)"
              className="w-40 font-mono"
            />
            <Button variant="primary" disabled={creating} onClick={() => void handleCreate()}>
              {creating ? 'Criando…' : 'Criar banco de dados'}
            </Button>
          </div>
        }
      />

      {error && <Alert className="mb-6">{error}</Alert>}
      {isError && <Alert className="mb-6">Não foi possível carregar os bancos de dados.</Alert>}

      {revealed && (
        <Alert tone="ok" title="Anote a senha agora — ela não será exibida novamente." className="mb-6">
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-sm">
            <dt className="text-text-muted">Host</dt>
            <dd className="text-text">
              {revealed.host.host}:{revealed.host.port}
            </dd>
            <dt className="text-text-muted">Database</dt>
            <dd className="text-text">{revealed.database}</dd>
            <dt className="text-text-muted">Usuário</dt>
            <dd className="text-text">{revealed.username}</dd>
            <dt className="text-text-muted">Senha</dt>
            <dd className="text-text">{revealed.password}</dd>
          </dl>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => setRevealed(null)}>
            Ok, anotei
          </Button>
        </Alert>
      )}

      {isLoading ? (
        <LoadingRow />
      ) : !databases || databases.length === 0 ? (
        <EmptyState icon={Database} title="Nenhum banco de dados ainda" description="Crie o primeiro acima." />
      ) : (
        <TableWrap>
          <Table>
            <TBody>
              {databases.map((db) => (
                <TR key={db.id}>
                  <TD>
                    <p className="font-mono text-text">{db.database}</p>
                    <p className="text-xs text-text-faint">
                      {db.host.host}:{db.host.port} · {db.username}@{db.remote} · {formatDate(db.createdAt)}
                    </p>
                  </TD>
                  <TD>
                    <div className="flex justify-end">
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(db.id)}>
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
        open={deleteTarget !== null}
        title="Excluir banco de dados"
        message="O schema e o usuário reais serão removidos do host — esta ação não pode ser desfeita."
        confirmLabel="Excluir"
        tone="danger"
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}
