import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, RefreshCw } from 'lucide-react';
import { listServerVariables, updateServerVariables } from './variables.api';
import { updateServerHostname } from './hostname.api';
import { readFile, writeFile } from '@/features/files/files.api';
import { getServer, getServerStats } from '@/features/servers/servers.api';
import { VersionPickerModal } from '@/features/servers/VersionPickerModal';
import { ApiError } from '@/shared/api/client';
import { Alert, Button, Field, Input, LoadingRow, PageHeader, Select } from '@/ui/primitives';

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

// online-mode lives in server.properties, not in a template startup
// variable — unlike everything in VariablesPage's own list below, toggling
// it needs no container recreate (Minecraft only reads server.properties
// at JVM boot), so this reuses the plain file read/write endpoints the
// file manager already exposes instead of going through
// updateServerVariables. Silently renders nothing if the file can't be
// read (non-Minecraft template, or not installed yet) rather than
// showing a broken control.
const ONLINE_MODE_LINE = /^online-mode=.*$/m;
const WHITELIST_LINE = /^white-list=.*$/m;

function parseServerProperty(content: string, linePattern: RegExp, property: string, defaultValue: boolean): boolean {
  const match = content.match(linePattern);
  return match ? match[0].trim() !== `${property}=false` : defaultValue;
}

function withServerProperty(content: string, linePattern: RegExp, property: string, value: boolean): string {
  const line = `${property}=${value}`;
  if (linePattern.test(content)) return content.replace(linePattern, line);
  return content.replace(/\n+$/, '') + '\n' + line + '\n';
}

function MinecraftAccessSettings({ serverId, canEdit }: { serverId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data: propertiesFile } = useQuery({
    queryKey: ['server-properties', serverId],
    queryFn: () => readFile(serverId, 'server.properties'),
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: ({ property, linePattern, value }: { property: string; linePattern: RegExp; value: boolean }) =>
      writeFile(serverId, 'server.properties', withServerProperty(propertiesFile!.content, linePattern, property, value)),
    onSuccess: (_result, { property, value }) => {
      setError(null);
      const setting = property === 'online-mode' ? 'Online mode' : 'Whitelist';
      const state = property === 'online-mode' ? (value ? 'ativado' : 'desativado') : (value ? 'ativada' : 'desativada');
      setNotice(`${setting} ${state} — reinicie o servidor para aplicar.`);
      void queryClient.invalidateQueries({ queryKey: ['server-properties', serverId] });
    },
    onError: (err) => {
      setNotice(null);
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    },
  });

  if (!propertiesFile) return null;
  const onlineMode = mutation.isPending && mutation.variables?.property === 'online-mode'
    ? mutation.variables.value
    : parseServerProperty(propertiesFile.content, ONLINE_MODE_LINE, 'online-mode', true);
  const whitelist = mutation.isPending && mutation.variables?.property === 'white-list'
    ? mutation.variables.value
    : parseServerProperty(propertiesFile.content, WHITELIST_LINE, 'white-list', false);

  function update(property: 'online-mode' | 'white-list', linePattern: RegExp, value: boolean) {
    setNotice(null);
    setError(null);
    mutation.mutate({ property, linePattern, value });
  }

  return (
    <div className="mb-6 space-y-4">
      <PropertyToggleCard
        title="Online Mode"
        description="Exige que quem entra tenha uma conta Microsoft/Mojang autenticada. Desligue só para testes com contas não-premium — enquanto estiver desligado, qualquer pessoa entra com qualquer nome."
        checked={onlineMode}
        enabled={canEdit}
        pending={mutation.isPending}
        stateLabel={onlineMode ? 'Online mode ativado' : 'Online mode desativado'}
        onChange={(value) => update('online-mode', ONLINE_MODE_LINE, value)}
      />
      <PropertyToggleCard
        title="Whitelist"
        description="Quando ativada, somente jogadores adicionados à whitelist poderão entrar no servidor. Use /whitelist add <jogador> no console para liberar acessos."
        checked={whitelist}
        enabled={canEdit}
        pending={mutation.isPending}
        stateLabel={whitelist ? 'Whitelist ativada' : 'Whitelist desativada'}
        onChange={(value) => update('white-list', WHITELIST_LINE, value)}
      />
      {notice && <Alert tone="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
    </div>
  );
}

function PropertyToggleCard({ title, description, checked, enabled, pending, stateLabel, onChange }: { title: string; description: string; checked: boolean; enabled: boolean; pending: boolean; stateLabel: string; onChange: (value: boolean) => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-surface p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold text-text">{title}</h2>
          <p className="mt-1 text-sm text-text-muted">{description}</p>
        </div>
        {enabled && (
          <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={checked ? `Desligar ${title}` : `Ligar ${title}`}
            disabled={pending}
            onClick={() => onChange(!checked)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${checked ? 'bg-accent' : 'bg-surface-2'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        )}
      </div>
      <p className={`text-xs font-medium ${checked ? 'text-ok' : 'text-text-faint'}`}>{stateLabel}</p>
    </div>
  );
}


export function VariablesPage({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const { data: server } = useQuery({ queryKey: ['server', serverId], queryFn: () => getServer(serverId) });
  const { data: stats } = useQuery({ queryKey: ['server', 'stats', serverId], queryFn: () => getServerStats(serverId), refetchInterval: 15_000 });
  const { data: variables, isLoading, isError } = useQuery({ queryKey: ['server-variables', serverId], queryFn: () => listServerVariables(serverId) });

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [versionPickerOpen, setVersionPickerOpen] = useState(false);

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

      {canEdit && (
        <div className="mb-6 flex flex-col gap-3 rounded-card border border-border bg-surface p-5">
          <div>
            <h2 className="font-semibold text-text">Versão do Minecraft</h2>
            <p className="mt-1 text-sm text-text-muted">Troque o software (Vanilla, Paper, Forge, Fabric…) ou a versão instalada — o mundo e os plugins são preservados.</p>
          </div>
          {running && <Alert tone="warn">Pare o servidor para trocar a versão.</Alert>}
          <Button variant="secondary" disabled={running} onClick={() => setVersionPickerOpen(true)} className="self-start">
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Trocar versão do Minecraft
          </Button>
        </div>
      )}
      {server && (
        <VersionPickerModal
          serverId={serverId}
          currentTemplateId={server.template?.id ?? null}
          currentVersion={variables?.find((v) => v.envVariable === 'MINECRAFT_VERSION')?.value ?? null}
          open={versionPickerOpen}
          onClose={() => setVersionPickerOpen(false)}
        />
      )}

      <MinecraftAccessSettings serverId={serverId} canEdit={server?.permissions.includes('file.write') ?? false} />

      {/* Non-editable variables (e.g. SERVER_MEMORY, set by the plan) are
          never rendered here — a disabled field the customer can't act on
          either way isn't useful in a settings form; it's plumbing, not a
          setting. Still returned by the API (isUserViewable alone gates
          that), just not shown on THIS screen. MINECRAFT_VERSION and each
          software's own build/loader field (PAPER_BUILD,
          FABRIC_LOADER_VERSION, FORGE_VERSION, NEOFORGE_VERSION,
          PURPUR_BUILD — see software-presets.ts's own `buildVariable` per
          preset) are excluded here too, even though they ARE editable —
          found live: editing "Forge Version" here alone can never take
          effect without a restart anyway (same "stopped, then recreates
          the container" rule every other field here already has), and
          changing JUST the build without the Minecraft version it's
          paired with rarely makes sense on its own. "Trocar versão" above
          supersedes both: it already requires the server to be offline,
          and resolves the right build for whichever Minecraft version the
          customer actually picks — this is the one place editing either
          is expected to belong. */}
      {(() => {
        const VERSION_PICKER_OWNED_VARIABLES = new Set([
          'MINECRAFT_VERSION',
          'PAPER_BUILD',
          'FABRIC_LOADER_VERSION',
          'FORGE_VERSION',
          'NEOFORGE_VERSION',
          'PURPUR_BUILD',
        ]);
        const editableVariables = variables?.filter((v) => v.isEditable && !VERSION_PICKER_OWNED_VARIABLES.has(v.envVariable)) ?? [];
        if (editableVariables.length === 0) {
          return <p className="text-sm text-text-muted">Este servidor não tem variáveis configuráveis.</p>;
        }
        return (
          <div className="flex flex-col gap-4">
            {editableVariables.map((v) => {
              const currentValue = drafts[v.envVariable] ?? v.value;
              return (
                <Field key={v.id} label={v.name} htmlFor={`var-${v.id}`} hint={v.description ?? undefined}>
                  {v.kind === 'choice' && v.choices ? (
                    <Select
                      id={`var-${v.id}`}
                      value={currentValue}
                      disabled={!canEdit || running}
                      onChange={(e) => handleChange(v.envVariable, e.target.value)}
                    >
                      {/* The stored value might predate this field being curated to a fixed list — keep it selectable rather than silently swapping it out from under the customer. */}
                      {!v.choices.includes(currentValue) && <option value={currentValue}>{currentValue}</option>}
                      {v.choices.map((choice) => (
                        <option key={choice} value={choice}>
                          {choice}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      id={`var-${v.id}`}
                      value={currentValue}
                      disabled={!canEdit || running}
                      onChange={(e) => handleChange(v.envVariable, e.target.value)}
                    />
                  )}
                </Field>
              );
            })}
          </div>
        );
      })()}
    </>
  );
}
