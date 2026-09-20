import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { completeServerSetup, getServerSetup } from './servers.api';
import type { ServerSetupSoftwareOption } from '@/shared/api/types';
import { SoftwareIcon } from '@/features/public/software-icons';
import { ApiError } from '@/shared/api/client';
import { formatMemory, formatVcpu } from '@/shared/format/plan';
import { Alert, Button, Card, Field, Input, LoadingRow, Select } from '@/ui/primitives';

/**
 * The post-purchase setup screen — what a customer sees the first time
 * they open a `setup_pending` server, and again if the install ever
 * fails (`install_failed`). Deliberately hides everything technical a
 * template also carries (Docker image, install script, SERVER_JARFILE,
 * PAPER_BUILD, JVM args, ...) — the customer only ever picks a name, a
 * software, and a Minecraft version; `ServerSetupService.complete`
 * resolves every other variable to its template default server-side.
 *
 * Submitting is also the ONLY retry mechanism after a failed install —
 * the exact same `POST .../setup` call, since the backend's CAS accepts
 * both `setup_pending` and `install_failed` as valid starting points
 * (see that service's own doc comment on why this is safe to expose to
 * the client at all).
 */
export function ServerSetupPage({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const { data: setup, isLoading, isError } = useQuery({ queryKey: ['server-setup', serverId], queryFn: () => getServerSetup(serverId) });

  const [name, setName] = useState('');
  const [softwareId, setSoftwareId] = useState('');
  const [version, setVersion] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Prefills the name field with the server's current placeholder
  // (shortId-based, set at reservation time) the moment it loads — the
  // customer can change it, but starting from blank would be a worse
  // default than "already has something reasonable in it."
  useEffect(() => {
    if (setup && !name) setName(setup.name);
  }, [setup, name]);

  const selected: ServerSetupSoftwareOption | undefined = setup?.software.find((s) => s.id === softwareId);

  useEffect(() => {
    setVersion(selected?.defaultVersion ?? '');
  }, [selected]);

  const mutation = useMutation({
    mutationFn: () =>
      completeServerSetup(serverId, {
        name: name.trim(),
        templateId: softwareId,
        variables: version.trim() ? { MINECRAFT_VERSION: version.trim() } : undefined,
      }),
    onSuccess: () => {
      // Flips the server's own status server-side (setup_pending/
      // install_failed -> installing) — refetching here is what makes
      // ServerLayout swap from this page to ServerInstallingPage on its
      // own, no navigation call needed.
      void queryClient.invalidateQueries({ queryKey: ['server', serverId] });
      void queryClient.invalidateQueries({ queryKey: ['server-setup', serverId] });
      // ServerSetupService.complete writes the REAL MINECRAFT_VERSION
      // (and every other declared variable) synchronously, in the same
      // transaction that flips status to 'installing' — found live:
      // without this, a `['server-variables', serverId]` query fetched
      // even once before this point (e.g. this tab was already open,
      // or a route prefetch) kept serving that stale snapshot forever
      // afterward, since nothing else ever invalidated it — the Console
      // page's software/version label and the Configurações tab both
      // read this same query and both showed the wrong version even
      // after the real install finished.
      void queryClient.invalidateQueries({ queryKey: ['server-variables', serverId] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível concluir a configuração. Tente novamente em instantes.'),
  });

  if (isLoading) return <LoadingRow label="Carregando opções de configuração…" />;
  if (isError || !setup) return <Alert tone="fail">Não foi possível carregar a configuração deste servidor.</Alert>;

  const isRetry = setup.status === 'install_failed';
  const canSubmit = name.trim().length > 0 && !!selected && version.trim().length > 0;

  return (
    <div className="mx-auto max-w-2xl space-y-6 py-4">
      <div>
        <h1 className="text-xl font-semibold text-text">{isRetry ? 'Vamos tentar de novo' : 'Configure seu servidor'}</h1>
        <p className="mt-1 text-sm text-text-muted">
          Seu plano inclui {formatMemory(setup.plan.memoryMb)} de RAM · {formatVcpu(setup.plan.cpuLimitPercent)} · {formatMemory(setup.plan.diskMb)} de armazenamento.
        </p>
      </div>

      {isRetry && (
        <Alert tone="fail" title="A instalação anterior falhou">
          Confira as opções abaixo e tente novamente — nada do que você já pagou foi perdido.
        </Alert>
      )}
      {error && (
        <Alert tone="fail" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Field label="Nome do servidor" htmlFor="setup-name" required>
        <Input id="setup-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Meu servidor" maxLength={191} />
      </Field>

      <div>
        <p className="mb-2 text-sm font-medium text-text">Escolha o software</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {setup.software.map((s) => (
            <Card
              key={s.id}
              className={`cursor-pointer transition ${softwareId === s.id ? 'border-brand ring-1 ring-brand' : 'hover:border-text-faint'}`}
            >
              <button type="button" onClick={() => setSoftwareId(s.id)} className="flex w-full flex-col items-start gap-2 p-4 text-left">
                <div className="flex w-full items-center justify-between">
                  <SoftwareIcon template={s} className="h-8 w-8" />
                  {softwareId === s.id && <Check className="h-4 w-4 text-brand" aria-hidden="true" />}
                </div>
                <p className="font-medium text-text">{s.name}</p>
                {s.description && <p className="text-xs text-text-muted">{s.description}</p>}
              </button>
            </Card>
          ))}
        </div>
      </div>

      {selected && (
        <Field label="Versão do Minecraft" htmlFor="setup-version">
          {selected.versionsCurated ? (
            <Select id="setup-version" value={version} onChange={(e) => setVersion(e.target.value)}>
              {selected.versions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              id="setup-version"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="latest"
            />
          )}
        </Field>
      )}

      <Button variant="primary" className="w-full" disabled={!canSubmit || mutation.isPending} onClick={() => void mutation.mutate()}>
        {mutation.isPending ? 'Enviando…' : isRetry ? 'Tentar novamente' : 'Continuar'}
      </Button>
    </div>
  );
}
