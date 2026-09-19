import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getServer } from '@/features/servers/servers.api';
import { Alert, LoadingRow, PageHeader } from '@/ui/primitives';
import { ADDON_SOURCES } from './sources';
import type { AddonContext } from './addons.types';
import { ModpacksPanel } from './ModpacksPanel';

export function AddonsPage({ serverId }: { serverId: string }) {
  const { data: server, isLoading, isError } = useQuery({ queryKey: ['server', serverId], queryFn: () => getServer(serverId) });
  const [sourceId, setSourceId] = useState(ADDON_SOURCES[0].id);
  const [contentType, setContentType] = useState<'mods' | 'modpacks'>('mods');

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
              className={`border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${contentType === type ? 'border-accent text-accent-strong' : 'border-transparent text-text-muted hover:text-text'}`}
            >
              {type === 'mods' ? 'Mods' : 'Modpacks'}
            </button>
          ))}
        </div>
      )}

      {contentType === 'mods' && available.length > 1 && (
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

      {contentType === 'modpacks' && isModsServer && canViewModpacks ? <ModpacksPanel serverId={serverId} ctx={ctx} /> : active && <active.Panel serverId={serverId} ctx={ctx} />}
    </>
  );
}
