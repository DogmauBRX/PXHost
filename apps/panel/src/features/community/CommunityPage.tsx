import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Download, Gamepad2, Info, Server } from 'lucide-react';
import {
  downloadCommunityClientFiles,
  getCommunityServers,
  getCommunityServerDetails,
  getPublishableServers,
  publishServer,
  unpublishServer,
} from './community.api';
import { Alert, Button, Card, CardBody, EmptyState, LoadingRow, Modal, PageHeader, Select, Textarea } from '@/ui/primitives';

export function CommunityPage() {
  const client = useQueryClient();
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [selectedServerId, setSelectedServerId] = useState('');
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const directory = useQuery({ queryKey: ['community', 'servers'], queryFn: getCommunityServers });
  const myServers = useQuery({ queryKey: ['community', 'my-servers'], queryFn: getPublishableServers });
  const details = useQuery({
    queryKey: ['community', 'server-details', detailsId],
    queryFn: () => getCommunityServerDetails(detailsId!),
    enabled: Boolean(detailsId),
  });

  const listingMutation = useMutation({
    mutationFn: ({ action, id, description }: { action: 'publish' | 'remove'; id: string; description?: string }) =>
      action === 'publish' ? publishServer(id, description ?? '') : unpublishServer(id),
    onSuccess: () => Promise.all([
      client.invalidateQueries({ queryKey: ['community', 'servers'] }),
      client.invalidateQueries({ queryKey: ['community', 'my-servers'] }),
    ]),
  });

  async function copyAddress(id: string, address: string) {
    await navigator.clipboard.writeText(address);
    setCopied(id);
    setTimeout(() => setCopied((current) => (current === id ? null : current)), 1800);
  }

  async function downloadClientFiles() {
    if (!detailsId) return;
    setDownloadError(null);
    try {
      const download = await downloadCommunityClientFiles(detailsId);
      const anchor = document.createElement('a');
      anchor.href = download.url;
      anchor.download = download.filename;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : 'Não foi possível preparar os arquivos.');
    }
  }

  const mutationError = listingMutation.error;

  return (
    <div className="space-y-6">
      <PageHeader title="Comunidade" subtitle="Descubra servidores e compartilhe o endereço público do seu servidor dentro da GXHost." />
      {mutationError && <Alert>{mutationError.message}</Alert>}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
        <div className="space-y-6">
          <section>
            <div className="mb-3"><h2 className="font-semibold text-text">Servidores da comunidade</h2><p className="text-sm text-text-muted">Somente endereços publicados voluntariamente pelos proprietários.</p></div>
            {directory.isLoading ? <LoadingRow /> : directory.data?.length ? (
              <div className="grid gap-4 sm:grid-cols-2">{directory.data.map((listing) => (
                <Card key={listing.id}><CardBody className="space-y-3">
                  <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-text">{listing.name}</h3><p className="text-xs text-text-muted">por @{listing.owner.username}{listing.isFriend ? ' · amigo' : ''}</p></div><Gamepad2 className="h-5 w-5 text-accent-strong" /></div>
                  {listing.description && <p className="text-sm text-text-muted">{listing.description}</p>}
                  <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2"><code className="truncate text-xs text-text">{listing.address}</code><button onClick={() => void copyAddress(listing.id, listing.address)} className="text-text-muted hover:text-text">{copied === listing.id ? <Check className="h-4 w-4 text-ok" /> : <Copy className="h-4 w-4" />}</button></div>
                  {(listing.software || listing.version) && <p className="text-xs text-text-faint">{[listing.software, listing.version].filter(Boolean).join(' · ')}</p>}
                  <Button size="sm" onClick={() => setDetailsId(listing.id)}><Info className="h-4 w-4" />Detalhes</Button>
                </CardBody></Card>
              ))}</div>
            ) : <EmptyState icon={Gamepad2} title="Nenhum servidor publicado" description="Os servidores compartilhados pela comunidade aparecerão aqui." />}
          </section>
        </div>

        <aside>
          <Card className="sticky top-20"><CardBody>
            <div className="mb-4 flex items-center gap-2"><Server className="h-5 w-5 text-accent-strong" /><h2 className="font-semibold text-text">Publicar meu servidor</h2></div>
            <p className="mb-4 text-sm text-text-muted">A publicação mostra apenas o endereço público. Dados internos e controles do painel continuam privados.</p>
            {myServers.isLoading ? <LoadingRow /> : myServers.data?.length ? (() => {
              const selected = myServers.data.find((server) => server.id === selectedServerId) ?? myServers.data[0];
              return <div className="space-y-4">
                <Select value={selected.id} onChange={(event) => setSelectedServerId(event.target.value)} aria-label="Selecionar servidor">
                  {myServers.data.map((server) => <option key={server.id} value={server.id}>{server.name}{server.published ? ' · publicado' : ''}</option>)}
                </Select>
                <div className="rounded-lg border border-border p-4">
                  <div className="mb-2 flex items-center justify-between gap-2"><p className="font-medium text-text">{selected.name}</p>{selected.published && <span className="text-xs font-medium text-ok">Publicado</span>}</div>
                  {selected.publicAddress ? <><p className="mb-3 truncate font-mono text-xs text-text-muted">{selected.publicAddress}</p><Textarea rows={3} maxLength={280} value={descriptions[selected.id] ?? selected.description} onChange={(event) => setDescriptions((current) => ({ ...current, [selected.id]: event.target.value }))} placeholder="Uma breve descrição para a comunidade" /><div className="mt-3 flex gap-2"><Button size="sm" variant="primary" onClick={() => listingMutation.mutate({ action: 'publish', id: selected.id, description: descriptions[selected.id] ?? selected.description })}>{selected.published ? 'Atualizar' : 'Publicar'}</Button>{selected.published && <Button size="sm" variant="ghost" onClick={() => listingMutation.mutate({ action: 'remove', id: selected.id })}>Retirar</Button>}</div></> : <p className="text-xs text-warn">Este servidor precisa de um endereço público ativo antes de ser publicado.</p>}
                </div>
              </div>;
            })() : <p className="text-sm text-text-muted">Você ainda não possui servidores.</p>}
          </CardBody></Card>
        </aside>
      </div>

      <Modal open={Boolean(detailsId)} onClose={() => { setDetailsId(null); setDownloadError(null); }} title={details.data?.name ?? 'Detalhes do servidor'} description={details.data ? `Publicado por @${details.data.owner.username}` : undefined} footer={
        <><Button variant="ghost" onClick={() => setDetailsId(null)}>Fechar</Button><Button variant="primary" onClick={() => void downloadClientFiles()} disabled={!details.data}><Download className="h-4 w-4" />Baixar arquivos para jogar</Button></>
      }>
        {details.isLoading ? <LoadingRow /> : details.isError ? <Alert>Não foi possível carregar os detalhes.</Alert> : details.data && <div className="space-y-4">
          {downloadError && <Alert>{downloadError}</Alert>}
          <div className="rounded-lg border border-border bg-surface-2/45 p-4"><p className="text-xs font-bold tracking-wider text-text-faint uppercase">Endereço</p><code className="mt-1 block break-all text-sm text-text">{details.data.address}</code></div>
          {details.data.description && <p className="text-sm text-text-muted">{details.data.description}</p>}
          <div><p className="mb-2 text-xs font-bold tracking-wider text-text-faint uppercase">Modpack instalado pela GXHost</p>{details.data.modpack ? <div className="rounded-lg border border-border p-4"><p className="font-medium text-text">{details.data.modpack.projectName}</p><p className="mt-1 text-sm text-text-muted">Versão {details.data.modpack.versionName} · Minecraft {details.data.modpack.minecraftVersion} · {details.data.modpack.loader}</p>{details.data.modpack.source === 'modrinth' && <a className="mt-3 inline-flex text-sm font-medium text-accent-strong hover:underline" href={`https://modrinth.com/modpack/${details.data.modpack.projectId}`} target="_blank" rel="noreferrer">Ver no Modrinth</a>}</div> : <p className="text-sm text-text-muted">Nenhum modpack instalado pela plataforma foi identificado.</p>}</div>
          <Alert tone="info">O download contém a pasta de mods atual do servidor, incluindo arquivos adicionais que podem não fazer parte do modpack original. Extraia-a na instância correspondente do seu launcher.</Alert>
        </div>}
      </Modal>
    </div>
  );
}
