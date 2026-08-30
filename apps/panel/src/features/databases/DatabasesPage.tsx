import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createDatabase, deleteDatabase, listDatabases } from './databases.api';
import { Button } from '@/ui/primitives/Button';
import { ApiError } from '@/shared/api/client';
import type { CreatedDatabase } from '@/shared/api/types';

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

  async function handleDelete(id: string) {
    if (!window.confirm('Excluir este banco de dados? O schema e o usuário reais serão removidos do host — esta ação não pode ser desfeita.')) return;
    setError(null);
    try {
      await deleteDatabase(serverId, id);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível excluir o banco de dados.');
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="font-medium text-text">Bancos de dados</h1>
        <div className="flex items-center gap-2">
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder="nome (opcional)"
            className="w-40 rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-text outline-none focus:border-accent"
          />
          <Button variant="primary" disabled={creating} onClick={() => void handleCreate()}>
            {creating ? 'Criando…' : 'Criar banco de dados'}
          </Button>
        </div>
      </div>

      {error && <p className="rounded-md bg-fail-tint px-3 py-2 text-sm text-fail">{error}</p>}

      {revealed && (
        <div className="rounded-lg border border-accent/30 bg-accent-tint p-4">
          <p className="mb-2 text-sm text-text">
            Anote a senha agora — ela não será exibida novamente.
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-sm">
            <dt className="text-text-muted">Host</dt>
            <dd className="text-text">{revealed.host.host}:{revealed.host.port}</dd>
            <dt className="text-text-muted">Database</dt>
            <dd className="text-text">{revealed.database}</dd>
            <dt className="text-text-muted">Usuário</dt>
            <dd className="text-text">{revealed.username}</dd>
            <dt className="text-text-muted">Senha</dt>
            <dd className="text-text">{revealed.password}</dd>
          </dl>
          <div className="mt-3">
            <Button variant="secondary" onClick={() => setRevealed(null)}>
              Ok, anotei
            </Button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-surface">
        {isLoading && <p className="p-4 text-sm text-text-muted">Carregando…</p>}
        {isError && <p className="p-4 text-sm text-fail">Não foi possível carregar os bancos de dados.</p>}
        {databases && databases.length === 0 && <p className="p-4 text-sm text-text-muted">Nenhum banco de dados ainda.</p>}
        {databases && databases.length > 0 && (
          <table className="w-full text-sm">
            <tbody>
              {databases.map((db) => (
                <tr key={db.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                  <td className="px-4 py-2">
                    <p className="font-mono text-text">{db.database}</p>
                    <p className="text-xs text-text-faint">
                      {db.host.host}:{db.host.port} · {db.username}@{db.remote} · {formatDate(db.createdAt)}
                    </p>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" onClick={() => void handleDelete(db.id)}>
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
