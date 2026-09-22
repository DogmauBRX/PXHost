import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readFile, writeFile } from '@/features/files/files.api';
import { ApiError } from '@/shared/api/client';
import { Alert } from '@/ui/primitives';

const ONLINE_MODE_LINE = /^online-mode=.*$/m;
const WHITELIST_LINE = /^white-list=.*$/m;

type Presentation = 'cards' | 'compact';
type Property = 'online-mode' | 'white-list';

interface MinecraftAccessSettingsProps {
  serverId: string;
  canEdit: boolean;
  presentation?: Presentation;
}

function parseServerProperty(content: string, linePattern: RegExp, property: Property, defaultValue: boolean): boolean {
  const match = content.match(linePattern);
  return match ? match[0].trim() !== `${property}=false` : defaultValue;
}

function withServerProperty(content: string, linePattern: RegExp, property: Property, value: boolean): string {
  const line = `${property}=${value}`;
  if (linePattern.test(content)) return content.replace(linePattern, line);
  return content.replace(/\n+$/, '') + '\n' + line + '\n';
}

function Toggle({ title, checked, enabled, pending, onChange }: {
  title: string;
  checked: boolean;
  enabled: boolean;
  pending: boolean;
  onChange: (value: boolean) => void;
}) {
  if (!enabled) return null;

  return (
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
  );
}

function AccessToggleCard({ title, description, checked, enabled, pending, onChange }: {
  title: string;
  description: string;
  checked: boolean;
  enabled: boolean;
  pending: boolean;
  onChange: (value: boolean) => void;
}) {
  const stateLabel = title === 'Online Mode'
    ? `Online mode ${checked ? 'ativado' : 'desativado'}`
    : `Whitelist ${checked ? 'ativada' : 'desativada'}`;

  return (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-surface p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold text-text">{title}</h2>
          <p className="mt-1 text-sm text-text-muted">{description}</p>
        </div>
        <Toggle title={title} checked={checked} enabled={enabled} pending={pending} onChange={onChange} />
      </div>
      <p className={`text-xs font-medium ${checked ? 'text-ok' : 'text-text-faint'}`}>{stateLabel}</p>
    </div>
  );
}

/**
 * The two switches edit server.properties directly, so they work without
 * recreating the container. Both the configuration page and the console use
 * this single component to keep their state and behaviour identical.
 */
export function MinecraftAccessSettings({ serverId, canEdit, presentation = 'cards' }: MinecraftAccessSettingsProps) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data: propertiesFile } = useQuery({
    queryKey: ['server-properties', serverId],
    queryFn: () => readFile(serverId, 'server.properties'),
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: ({ property, linePattern, value }: { property: Property; linePattern: RegExp; value: boolean }) =>
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

  const update = (property: Property, linePattern: RegExp, value: boolean) => {
    setNotice(null);
    setError(null);
    mutation.mutate({ property, linePattern, value });
  };

  const controls = (
    <>
      <AccessToggleCard
        title="Online Mode"
        description="Exige que quem entra tenha uma conta Microsoft/Mojang autenticada. Desligue só para testes com contas não-premium — enquanto estiver desligado, qualquer pessoa entra com qualquer nome."
        checked={onlineMode}
        enabled={canEdit}
        pending={mutation.isPending}
        onChange={(value) => update('online-mode', ONLINE_MODE_LINE, value)}
      />
      <AccessToggleCard
        title="Whitelist"
        description="Quando ativada, somente jogadores adicionados à whitelist poderão entrar no servidor. Use /whitelist add <jogador> no console para liberar acessos."
        checked={whitelist}
        enabled={canEdit}
        pending={mutation.isPending}
        onChange={(value) => update('white-list', WHITELIST_LINE, value)}
      />
    </>
  );

  if (presentation === 'compact') {
    return (
      <div className="flex flex-wrap items-center justify-end gap-2.5 xl:ml-auto">
        <CompactAccessToggle title="Online Mode" checked={onlineMode} enabled={canEdit} pending={mutation.isPending} onChange={(value) => update('online-mode', ONLINE_MODE_LINE, value)} />
        <CompactAccessToggle title="Whitelist" checked={whitelist} enabled={canEdit} pending={mutation.isPending} onChange={(value) => update('white-list', WHITELIST_LINE, value)} />
        {notice && <p className="w-full text-right text-xs font-medium text-ok" role="status">{notice}</p>}
        {error && <p className="w-full text-right text-xs font-medium text-fail" role="alert">{error}</p>}
      </div>
    );
  }

  return (
    <div className="mb-6 space-y-4">
      {controls}
      {notice && <Alert tone="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
    </div>
  );
}

function CompactAccessToggle({ title, checked, enabled, pending, onChange }: {
  title: string;
  checked: boolean;
  enabled: boolean;
  pending: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5">
      <span className="text-xs font-semibold text-text-muted">{title}</span>
      <Toggle title={title} checked={checked} enabled={enabled} pending={pending} onChange={onChange} />
    </div>
  );
}
