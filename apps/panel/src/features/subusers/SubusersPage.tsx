import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { inviteSubuser, listPermissionCatalog, listSubusers, removeSubuser, updateSubuserPermissions } from './subusers.api';
import { Button } from '@/ui/primitives/Button';
import { ApiError } from '@/shared/api/client';

function groupByGroupKey<T extends { groupKey: string }>(entries: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const entry of entries) {
    const list = map.get(entry.groupKey) ?? [];
    list.push(entry);
    map.set(entry.groupKey, list);
  }
  return map;
}

function PermissionChecklist({
  catalog,
  selected,
  onChange,
}: {
  catalog: { key: string; groupKey: string; isDangerous: boolean }[];
  selected: Set<string>;
  onChange: (key: string, checked: boolean) => void;
}) {
  const grouped = groupByGroupKey(catalog);
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {[...grouped.entries()].map(([groupKey, entries]) => (
        <div key={groupKey} className="space-y-1">
          <p className="text-xs font-medium uppercase text-text-faint">{groupKey}</p>
          {entries.map((entry) => (
            <label key={entry.key} className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" checked={selected.has(entry.key)} onChange={(e) => onChange(entry.key, e.target.checked)} />
              <span className={entry.isDangerous ? 'text-fail' : undefined}>{entry.key}</span>
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}

export function SubusersPage({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const { data: subusers, isLoading, isError } = useQuery({ queryKey: ['subusers', serverId], queryFn: () => listSubusers(serverId) });
  const { data: catalog } = useQuery({ queryKey: ['permission-catalog'], queryFn: listPermissionCatalog });

  const [email, setEmail] = useState('');
  const [invitePerms, setInvitePerms] = useState<Set<string>>(new Set());
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPerms, setEditPerms] = useState<Set<string>>(new Set());

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['subusers', serverId] });
  }

  async function handleInvite() {
    if (!email.trim()) return;
    setInviting(true);
    setError(null);
    try {
      await inviteSubuser(serverId, email.trim(), [...invitePerms]);
      setEmail('');
      setInvitePerms(new Set());
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível convidar este usuário.');
    } finally {
      setInviting(false);
    }
  }

  async function handleRemove(id: string) {
    if (!window.confirm('Remover o acesso deste usuário ao servidor?')) return;
    setError(null);
    try {
      await removeSubuser(serverId, id);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível remover este usuário.');
    }
  }

  function startEditing(id: string, current: string[]) {
    setEditingId(id);
    setEditPerms(new Set(current));
  }

  async function saveEditing(id: string) {
    setError(null);
    try {
      await updateSubuserPermissions(serverId, id, [...editPerms]);
      setEditingId(null);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível atualizar as permissões.');
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <h1 className="font-medium text-text">Subusuários</h1>

      <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
        <p className="text-sm text-text-muted">Convide alguém pelo e-mail (precisa já ter uma conta) e escolha exatamente o que essa pessoa pode fazer neste servidor.</p>
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-muted">E-mail</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="amigo@exemplo.com" className="w-64 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent" />
          </div>
          <Button variant="primary" disabled={inviting} onClick={() => void handleInvite()}>
            {inviting ? 'Convidando…' : 'Convidar'}
          </Button>
        </div>
        {catalog && <PermissionChecklist catalog={catalog} selected={invitePerms} onChange={(key, checked) => setInvitePerms((prev) => { const next = new Set(prev); if (checked) next.add(key); else next.delete(key); return next; })} />}
      </div>

      {error && <p className="rounded-md bg-fail-tint px-3 py-2 text-sm text-fail">{error}</p>}

      <div className="min-h-0 flex-1 space-y-3 overflow-auto">
        {isLoading && <p className="text-sm text-text-muted">Carregando…</p>}
        {isError && <p className="text-sm text-fail">Não foi possível carregar os subusuários.</p>}
        {subusers && subusers.length === 0 && <p className="text-sm text-text-muted">Nenhum subusuário ainda.</p>}
        {subusers?.map((s) => (
          <div key={s.id} className="rounded-lg border border-border bg-surface p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-text">{s.user.username}</p>
                <p className="text-xs text-text-faint">{s.user.email}</p>
                <p className="mt-1 flex flex-wrap gap-1">
                  {s.permissions.map((p) => (
                    <span key={p} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-text-muted">
                      {p}
                    </span>
                  ))}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="secondary" onClick={() => startEditing(s.id, s.permissions)}>
                  Editar permissões
                </Button>
                <Button variant="ghost" onClick={() => void handleRemove(s.id)}>
                  Remover
                </Button>
              </div>
            </div>
            {editingId === s.id && catalog && (
              <div className="mt-3 border-t border-border pt-3">
                <PermissionChecklist catalog={catalog} selected={editPerms} onChange={(key, checked) => setEditPerms((prev) => { const next = new Set(prev); if (checked) next.add(key); else next.delete(key); return next; })} />
                <div className="mt-2 flex gap-2">
                  <Button variant="primary" onClick={() => void saveEditing(s.id)}>
                    Salvar
                  </Button>
                  <Button variant="ghost" onClick={() => setEditingId(null)}>
                    Cancelar
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
