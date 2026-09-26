import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarDays, Download, PackageOpen, Search } from 'lucide-react';
import { Alert, Badge, Button, EmptyState, Input, LoadingRow, Select } from '@/ui/primitives';
import type { AddonSourcePanelProps } from '../addons.types';
import { PluginDetailsModal } from '../PluginDetailsModal';
import { searchPlugins, type PluginSort, type PluginSummary } from '../plugins.api';

const PAGE_SIZE = 20;

export function ModrinthPluginsPanel({ serverId, ctx }: AddonSourcePanelProps) {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<PluginSort>('downloads');
  const [offset, setOffset] = useState(0);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(draft.trim());
      setOffset(0);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const results = useQuery({
    queryKey: ['modrinth-plugins', serverId, query, sort, offset],
    queryFn: () => searchPlugins(serverId, query, sort, offset),
    placeholderData: keepPreviousData,
  });
  const canInstall = ctx.server.role !== 'subuser' || ctx.permissions.includes('addons.install');

  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-card border border-border bg-surface p-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <Input icon={Search} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Pesquisar plugins no Modrinth..." aria-label="Pesquisar plugins no Modrinth" />
        <Select value={sort} onChange={(event) => { setSort(event.target.value as PluginSort); setOffset(0); }} aria-label="Ordenação">
          <option value="relevance">Relevância</option>
          <option value="downloads">Downloads</option>
          <option value="popularity">Popularidade</option>
          <option value="updated">Atualização</option>
        </Select>
      </div>

      {results.isLoading && <LoadingRow label="Buscando plugins no Modrinth…" />}
      {results.isError && <Alert title="Catálogo indisponível">Não foi possível consultar o Modrinth agora.</Alert>}
      {!results.isLoading && !results.isError && results.data?.items.length === 0 && (
        <EmptyState icon={PackageOpen} title="Nenhum plugin encontrado" description="Tente outro nome ou altere a ordenação." />
      )}

      {results.data && results.data.items.length > 0 && (
        <>
          <div className="flex items-center justify-between text-xs text-text-faint">
            <span>{results.data.total.toLocaleString('pt-BR')} plugins compatíveis encontrados</span>
            {results.isFetching && <span>Atualizando…</span>}
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {results.data.items.map((plugin) => (
              <PluginCard key={plugin.projectId} plugin={plugin} softwareLabel={ctx.software.label} onDetails={() => setSelectedProjectId(plugin.projectId)} />
            ))}
          </div>
          <div className="flex items-center justify-center gap-2 pt-2">
            <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Anterior</Button>
            <span className="px-2 text-sm text-text-muted">Página {Math.floor(offset / PAGE_SIZE) + 1} de {Math.ceil(results.data.total / PAGE_SIZE)}</span>
            <Button disabled={offset + PAGE_SIZE >= results.data.total} onClick={() => setOffset(offset + PAGE_SIZE)}>Próxima</Button>
          </div>
        </>
      )}

      <PluginDetailsModal
        serverId={serverId}
        projectId={selectedProjectId}
        softwareLabel={ctx.software.label}
        minecraftVersion={ctx.server.minecraftVersion}
        canInstall={canInstall}
        onClose={() => setSelectedProjectId(null)}
      />
    </div>
  );
}

function PluginCard({ plugin, softwareLabel, onDetails }: { plugin: PluginSummary; softwareLabel: string; onDetails: () => void }) {
  const recentVersions = plugin.minecraftVersions.slice(-3).reverse();
  return (
    <article className="flex min-h-64 flex-col rounded-card border border-border bg-surface p-4 shadow-xs transition hover:border-border-strong">
      <div className="flex items-start gap-3">
        {plugin.icon ? (
          <img src={plugin.icon} alt="" loading="lazy" className="h-14 w-14 shrink-0 rounded-xl object-cover" />
        ) : (
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-surface-2"><PackageOpen className="h-6 w-6 text-text-faint" /></div>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-text">{plugin.name}</h3>
          <p className="truncate text-xs text-text-faint">{plugin.author ? `por ${plugin.author}` : 'Autor não informado'}</p>
          <Badge>Modrinth</Badge>
        </div>
      </div>
      <p className="mt-3 line-clamp-3 text-sm leading-5 text-text-muted">{plugin.description}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge tone="ok">Compatível com {softwareLabel}</Badge>
        {recentVersions.map((version) => <Badge key={version}>{version}</Badge>)}
      </div>
      <div className="mt-auto flex items-center gap-4 pt-4 text-xs text-text-faint">
        <span className="inline-flex items-center gap-1"><Download className="h-3.5 w-3.5" />{formatCount(plugin.downloads)}</span>
        <span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" />{new Date(plugin.updatedAt).toLocaleDateString('pt-BR')}</span>
      </div>
      <div className="mt-3 flex gap-2 border-t border-border pt-3">
        <Button size="sm" className="flex-1" onClick={onDetails}>Ver detalhes</Button>
        <Button size="sm" variant="primary" className="flex-1" onClick={onDetails}>Instalar</Button>
      </div>
    </article>
  );
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}
