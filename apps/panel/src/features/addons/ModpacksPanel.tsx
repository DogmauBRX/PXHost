import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarDays, Download, PackageOpen, Search } from 'lucide-react';
import { Alert, Badge, Button, EmptyState, Input, LoadingRow, Select } from '@/ui/primitives';
import type { AddonContext } from './addons.types';
import { ModpackDetailsModal } from './ModpackDetailsModal';
import { getModpackMetadata, searchModpacks, type ModpackSort, type ModpackSource, type ModpackSummary } from './modpacks.api';

const PAGE_SIZE = 20;

export function ModpacksPanel({ serverId, ctx }: { serverId: string; ctx: AddonContext }) {
  const [sourceTab, setSourceTab] = useState<'all' | ModpackSource>('all');
  const [draftQuery, setDraftQuery] = useState('');
  const [query, setQuery] = useState('');
  const [minecraftVersion, setMinecraftVersion] = useState('');
  const [loader, setLoader] = useState('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<ModpackSort>('relevance');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<{ source: ModpackSource; projectId: string } | null>(null);
  const source: ModpackSource = sourceTab === 'all' ? 'modrinth' : sourceTab;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(draftQuery.trim());
      setOffset(0);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [draftQuery]);

  const metadata = useQuery({
    queryKey: ['modpack-metadata', serverId, source],
    queryFn: () => getModpackMetadata(serverId, source),
    enabled: source === 'modrinth',
    staleTime: 60 * 60 * 1000,
  });
  const results = useQuery({
    queryKey: ['modpack-search', serverId, source, query, minecraftVersion, loader, category, sort, offset],
    queryFn: () => searchModpacks(serverId, source, { query, minecraftVersion, loader, category, sort, offset, limit: PAGE_SIZE }),
    enabled: source === 'modrinth',
    placeholderData: keepPreviousData,
  });
  const canInstall = ctx.server.role !== 'subuser' || ctx.permissions.includes('addons.install');

  function resetPage(setter: (value: string) => void, value: string) {
    setter(value);
    setOffset(0);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1 border-b border-border">
        {(['all', 'modrinth', 'curseforge'] as const).map((item) => {
          const disabled = item === 'curseforge';
          return (
            <button
              key={item}
              type="button"
              disabled={disabled}
              title={disabled ? 'Integração prevista para a Fase 3' : undefined}
              onClick={() => { setSourceTab(item); setOffset(0); }}
              className={`border-b-2 px-3 py-2 text-sm font-medium transition ${sourceTab === item ? 'border-accent text-accent-strong' : 'border-transparent text-text-muted hover:text-text'} disabled:cursor-not-allowed disabled:opacity-45`}
            >
              {item === 'all' ? 'Todos' : item === 'modrinth' ? 'Modrinth' : 'CurseForge · em breve'}
            </button>
          );
        })}
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(16rem,2fr)_repeat(4,minmax(8rem,1fr))]">
        <Input icon={Search} value={draftQuery} onChange={(e) => setDraftQuery(e.target.value)} placeholder="Pesquisar modpacks..." aria-label="Pesquisar modpacks" />
        <Select value={minecraftVersion} onChange={(e) => resetPage(setMinecraftVersion, e.target.value)} aria-label="Versão do Minecraft">
          <option value="">Todas as versões</option>
          {metadata.data?.minecraftVersions.map((value) => <option key={value} value={value}>{value}</option>)}
        </Select>
        <Select value={loader} onChange={(e) => resetPage(setLoader, e.target.value)} aria-label="Loader">
          <option value="">Todos os loaders</option>
          {metadata.data?.loaders.map((value) => <option key={value} value={value}>{loaderLabel(value)}</option>)}
        </Select>
        <Select value={category} onChange={(e) => resetPage(setCategory, e.target.value)} aria-label="Categoria">
          <option value="">Todas as categorias</option>
          {metadata.data?.categories.map((value) => <option key={value} value={value}>{categoryLabel(value)}</option>)}
        </Select>
        <Select value={sort} onChange={(e) => { setSort(e.target.value as ModpackSort); setOffset(0); }} aria-label="Ordenação">
          <option value="relevance">Relevância</option>
          <option value="popularity">Popularidade</option>
          <option value="downloads">Downloads</option>
          <option value="updated">Atualização</option>
        </Select>
      </div>

      {results.isError && <Alert title="Catálogo indisponível">O Modrinth está temporariamente indisponível. Tente novamente em instantes.</Alert>}
      {results.isLoading && <LoadingRow label="Buscando modpacks no Modrinth…" />}
      {!results.isLoading && !results.isError && results.data?.items.length === 0 && (
        <EmptyState icon={Search} title="Nenhum modpack encontrado" description="Tente remover um filtro ou pesquisar outro nome." />
      )}

      {results.data && results.data.items.length > 0 && (
        <>
          <div className="flex items-center justify-between text-xs text-text-faint">
            <span>{results.data.total.toLocaleString('pt-BR')} modpacks encontrados</span>
            {results.isFetching && <span>Atualizando…</span>}
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {results.data.items.map((item) => (
              <ModpackCard key={`${item.source}:${item.projectId}`} item={item} onDetails={() => setSelected({ source: item.source, projectId: item.projectId })} />
            ))}
          </div>
          <div className="flex items-center justify-center gap-2 pt-2">
            <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Anterior</Button>
            <span className="px-2 text-sm text-text-muted">Página {Math.floor(offset / PAGE_SIZE) + 1}</span>
            <Button disabled={offset + PAGE_SIZE >= results.data.total} onClick={() => setOffset(offset + PAGE_SIZE)}>Próxima</Button>
          </div>
        </>
      )}

      <ModpackDetailsModal
        serverId={serverId}
        source={selected?.source ?? 'modrinth'}
        projectId={selected?.projectId ?? null}
        serverMinecraftVersion={ctx.server.minecraftVersion}
        serverSoftware={ctx.software.kind}
        canInstall={canInstall}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

function ModpackCard({ item, onDetails }: { item: ModpackSummary; onDetails: () => void }) {
  const recentVersions = item.minecraftVersions.slice(-3).reverse();
  return (
    <article className="flex min-h-64 flex-col rounded-card border border-border bg-surface p-4 shadow-xs transition hover:border-border-strong">
      <div className="flex items-start gap-3">
        {item.icon ? <img src={item.icon} alt="" loading="lazy" className="h-14 w-14 shrink-0 rounded-xl object-cover" /> : <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-surface-2"><PackageOpen className="h-6 w-6 text-text-faint" /></div>}
        <div className="min-w-0 flex-1"><h3 className="truncate font-semibold text-text">{item.name}</h3><p className="truncate text-xs text-text-faint">{item.author ? `por ${item.author}` : 'Autor não informado'}</p><Badge>Modrinth</Badge></div>
      </div>
      <p className="mt-3 line-clamp-3 text-sm leading-5 text-text-muted">{item.description}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {item.loaders.slice(0, 3).map((value) => <Badge key={value}>{loaderLabel(value)}</Badge>)}
        {recentVersions.map((value) => <Badge key={value}>{value}</Badge>)}
      </div>
      <div className="mt-auto flex items-center gap-4 pt-4 text-xs text-text-faint">
        <span className="inline-flex items-center gap-1"><Download className="h-3.5 w-3.5" />{formatCount(item.downloads)}</span>
        <span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" />{new Date(item.updatedAt).toLocaleDateString('pt-BR')}</span>
      </div>
      <div className="mt-3 flex gap-2 border-t border-border pt-3"><Button size="sm" className="flex-1" onClick={onDetails}>Ver detalhes</Button><Button size="sm" variant="primary" className="flex-1" onClick={onDetails}>Instalar</Button></div>
    </article>
  );
}

function loaderLabel(value: string): string { return value === 'neoforge' ? 'NeoForge' : value.charAt(0).toUpperCase() + value.slice(1); }
function categoryLabel(value: string): string { return value.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' '); }
function formatCount(value: number): string { return new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(value); }
