import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PackageOpen, Trash2 } from 'lucide-react';
import { getServer } from '@/features/servers/servers.api';
import { Alert, Button, ConfirmDialog, LoadingRow, PageHeader } from '@/ui/primitives';
import { ADDON_SOURCES } from './sources';
import type { AddonContext } from './addons.types';
import { ModpacksPanel } from './ModpacksPanel';
import { getLatestModpackInstallation, getModpackProject, uninstallLatestModpack, type ModpackSource } from './modpacks.api';

export function AddonsPage({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const { data: server, isLoading, isError } = useQuery({ queryKey: ['server', serverId], queryFn: () => getServer(serverId) });
  const installation = useQuery({
    queryKey: ['modpack-installation', serverId],
    queryFn: () => getLatestModpackInstallation(serverId),
    refetchInterval: (query) => isInstallationActive(query.state.data?.status) ? 2_000 : false,
  });
  const installedModpack = installation.data?.status === 'completed' && installation.data.source === 'modrinth'
    ? installation.data
    : null;
  const installedProject = useQuery({
    queryKey: ['modpack-project', serverId, installedModpack?.source, installedModpack?.projectId],
    queryFn: () => getModpackProject(serverId, installedModpack!.source as ModpackSource, installedModpack!.projectId),
    enabled: Boolean(installedModpack),
    staleTime: 60 * 60 * 1000,
  });
  const [sourceId, setSourceId] = useState(ADDON_SOURCES[0].id);
  const [contentType, setContentType] = useState<'mods' | 'modpacks'>('modpacks');
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const uninstall = useMutation({
    mutationFn: () => uninstallLatestModpack(serverId),
    onSuccess: async () => {
      setConfirmUninstall(false);
      queryClient.setQueryData(['modpack-installation', serverId], null);
      await queryClient.invalidateQueries({ queryKey: ['files', serverId] });
    },
  });

  // The Agent installs a modpack asynchronously. Refresh the list as soon
  // as the operation completes, including when this page stayed open while
  // the server was being prepared.
  useEffect(() => {
    if (installation.data?.status === 'completed' && server?.software.addonDir) {
      void queryClient.invalidateQueries({ queryKey: ['files', serverId, server.software.addonDir] });
    }
  }, [installation.data?.status, queryClient, server?.software.addonDir, serverId]);

  if (isLoading) return <LoadingRow />;
  if (isError || !server) return <Alert>Não foi possível carregar este servidor.</Alert>;

  const { software, permissions } = server;

  // A server is plugins OR mods, never both — vanilla/other/null gets a
  // single honest message instead of an empty tab with nothing to show.
  if (!software.addonDir) {
    return (
      <>
        <PageHeader title="Add-ons" />
        <Alert tone="info">{software.label} não usa mods nem plugins — não há nada para instalar aqui.</Alert>
      </>
    );
  }

  const ctx: AddonContext = { server, permissions, software };
  const available = ADDON_SOURCES.filter((s) => s.available(ctx));
  const active = available.find((s) => s.id === sourceId) ?? available[0];
  const isModsServer = software.addonNoun === 'mod';
  const canViewModpacks = server.role !== 'subuser' || permissions.includes('addons.catalog.read');
  const canUninstallModpack = server.role !== 'subuser' || permissions.includes('addons.install');
  const selectedContentType = isModsServer && canViewModpacks ? contentType : 'mods';

  return (
    <>
      <PageHeader title={software.addonLabel ?? 'Add-ons'}>
        <p className="mt-1 text-sm text-text-muted">
          {software.label} carrega {software.addonNoun === 'mod' ? 'mods' : 'plugins'} de{' '}
          <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">{software.addonDirDisplay}</code>.
        </p>
      </PageHeader>

      {isModsServer && (
        <div className="-mt-2 mb-4 flex items-center gap-1 border-b border-border">
          {(['mods', 'modpacks'] as const).map((type) => (
            <button
              key={type}
              type="button"
              disabled={type === 'modpacks' && !canViewModpacks}
              title={type === 'modpacks' && !canViewModpacks ? 'Você não possui permissão para visualizar o catálogo.' : undefined}
              onClick={() => setContentType(type)}
              className={`border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${selectedContentType === type ? 'border-accent text-accent-strong' : 'border-transparent text-text-muted hover:text-text'}`}
            >
              {type === 'mods' ? 'Mods' : 'Modpacks'}
            </button>
          ))}
        </div>
      )}

      {selectedContentType === 'mods' && installedModpack && (
        <section className="mb-5 overflow-hidden rounded-card border border-accent/35 bg-accent/5 shadow-xs" aria-label="Modpack instalado">
          <div className="flex items-center gap-3 p-4 sm:p-5">
            {installedProject.data?.icon ? (
              <img src={installedProject.data.icon} alt="" className="h-14 w-14 shrink-0 rounded-xl object-cover shadow-sm" />
            ) : (
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent-strong">
                <PackageOpen className="h-7 w-7" aria-hidden="true" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-accent-strong">Modpack instalado</p>
              <h2 className="truncate text-lg font-semibold text-text">{installedModpack.projectName}</h2>
              <p className="mt-0.5 text-sm text-text-muted">
                {installedModpack.versionName} · Minecraft {installedModpack.minecraftVersion} · {installedModpack.loader === 'neoforge' ? 'NeoForge' : installedModpack.loader.charAt(0).toUpperCase() + installedModpack.loader.slice(1)}
              </p>
            </div>
            {canUninstallModpack && (
              <Button variant="danger" size="sm" className="shrink-0" onClick={() => setConfirmUninstall(true)}>
                <Trash2 className="h-4 w-4" /> Remover modpack
              </Button>
            )}
          </div>
          {uninstall.isError && <Alert className="mx-4 mb-4" title="Não foi possível remover o modpack">{uninstall.error.message}</Alert>}
        </section>
      )}

      {selectedContentType === 'mods' && available.length > 1 && (
        <div className="-mt-2 mb-4 flex items-center gap-1 border-b border-border">
          {available.map((s) => (
            <button
              key={s.id}
              onClick={() => setSourceId(s.id)}
              className={`inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
                active?.id === s.id
                  ? 'border-accent text-accent-strong'
                  : 'border-transparent text-text-muted hover:border-border-strong hover:text-text'
              }`}
            >
              <s.icon className="h-4 w-4" aria-hidden="true" />
              {s.label}
            </button>
          ))}
        </div>
      )}

      {selectedContentType === 'modpacks' ? <ModpacksPanel serverId={serverId} ctx={ctx} /> : active && <active.Panel serverId={serverId} ctx={ctx} />}

      <ConfirmDialog
        open={confirmUninstall}
        title="Remover modpack"
        message={`Remover ${installedModpack?.projectName ?? 'este modpack'}? O servidor precisa estar desligado. Os arquivos voltarão para o backup criado antes da instalação; alterações feitas depois dela também serão revertidas.`}
        confirmLabel={uninstall.isPending ? 'Removendo…' : 'Remover e restaurar backup'}
        tone="danger"
        loading={uninstall.isPending}
        onConfirm={() => uninstall.mutate()}
        onCancel={() => setConfirmUninstall(false)}
      />
    </>
  );
}

function isInstallationActive(status?: string): boolean {
  return Boolean(status && ['pending', 'downloading', 'installing', 'configuring', 'rolling_back'].includes(status));
}
