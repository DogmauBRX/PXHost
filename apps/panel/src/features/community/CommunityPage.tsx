import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Gamepad2, Search, Server, UserPlus, Users, X } from 'lucide-react';
import {
  acceptFriend,
  getCommunityServers,
  getFriends,
  getPublishableServers,
  publishServer,
  removeFriend,
  requestFriend,
  searchCommunityUsers,
  unpublishServer,
  type CommunityUser,
} from './community.api';
import { Alert, Button, Card, CardBody, EmptyState, Input, LoadingRow, PageHeader, Textarea } from '@/ui/primitives';

function displayName(user: CommunityUser) {
  return [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username;
}

export function CommunityPage() {
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const friends = useQuery({ queryKey: ['community', 'friends'], queryFn: getFriends });
  const directory = useQuery({ queryKey: ['community', 'servers'], queryFn: getCommunityServers });
  const myServers = useQuery({ queryKey: ['community', 'my-servers'], queryFn: getPublishableServers });
  const results = useQuery({
    queryKey: ['community', 'users', submittedSearch],
    queryFn: () => searchCommunityUsers(submittedSearch),
    enabled: submittedSearch.length >= 2,
  });

  const refreshSocial = () => Promise.all([
    client.invalidateQueries({ queryKey: ['community', 'friends'] }),
    client.invalidateQueries({ queryKey: ['community', 'users'] }),
    client.invalidateQueries({ queryKey: ['community', 'servers'] }),
  ]);
  const friendMutation = useMutation({
    mutationFn: ({ action, id }: { action: 'request' | 'accept' | 'remove'; id: string }) =>
      action === 'request' ? requestFriend(id) : action === 'accept' ? acceptFriend(id) : removeFriend(id),
    onSuccess: refreshSocial,
  });
  const listingMutation = useMutation({
    mutationFn: ({ action, id, description }: { action: 'publish' | 'remove'; id: string; description?: string }) =>
      action === 'publish' ? publishServer(id, description ?? '') : unpublishServer(id),
    onSuccess: () => Promise.all([
      client.invalidateQueries({ queryKey: ['community', 'servers'] }),
      client.invalidateQueries({ queryKey: ['community', 'my-servers'] }),
    ]),
  });

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    const value = search.trim();
    if (value.length >= 2) setSubmittedSearch(value);
  }

  async function copyAddress(id: string, address: string) {
    await navigator.clipboard.writeText(address);
    setCopied(id);
    setTimeout(() => setCopied((current) => (current === id ? null : current)), 1800);
  }

  const mutationError = friendMutation.error || listingMutation.error;

  return (
    <div className="space-y-6">
      <PageHeader title="Comunidade" subtitle="Encontre amigos e compartilhe o endereço público do seu servidor dentro da GXHost." />
      {mutationError && <Alert>{mutationError.message}</Alert>}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
        <div className="space-y-6">
          <Card>
            <CardBody>
              <div className="mb-4 flex items-center gap-2">
                <Users className="h-5 w-5 text-accent-strong" />
                <h2 className="font-semibold text-text">Amigos</h2>
              </div>
              <form onSubmit={submitSearch} className="flex gap-2">
                <Input value={search} onChange={(event) => setSearch(event.target.value)} icon={Search} placeholder="Buscar por nome ou usuário" minLength={2} />
                <Button type="submit" variant="primary" disabled={search.trim().length < 2}>Buscar</Button>
              </form>

              {submittedSearch && (
                <div className="mt-4 space-y-2">
                  {results.isLoading && <LoadingRow label="Buscando usuários…" />}
                  {results.data?.map((person) => (
                    <div key={person.id} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2/45 px-4 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text">{displayName(person)}</p>
                        <p className="text-xs text-text-muted">@{person.username}</p>
                      </div>
                      {!person.friendship ? (
                        <Button size="sm" onClick={() => friendMutation.mutate({ action: 'request', id: person.id })}><UserPlus className="h-4 w-4" />Adicionar</Button>
                      ) : person.friendship.status === 'accepted' ? (
                        <span className="text-xs font-medium text-ok">Amigo</span>
                      ) : person.friendship.direction === 'incoming' ? (
                        <Button size="sm" variant="primary" onClick={() => friendMutation.mutate({ action: 'accept', id: person.friendship!.id })}>Aceitar</Button>
                      ) : <span className="text-xs text-text-muted">Pedido enviado</span>}
                    </div>
                  ))}
                  {results.data?.length === 0 && <p className="py-4 text-sm text-text-muted">Nenhum usuário encontrado.</p>}
                </div>
              )}

              {friends.isLoading ? <LoadingRow label="Carregando amizades…" /> : (
                <div className="mt-6 space-y-5">
                  {friends.data?.incoming.length ? (
                    <div>
                      <p className="mb-2 text-xs font-bold tracking-wider text-text-faint uppercase">Pedidos recebidos</p>
                      <div className="space-y-2">{friends.data.incoming.map((item) => (
                        <div key={item.id} className="flex items-center justify-between rounded-lg border border-accent/25 bg-accent/5 px-4 py-3">
                          <div><p className="text-sm font-medium text-text">{displayName(item.user)}</p><p className="text-xs text-text-muted">@{item.user.username}</p></div>
                          <div className="flex gap-2"><Button size="sm" variant="primary" onClick={() => friendMutation.mutate({ action: 'accept', id: item.id })}>Aceitar</Button><Button size="sm" variant="ghost" onClick={() => friendMutation.mutate({ action: 'remove', id: item.id })}>Recusar</Button></div>
                        </div>
                      ))}</div>
                    </div>
                  ) : null}
                  <div>
                    <p className="mb-2 text-xs font-bold tracking-wider text-text-faint uppercase">Sua lista</p>
                    {friends.data?.accepted.length ? <div className="grid gap-2 sm:grid-cols-2">{friends.data.accepted.map((item) => (
                      <div key={item.id} className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                        <div className="min-w-0"><p className="truncate text-sm font-medium text-text">{displayName(item.user)}</p><p className="text-xs text-text-muted">@{item.user.username}</p></div>
                        <button onClick={() => friendMutation.mutate({ action: 'remove', id: item.id })} title="Desfazer amizade" className="rounded p-2 text-text-faint hover:bg-fail-tint hover:text-fail"><X className="h-4 w-4" /></button>
                      </div>
                    ))}</div> : <p className="text-sm text-text-muted">Você ainda não adicionou amigos.</p>}
                  </div>
                  {friends.data?.outgoing.length ? <p className="text-xs text-text-muted">{friends.data.outgoing.length} pedido(s) aguardando resposta.</p> : null}
                </div>
              )}
            </CardBody>
          </Card>

          <section>
            <div className="mb-3"><h2 className="font-semibold text-text">Servidores da comunidade</h2><p className="text-sm text-text-muted">Somente endereços publicados voluntariamente pelos proprietários.</p></div>
            {directory.isLoading ? <LoadingRow /> : directory.data?.length ? (
              <div className="grid gap-4 sm:grid-cols-2">{directory.data.map((listing) => (
                <Card key={listing.id}><CardBody className="space-y-3">
                  <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-text">{listing.name}</h3><p className="text-xs text-text-muted">por @{listing.owner.username}{listing.isFriend ? ' · amigo' : ''}</p></div><Gamepad2 className="h-5 w-5 text-accent-strong" /></div>
                  {listing.description && <p className="text-sm text-text-muted">{listing.description}</p>}
                  <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2"><code className="truncate text-xs text-text">{listing.address}</code><button onClick={() => void copyAddress(listing.id, listing.address)} className="text-text-muted hover:text-text">{copied === listing.id ? <Check className="h-4 w-4 text-ok" /> : <Copy className="h-4 w-4" />}</button></div>
                  {(listing.software || listing.version) && <p className="text-xs text-text-faint">{[listing.software, listing.version].filter(Boolean).join(' · ')}</p>}
                </CardBody></Card>
              ))}</div>
            ) : <EmptyState icon={Gamepad2} title="Nenhum servidor publicado" description="Os servidores compartilhados pela comunidade aparecerão aqui." />}
          </section>
        </div>

        <aside>
          <Card className="sticky top-20"><CardBody>
            <div className="mb-4 flex items-center gap-2"><Server className="h-5 w-5 text-accent-strong" /><h2 className="font-semibold text-text">Publicar meu servidor</h2></div>
            <p className="mb-4 text-sm text-text-muted">A publicação mostra apenas o endereço público. Dados internos e controles do painel continuam privados.</p>
            {myServers.isLoading ? <LoadingRow /> : <div className="space-y-4">{myServers.data?.map((server) => (
              <div key={server.id} className="rounded-lg border border-border p-4">
                <div className="mb-2 flex items-center justify-between gap-2"><p className="font-medium text-text">{server.name}</p>{server.published && <span className="text-xs font-medium text-ok">Publicado</span>}</div>
                {server.publicAddress ? <><p className="mb-3 truncate font-mono text-xs text-text-muted">{server.publicAddress}</p><Textarea rows={3} maxLength={280} value={descriptions[server.id] ?? server.description} onChange={(event) => setDescriptions((current) => ({ ...current, [server.id]: event.target.value }))} placeholder="Uma breve descrição para a comunidade" /><div className="mt-3 flex gap-2"><Button size="sm" variant="primary" onClick={() => listingMutation.mutate({ action: 'publish', id: server.id, description: descriptions[server.id] ?? server.description })}>{server.published ? 'Atualizar' : 'Publicar'}</Button>{server.published && <Button size="sm" variant="ghost" onClick={() => listingMutation.mutate({ action: 'remove', id: server.id })}>Retirar</Button>}</div></> : <p className="text-xs text-warn">Este servidor precisa de um endereço público ativo antes de ser publicado.</p>}
              </div>
            ))}{myServers.data?.length === 0 && <p className="text-sm text-text-muted">Você ainda não possui servidores.</p>}</div>}
          </CardBody></Card>
        </aside>
      </div>
    </div>
  );
}
