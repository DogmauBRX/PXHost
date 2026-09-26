import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, Search } from 'lucide-react';
import { changeServerVersion, getServerSetup } from './servers.api';
import type { ServerSetupSoftwareOption } from '@/shared/api/types';
import { SoftwareIcon } from '@/features/public/software-icons';
import { ApiError } from '@/shared/api/client';
import { Alert, Badge, Button, ConfirmDialog, Input, LoadingRow, Modal } from '@/ui/primitives';

const SOFTWARE_LABELS: Record<string, string> = {
  paper: 'Paper',
  purpur: 'Purpur',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  vanilla: 'Vanilla',
  spigot: 'Spigot',
  bukkit: 'Bukkit',
  bungeecord: 'BungeeCord',
  velocity: 'Velocity',
};

const INITIAL_VERSION_LIMIT = 24;

function softwareLabel(kind: string | null, fallback: string): string {
  return (kind && SOFTWARE_LABELS[kind]) || fallback || 'Outro';
}

interface VersionChoice {
  templateId: string;
  softwareName: string;
  description: string | null;
  iconUrl: string | null;
  softwareKind: string | null;
  versions: string[];
}

interface VersionSelection {
  templateId: string;
  softwareName: string;
  iconUrl: string | null;
  softwareKind: string | null;
  version: string;
}

function toChoices(software: ServerSetupSoftwareOption[]): VersionChoice[] {
  return software
    .map((item) => ({
      templateId: item.id,
      softwareName: item.name,
      description: item.description,
      iconUrl: item.iconUrl,
      softwareKind: item.softwareKind,
      versions: item.versionsCurated ? item.versions : [item.defaultVersion ?? 'latest'],
    }))
    .sort((a, b) => softwareLabel(a.softwareKind, a.softwareName).localeCompare(softwareLabel(b.softwareKind, b.softwareName), 'pt-BR'));
}

/**
 * Version changes are a two-step choice: software first, Minecraft version
 * second. Keeping those dimensions separate avoids rendering one large,
 * repeated card for every (software, version) pair and lets the dialog open
 * directly on the software/version the server is currently using.
 */
export function VersionPickerModal({
  serverId,
  currentTemplateId,
  currentVersion,
  open,
  onClose,
}: {
  serverId: string;
  currentTemplateId: string | null;
  currentVersion: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: setup, isLoading, isError } = useQuery({
    queryKey: ['server-setup', serverId],
    queryFn: () => getServerSetup(serverId),
    enabled: open,
  });

  const [softwareId, setSoftwareId] = useState('');
  const [version, setVersion] = useState('');
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [pending, setPending] = useState<VersionSelection | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choices = useMemo(() => toChoices(setup?.software ?? []), [setup]);
  // Empty local state deliberately means "use the current server value".
  // This derives the correct first render as soon as the query resolves,
  // without a second render/effect that briefly flashed the wrong tab.
  const defaultSoftware = choices.find((choice) => choice.templateId === currentTemplateId) ?? choices[0] ?? null;
  const selectedSoftware = choices.find((choice) => choice.templateId === softwareId) ?? defaultSoftware;
  const selectedVersion =
    version ||
    (selectedSoftware?.templateId === currentTemplateId && currentVersion && selectedSoftware.versions.includes(currentVersion)
      ? currentVersion
      : (selectedSoftware?.versions[0] ?? ''));

  const orderedVersions = useMemo(() => {
    if (!selectedSoftware) return [];
    if (selectedSoftware.templateId !== currentTemplateId || !currentVersion || !selectedSoftware.versions.includes(currentVersion)) {
      return selectedSoftware.versions;
    }
    return [currentVersion, ...selectedSoftware.versions.filter((item) => item !== currentVersion)];
  }, [selectedSoftware, currentTemplateId, currentVersion]);

  const filteredVersions = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('pt-BR');
    return term ? orderedVersions.filter((item) => item.toLocaleLowerCase('pt-BR').includes(term)) : orderedVersions;
  }, [orderedVersions, search]);
  const visibleVersions = search || showAll ? filteredVersions : filteredVersions.slice(0, INITIAL_VERSION_LIMIT);
  const hiddenVersionCount = filteredVersions.length - visibleVersions.length;

  const selection: VersionSelection | null =
    selectedSoftware && selectedVersion
      ? {
          templateId: selectedSoftware.templateId,
          softwareName: selectedSoftware.softwareName,
          iconUrl: selectedSoftware.iconUrl,
          softwareKind: selectedSoftware.softwareKind,
          version: selectedVersion,
        }
      : null;
  const isCurrentSelection = selection?.templateId === currentTemplateId && selection.version === currentVersion;

  const chooseSoftware = (choice: VersionChoice) => {
    setSoftwareId(choice.templateId);
    setVersion(
      choice.templateId === currentTemplateId && currentVersion && choice.versions.includes(currentVersion)
        ? currentVersion
        : (choice.versions[0] ?? ''),
    );
    setSearch('');
    setShowAll(false);
  };

  const close = () => {
    setSoftwareId('');
    setVersion('');
    setSearch('');
    setShowAll(false);
    setError(null);
    onClose();
  };

  const mutation = useMutation({
    mutationFn: (choice: VersionSelection) =>
      changeServerVersion(serverId, { templateId: choice.templateId, variables: { MINECRAFT_VERSION: choice.version } }),
    onSuccess: () => {
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: ['server', serverId] });
      void queryClient.invalidateQueries({ queryKey: ['server-variables', serverId] });
      close();
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Não foi possível trocar a versão. Tente novamente.');
    },
  });

  const footer =
    setup && selectedSoftware ? (
      <>
        <div className="mr-auto hidden min-w-0 sm:block">
          <p className="truncate text-xs text-text-muted">Selecionado</p>
          <p className="truncate text-sm font-medium text-text">
            {softwareLabel(selectedSoftware.softwareKind, selectedSoftware.softwareName)} · Minecraft {selectedVersion || '—'}
          </p>
        </div>
        <Button variant="ghost" onClick={close} disabled={mutation.isPending}>
          Cancelar
        </Button>
        <Button
          variant="primary"
          disabled={!selection || isCurrentSelection || mutation.isPending}
          onClick={() => selection && setPending(selection)}
        >
          {isCurrentSelection ? (
            <>
              <Check className="h-4 w-4" aria-hidden="true" />
              Versão atual
            </>
          ) : (
            <>
              <Download className="h-4 w-4" aria-hidden="true" />
              Instalar versão
            </>
          )}
        </Button>
      </>
    ) : undefined;

  return (
    <>
      <Modal
        open={open}
        onClose={close}
        title="Trocar versão do Minecraft"
        description="Escolha o software e depois a versão que deseja instalar."
        size="lg"
        footer={footer}
      >
        {error && (
          <Alert className="mb-4" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}

        {isLoading ? (
          <LoadingRow label="Carregando versões disponíveis…" />
        ) : isError || !setup ? (
          <Alert tone="fail">Não foi possível carregar as versões disponíveis.</Alert>
        ) : (
          <div className="space-y-5">
            <section>
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-text">1. Escolha o software</h3>
                {currentTemplateId && <span className="text-xs text-text-muted">O atual já vem selecionado</span>}
              </div>
              <div className="flex flex-wrap gap-2" role="list" aria-label="Softwares disponíveis">
                {choices.map((choice) => {
                  const selected = choice.templateId === selectedSoftware?.templateId;
                  const current = choice.templateId === currentTemplateId;
                  return (
                    <button
                      key={choice.templateId}
                      type="button"
                      onClick={() => chooseSoftware(choice)}
                      aria-pressed={selected}
                      className={`inline-flex h-9 items-center gap-2 rounded-full border px-3 text-sm font-medium transition ${
                        selected
                          ? 'border-accent-strong bg-accent-tint text-accent-strong'
                          : 'border-border text-text-muted hover:border-border-strong hover:text-text'
                      }`}
                    >
                      {softwareLabel(choice.softwareKind, choice.softwareName)}
                      {current && <span className="h-1.5 w-1.5 rounded-full bg-ok" title="Software atual" />}
                    </button>
                  );
                })}
              </div>
            </section>

            {selectedSoftware && (
              <section className="rounded-card border border-border bg-surface-2/50 p-4">
                <div className="flex items-center gap-3">
                  <SoftwareIcon
                    template={{
                      iconUrl: selectedSoftware.iconUrl,
                      softwareKind: selectedSoftware.softwareKind,
                      name: selectedSoftware.softwareName,
                    }}
                    className="h-10 w-10"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-text">{selectedSoftware.softwareName}</p>
                      {selectedSoftware.templateId === currentTemplateId && <Badge tone="ok">software atual</Badge>}
                    </div>
                    {selectedSoftware.description && <p className="mt-0.5 text-xs text-text-muted">{selectedSoftware.description}</p>}
                  </div>
                </div>
              </section>
            )}

            <section>
              <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-text">2. Escolha a versão do Minecraft</h3>
                  <p className="mt-0.5 text-xs text-text-muted">{orderedVersions.length} versões disponíveis</p>
                </div>
                {orderedVersions.length > 8 && (
                  <Input
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setShowAll(false);
                    }}
                    icon={Search}
                    aria-label="Buscar versão"
                    placeholder="Buscar versão…"
                    className="w-full sm:w-56"
                  />
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {visibleVersions.map((item) => {
                  const selected = item === selectedVersion;
                  const current = selectedSoftware?.templateId === currentTemplateId && item === currentVersion;
                  return (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setVersion(item)}
                      aria-pressed={selected}
                      className={`flex min-h-11 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm font-medium transition ${
                        selected
                          ? 'border-accent-strong bg-accent-tint text-accent-strong ring-1 ring-accent-strong/30'
                          : 'border-border bg-surface text-text hover:border-border-strong hover:bg-surface-2'
                      }`}
                    >
                      <span className="truncate">{item}</span>
                      {selected ? (
                        <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                      ) : current ? (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" title="Versão atual" />
                      ) : null}
                    </button>
                  );
                })}
              </div>

              {visibleVersions.length === 0 && <p className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-text-muted">Nenhuma versão encontrada.</p>}
              {hiddenVersionCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="mt-3 w-full rounded-lg border border-border py-2 text-sm font-medium text-text-muted transition hover:border-border-strong hover:bg-surface-2 hover:text-text"
                >
                  Mostrar mais {hiddenVersionCount} versões
                </button>
              )}
            </section>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={pending !== null}
        title="Trocar versão"
        message={
          pending
            ? `Isso vai instalar ${pending.softwareName} (Minecraft ${pending.version}), sobrescrevendo o server.jar atual. O mundo, plugins e configurações são preservados. O servidor precisa ficar parado durante a instalação.`
            : ''
        }
        confirmLabel={mutation.isPending ? 'Instalando…' : 'Trocar versão'}
        loading={mutation.isPending}
        onConfirm={() => pending && mutation.mutate(pending)}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
