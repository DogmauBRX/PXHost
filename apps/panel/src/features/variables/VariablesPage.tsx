import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { listServerVariables, updateServerVariables } from './variables.api';
import { updateServerHostname } from './hostname.api';
import { getServer, getServerStats } from '@/features/servers/servers.api';
import { ApiError } from '@/shared/api/client';
import { Alert, Button, Field, Input, LoadingRow, PageHeader } from '@/ui/primitives';

// Custom-hostname plan — kept separate from the zone the server actually
// resolves under, which the panel never needs to know (the API composes
// the full address; the panel only shows the LABEL input and echoes back
// whatever `server.publicAddress` already says).
function HostnameSettings({ serverId, canEdit }: { serverId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { data: server } = useQuery({ queryKey: ['server', serverId], queryFn: () => getServer(serverId) });

  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (hostname: string | null) => updateServerHostname(serverId, hostname),
    onSuccess: () => {
      setDraft(null);
      setError(null);
      setNotice('Endereço salvo — pode levar até 1 minuto para o DNS propagar.');
      void queryClient.invalidateQueries({ queryKey: ['server', serverId] });
    },
    onError: (err) => {
      setNotice(null);
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar o endereço.');
    },
  });

  if (!server) return null;

  const value = draft ?? server.customHostname ?? '';
  const hasChanges = draft !== null && draft !== (server.customHostname ?? '');

  return (
    <div className="mb-6 flex flex-col gap-3 rounded-card border border-border bg-surface p-5">
      <div>
        <h2 className="font-semibold text-text">Endereço personalizado</h2>
        <p className="mt-1 text-sm text-text-muted">
          Escolha um subdomínio para conectar sem precisar informar IP ou porta — ex.: <span className="font-mono">survival</span>.
        </p>
      </div>

      {notice && (
        <Alert tone="ok" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}

      {server.publicAddress && (
        <p className="text-sm text-text-muted">
          Endereço do servidor: <span className="font-mono font-medium text-text">{server.publicAddress}</span>
        </p>
      )}

      {canEdit && (
        <div className="flex items-end gap-3">
          <Field label="Subdomínio" htmlFor="custom-hostname" className="flex-1">
            <Input
              id="custom-hostname"
              placeholder="survival"
              value={value}
              disabled={mutation.isPending}
              onChange={(e) => {
                setDraft(e.target.value.toLowerCase());
                setNotice(null);
              }}
            />
          </Field>
          <Button
            variant="primary"
            disabled={!hasChanges || mutation.isPending}
            onClick={() => mutation.mutate(value.trim() === '' ? null : value.trim())}
          >
            {mutation.isPending ? 'Salvando…' : 'Salvar'}
          </Button>
        </div>
      )}
    </div>
  );
}

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

      <HostnameSettings serverId={serverId} canEdit={server?.permissions.includes('hostname.update') ?? false} />

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
