import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { listServerVariables, updateServerVariables } from './variables.api';
import { getServer, getServerStats } from '@/features/servers/servers.api';
import { ApiError } from '@/shared/api/client';
import { Alert, Button, Field, Input, LoadingRow, PageHeader } from '@/ui/primitives';

// Anything other than a null/offline live state still means a real
// container exists — starting/stopping/crashed all count as "not safely
// editable," not just "running." This is the UX gate only: the agent's
// own UpdateVariables refuses the recreate authoritatively regardless of
// what this snapshot (or the DB's stale powerState) says.
function isLive(state: string | null): boolean {
  return state !== null && state !== 'offline';
}

export function VariablesPage({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const { data: server } = useQuery({ queryKey: ['server', serverId], queryFn: () => getServer(serverId) });
  const { data: stats } = useQuery({ queryKey: ['server', 'stats', serverId], queryFn: () => getServerStats(serverId), refetchInterval: 15_000 });
  const { data: variables, isLoading, isError } = useQuery({ queryKey: ['server-variables', serverId], queryFn: () => listServerVariables(serverId) });

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canEdit = server?.permissions.includes('startup.update') ?? false;
  const running = isLive(stats?.state ?? null);

  const mutation = useMutation({
    mutationFn: (values: Record<string, string>) => updateServerVariables(serverId, values),
    onSuccess: () => {
      setDrafts({});
      setError(null);
      setNotice('Configurações salvas — o servidor foi recriado com os novos valores. Inicie-o quando quiser.');
      void queryClient.invalidateQueries({ queryKey: ['server-variables', serverId] });
    },
    onError: (err) => {
      setNotice(null);
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar as alterações.');
    },
  });

  function handleChange(envVariable: string, value: string) {
    setDrafts((d) => ({ ...d, [envVariable]: value }));
    setNotice(null);
  }

  function handleSave() {
    if (Object.keys(drafts).length === 0) return;
    setError(null);
    mutation.mutate(drafts);
  }

  if (isLoading) return <LoadingRow />;
  if (isError) return <Alert>Não foi possível carregar as configurações.</Alert>;

  const hasDrafts = Object.keys(drafts).length > 0;

  return (
    <>
      <PageHeader
        title="Configurações"
        actions={
          canEdit ? (
            <Button variant="primary" disabled={!hasDrafts || running || mutation.isPending} onClick={handleSave}>
              <Save className="h-4 w-4" aria-hidden="true" />
              {mutation.isPending ? 'Salvando…' : 'Salvar alterações'}
            </Button>
          ) : undefined
        }
      >
        <p className="mt-1 text-sm text-text-muted">Variáveis de inicialização do servidor. Alterar um valor exige que o servidor esteja parado.</p>
      </PageHeader>

      {running && canEdit && (
        <Alert tone="warn" className="mb-4">
          Pare o servidor para editar estas configurações — salvar recria o container com os novos valores.
        </Alert>
      )}
      {notice && (
        <Alert tone="ok" className="mb-4" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {error && (
        <Alert className="mb-4" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {!variables || variables.length === 0 ? (
        <p className="text-sm text-text-muted">Este servidor não tem variáveis configuráveis.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {variables.map((v) => (
            <Field key={v.id} label={v.name} htmlFor={`var-${v.id}`} hint={v.description ?? undefined}>
              <Input
                id={`var-${v.id}`}
                value={drafts[v.envVariable] ?? v.value}
                disabled={!canEdit || !v.isEditable || running}
                onChange={(e) => handleChange(v.envVariable, e.target.value)}
              />
            </Field>
          ))}
        </div>
      )}
    </>
  );
}
