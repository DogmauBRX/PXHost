import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, PackageOpen, Search } from 'lucide-react';
import { apiFetch, ApiError } from '@/shared/api/client';
import { Alert, Badge, Button, EmptyState, Input, LoadingRow } from '@/ui/primitives';
import type { AddonSourcePanelProps } from '../addons.types';

type Plugin = { projectId: string; name: string; author: string | null; icon: string | null; description: string; downloads: number; minecraftVersions: string[]; loaders: string[] };
type SearchResult = { items: Plugin[]; total: number; offset: number; limit: number };

export function ModrinthPluginsPanel({ serverId, ctx }: AddonSourcePanelProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { const timer = window.setTimeout(() => setQuery(draft.trim()), 300); return () => window.clearTimeout(timer); }, [draft]);
  const results = useQuery({ queryKey: ['modrinth-plugins', serverId, query], queryFn: () => apiFetch<SearchResult>(`/api/client/servers/${serverId}/plugins/modrinth/search?query=${encodeURIComponent(query)}`) });
  const install = useMutation({
    mutationFn: (projectId: string) => apiFetch<{ message: string }>(`/api/client/servers/${serverId}/plugins/modrinth/install`, { method: 'POST', body: JSON.stringify({ projectId }) }),
    onSuccess: (data) => { setNotice(data.message); void queryClient.invalidateQueries({ queryKey: ['files', serverId, 'plugins'] }); },
  });
  const canInstall = ctx.permissions.includes('addons.install');
  return <div className="space-y-4">
    <div className="rounded-card border border-border bg-surface p-4"><Input icon={Search} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Pesquisar plugins no Modrinth..." aria-label="Pesquisar plugins no Modrinth" /></div>
    {notice && <Alert tone="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}
    {install.error && <Alert>{install.error instanceof ApiError ? install.error.message : 'Não foi possível instalar o plugin.'}</Alert>}
    {results.isLoading && <LoadingRow label="Buscando plugins no Modrinth…" />}
    {results.isError && <Alert>Não foi possível consultar o Modrinth agora.</Alert>}
    {results.data?.items.length === 0 && <EmptyState icon={PackageOpen} title="Nenhum plugin encontrado" description="Tente outro nome." />}
    {results.data && results.data.items.length > 0 && <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{results.data.items.map((plugin) => <article key={plugin.projectId} className="flex min-h-56 flex-col rounded-card border border-border bg-surface p-4 shadow-xs"><div className="flex gap-3">{plugin.icon ? <img src={plugin.icon} alt="" className="h-12 w-12 rounded-xl object-cover" /> : <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-2"><PackageOpen className="h-5 w-5 text-text-faint" /></div>}<div className="min-w-0"><h3 className="truncate font-semibold">{plugin.name}</h3><p className="truncate text-xs text-text-faint">{plugin.author ? `por ${plugin.author}` : 'Autor não informado'}</p><Badge>Modrinth</Badge></div></div><p className="mt-3 line-clamp-3 text-sm text-text-muted">{plugin.description}</p><div className="mt-3 flex flex-wrap gap-1">{plugin.loaders.slice(0, 3).map((loader) => <Badge key={loader}>{loader}</Badge>)}</div><div className="mt-auto flex items-center justify-between gap-3 pt-4"><span className="inline-flex items-center gap-1 text-xs text-text-faint"><Download className="h-3.5 w-3.5" />{new Intl.NumberFormat('pt-BR', { notation: 'compact' }).format(plugin.downloads)}</span><Button size="sm" variant="primary" disabled={!canInstall || install.isPending} onClick={() => install.mutate(plugin.projectId)}>{install.isPending && install.variables === plugin.projectId ? 'Instalando…' : 'Instalar'}</Button></div></article>)}</div>}
  </div>;
}
