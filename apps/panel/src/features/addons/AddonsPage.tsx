import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getServer } from '@/features/servers/servers.api';
import { Alert, LoadingRow, PageHeader } from '@/ui/primitives';
import { ADDON_SOURCES } from './sources';
import type { AddonContext } from './addons.types';

export function AddonsPage({ serverId }: { serverId: string }) {
  const { data: server, isLoading, isError } = useQuery({ queryKey: ['server', serverId], queryFn: () => getServer(serverId) });
  const [sourceId, setSourceId] = useState(ADDON_SOURCES[0].id);

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

  return (
    <>
      <PageHeader title={software.addonLabel ?? 'Add-ons'}>
        <p className="mt-1 text-sm text-text-muted">
          {software.label} carrega {software.addonNoun === 'mod' ? 'mods' : 'plugins'} de{' '}
          <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">{software.addonDirDisplay}</code>.
        </p>
      </PageHeader>

      {available.length > 1 && (
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

      {active && <active.Panel serverId={serverId} ctx={ctx} />}
    </>
  );
}
