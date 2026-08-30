import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { inviteSubuser, listPermissionCatalog, listSubusers, removeSubuser, updateSubuserPermissions } from './subusers.api';
import { ApiError } from '@/shared/api/client';
import { Alert, Avatar, Button, Card, CardBody, ConfirmDialog, EmptyState, Field, Input, LoadingRow, PageHeader } from '@/ui/primitives';

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
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {[...grouped.entries()].map(([groupKey, entries]) => (
        <div key={groupKey} className="space-y-1.5">
          <p className="text-xs font-semibold tracking-wide text-text-faint uppercase">{groupKey}</p>
          {entries.map((entry) => (
            <label key={entry.key} className="flex items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={selected.has(entry.key)}
                onChange={(e) => onChange(entry.key, e.target.checked)}
                className="h-4 w-4 rounded border-border-strong text-accent accent-accent"
              />
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
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

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

  async function handleConfirmRemove() {
    if (!removeTarget) return;
    setError(null);
    try {
      await removeSubuser(serverId, removeTarget);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível remover este usuário.');
    } finally {
      setRemoveTarget(null);
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
    <>
      <PageHeader title="Subusuários" subtitle="Convide pessoas e escolha exatamente o que cada uma pode fazer neste servidor." />

      <Card className="mb-6">
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="E-mail" htmlFor="invite-email" className="w-64">
              <Input id="invite-email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="amigo@exemplo.com" />
            </Field>
            <Button variant="primary" disabled={inviting || !email.trim()} onClick={() => void handleInvite()}>
              {inviting ? 'Convidando…' : 'Convidar'}
            </Button>
          </div>
          {catalog && (
            <PermissionChecklist
              catalog={catalog}
              selected={invitePerms}
              onChange={(key, checked) =>
                setInvitePerms((prev) => {
                  const next = new Set(prev);
                  if (checked) next.add(key);
                  else next.delete(key);
                  return next;
                })
              }
            />
          )}
        </CardBody>
      </Card>

      {error && <Alert className="mb-6">{error}</Alert>}
      {isError && <Alert className="mb-6">Não foi possível carregar os subusuários.</Alert>}

      {isLoading ? (
        <LoadingRow />
      ) : !subusers || subusers.length === 0 ? (
        <EmptyState icon={Users} title="Nenhum subusuário ainda" description="Convide alguém acima para compartilhar acesso a este servidor." />
      ) : (
        <div className="space-y-3">
          {subusers.map((s) => (
            <Card key={s.id}>
              <CardBody>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar name={s.user.username} email={s.user.email} size="sm" />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-text">{s.user.username}</p>
                      <p className="truncate text-xs text-text-faint">{s.user.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={() => startEditing(s.id, s.permissions)}>
                      Editar permissões
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setRemoveTarget(s.id)}>
                      Remover
                    </Button>
                  </div>
                </div>
                <p className="mt-3 flex flex-wrap gap-1.5">
                  {s.permissions.map((p) => (
                    <span key={p} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-text-muted">
                      {p}
                    </span>
                  ))}
                </p>
                {editingId === s.id && catalog && (
                  <div className="mt-4 border-t border-border pt-4">
                    <PermissionChecklist
                      catalog={catalog}
                      selected={editPerms}
                      onChange={(key, checked) =>
                        setEditPerms((prev) => {
                          const next = new Set(prev);
                          if (checked) next.add(key);
                          else next.delete(key);
                          return next;
                        })
                      }
                    />
                    <div className="mt-3 flex gap-2">
                      <Button variant="primary" size="sm" onClick={() => void saveEditing(s.id)}>
                        Salvar
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                        Cancelar
                      </Button>
                    </div>
                  </div>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        title="Remover subusuário"
        message="Remover o acesso deste usuário ao servidor?"
        confirmLabel="Remover"
        tone="danger"
        onConfirm={() => void handleConfirmRemove()}
        onCancel={() => setRemoveTarget(null)}
      />
    </>
  );
}
