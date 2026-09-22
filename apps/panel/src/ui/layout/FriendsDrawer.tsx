import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, UserPlus, UsersRound, X } from 'lucide-react';
import {
  acceptFriend,
  getFriends,
  removeFriend,
  requestFriend,
  searchCommunityUsers,
  type CommunityUser,
} from '@/features/community/community.api';
import { Alert, Button, Input, LoadingRow } from '@/ui/primitives';

function displayName(user: CommunityUser) {
  return [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username;
}

export function FriendsDrawer() {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const friends = useQuery({ queryKey: ['community', 'friends'], queryFn: getFriends });
  const results = useQuery({
    queryKey: ['community', 'users', submittedSearch],
    queryFn: () => searchCommunityUsers(submittedSearch),
    enabled: open && submittedSearch.length >= 2,
  });
  const mutation = useMutation({
    mutationFn: ({ action, id }: { action: 'request' | 'accept' | 'remove'; id: string }) =>
      action === 'request' ? requestFriend(id) : action === 'accept' ? acceptFriend(id) : removeFriend(id),
    onSuccess: () => Promise.all([
      client.invalidateQueries({ queryKey: ['community', 'friends'] }),
      client.invalidateQueries({ queryKey: ['community', 'users'] }),
      client.invalidateQueries({ queryKey: ['community', 'servers'] }),
    ]),
  });

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    const value = search.trim();
    if (value.length >= 2) setSubmittedSearch(value);
  }

  const incomingCount = friends.data?.incoming.length ?? 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Abrir amigos"
        title="Amigos"
        className="group relative flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-surface-2/55 text-text-muted shadow-xs transition-all hover:-translate-y-px hover:border-accent/35 hover:bg-accent/10 hover:text-accent-strong"
      >
        <UsersRound className="h-[18px] w-[18px]" aria-hidden="true" />
        {incomingCount > 0 && <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[0.65rem] font-bold text-accent-contrast">{incomingCount > 9 ? '9+' : incomingCount}</span>}
      </button>

      {open && (
        <div className="fixed inset-0 z-50" role="presentation">
          <button className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" aria-label="Fechar amigos" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-border bg-surface shadow-2xl" role="dialog" aria-modal="true" aria-label="Amigos">
            <header className="flex items-center justify-between border-b border-border px-5 py-4">
              <div className="flex items-center gap-2"><UsersRound className="h-5 w-5 text-accent-strong" /><div><h2 className="font-semibold text-text">Amigos</h2><p className="text-xs text-text-muted">{friends.data?.accepted.length ?? 0} na sua lista</p></div></div>
              <button onClick={() => setOpen(false)} aria-label="Fechar" className="rounded-lg p-2 text-text-muted hover:bg-surface-2 hover:text-text"><X className="h-5 w-5" /></button>
            </header>

            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
              {mutation.error && <Alert>{mutation.error.message}</Alert>}
              <div>
                <form onSubmit={submitSearch} className="flex gap-2">
                  <Input value={search} onChange={(event) => setSearch(event.target.value)} icon={Search} placeholder="Buscar nome ou usuário" minLength={2} />
                  <Button type="submit" variant="primary" disabled={search.trim().length < 2}>Buscar</Button>
                </form>
                {submittedSearch && <div className="mt-3 space-y-2">
                  {results.isLoading && <LoadingRow label="Buscando…" />}
                  {results.data?.map((person) => <div key={person.id} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2/45 px-3 py-3">
                    <div className="min-w-0"><p className="truncate text-sm font-medium text-text">{displayName(person)}</p><p className="text-xs text-text-muted">@{person.username}</p></div>
                    {!person.friendship ? <Button size="sm" onClick={() => mutation.mutate({ action: 'request', id: person.id })}><UserPlus className="h-4 w-4" />Adicionar</Button> : person.friendship.status === 'accepted' ? <span className="text-xs font-medium text-ok">Amigo</span> : person.friendship.direction === 'incoming' ? <Button size="sm" variant="primary" onClick={() => mutation.mutate({ action: 'accept', id: person.friendship!.id })}>Aceitar</Button> : <span className="text-xs text-text-muted">Enviado</span>}
                  </div>)}
                  {results.data?.length === 0 && <p className="py-3 text-sm text-text-muted">Nenhum usuário encontrado.</p>}
                </div>}
              </div>

              {friends.isLoading ? <LoadingRow label="Carregando amizades…" /> : <>
                {friends.data?.incoming.length ? <section><p className="mb-2 text-xs font-bold tracking-wider text-text-faint uppercase">Pedidos recebidos</p><div className="space-y-2">{friends.data.incoming.map((item) => <div key={item.id} className="rounded-lg border border-accent/25 bg-accent/5 p-3"><div className="mb-3"><p className="text-sm font-medium text-text">{displayName(item.user)}</p><p className="text-xs text-text-muted">@{item.user.username}</p></div><div className="flex gap-2"><Button size="sm" variant="primary" onClick={() => mutation.mutate({ action: 'accept', id: item.id })}>Aceitar</Button><Button size="sm" variant="ghost" onClick={() => mutation.mutate({ action: 'remove', id: item.id })}>Recusar</Button></div></div>)}</div></section> : null}
                <section><p className="mb-2 text-xs font-bold tracking-wider text-text-faint uppercase">Sua lista</p>{friends.data?.accepted.length ? <div className="space-y-2">{friends.data.accepted.map((item) => <div key={item.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-3"><div className="min-w-0"><p className="truncate text-sm font-medium text-text">{displayName(item.user)}</p><p className="text-xs text-text-muted">@{item.user.username}</p></div><button onClick={() => mutation.mutate({ action: 'remove', id: item.id })} title="Desfazer amizade" className="rounded p-2 text-text-faint hover:bg-fail-tint hover:text-fail"><X className="h-4 w-4" /></button></div>)}</div> : <p className="text-sm text-text-muted">Você ainda não adicionou amigos.</p>}</section>
                {friends.data?.outgoing.length ? <section><p className="mb-2 text-xs font-bold tracking-wider text-text-faint uppercase">Pedidos enviados</p>{friends.data.outgoing.map((item) => <div key={item.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-3"><div><p className="text-sm font-medium text-text">{displayName(item.user)}</p><p className="text-xs text-text-muted">Aguardando resposta</p></div><Button size="sm" variant="ghost" onClick={() => mutation.mutate({ action: 'remove', id: item.id })}>Cancelar</Button></div>)}</section> : null}
              </>}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
