import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Plus, Search, ShieldCheck, Users } from 'lucide-react';
import { blockUser, createUser, listUsers, unblockUser, updateUser } from './admin.api';
import { ApiError } from '@/shared/api/client';
import type { AdminUserSummary } from '@/shared/api/types';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  LoadingRow,
  Modal,
  PageHeader,
  Select,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableWrap,
} from '@/ui/primitives';

const PAGE_SIZE = 25;

const ROLE_LABEL: Record<string, string> = {
  user: 'Cliente',
  support: 'Suporte',
  admin: 'Administrador',
  root_admin: 'Root',
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

interface UserFormValues {
  email: string;
  username: string;
  password: string;
  firstName: string;
  lastName: string;
  globalRole: string;
}

const EMPTY_FORM: UserFormValues = { email: '', username: '', password: '', firstName: '', lastName: '', globalRole: 'user' };

function userToForm(u: AdminUserSummary): UserFormValues {
  return { email: u.email, username: u.username, password: '', firstName: u.firstName ?? '', lastName: u.lastName ?? '', globalRole: u.globalRole };
}

function UserFormModal({
  open,
  title,
  initial,
  requirePassword,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  initial: UserFormValues;
  requirePassword: boolean;
  onSubmit: (values: UserFormValues) => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<UserFormValues>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setValues(initial);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const valid = values.email.trim() && values.username.trim() && (!requirePassword || values.password.trim().length >= 8);

  async function handleSave() {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(values);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar o cliente.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={title} size="md">
      {error && (
        <Alert className="mb-4" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="E-mail" htmlFor="user-email" required>
          <Input id="user-email" type="email" value={values.email} onChange={(e) => setValues((v) => ({ ...v, email: e.target.value }))} />
        </Field>
        <Field label="Nome de usuário" htmlFor="user-username" required>
          <Input id="user-username" value={values.username} onChange={(e) => setValues((v) => ({ ...v, username: e.target.value }))} />
        </Field>
        <Field label="Nome" htmlFor="user-first">
          <Input id="user-first" value={values.firstName} onChange={(e) => setValues((v) => ({ ...v, firstName: e.target.value }))} />
        </Field>
        <Field label="Sobrenome" htmlFor="user-last">
          <Input id="user-last" value={values.lastName} onChange={(e) => setValues((v) => ({ ...v, lastName: e.target.value }))} />
        </Field>
        <Field label="Papel" htmlFor="user-role">
          <Select id="user-role" value={values.globalRole} onChange={(e) => setValues((v) => ({ ...v, globalRole: e.target.value }))}>
            <option value="user">Cliente</option>
            <option value="support">Suporte</option>
            <option value="admin">Administrador</option>
            <option value="root_admin">Root</option>
          </Select>
        </Field>
        <Field
          label={requirePassword ? 'Senha' : 'Nova senha'}
          htmlFor="user-password"
          required={requirePassword}
          hint={requirePassword ? 'Mínimo de 8 caracteres. O cliente pode trocá-la depois.' : 'Deixe em branco para não alterar (ainda não suportado).'}
        >
          <Input
            id="user-password"
            type="password"
            value={values.password}
            onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))}
            disabled={!requirePassword}
            autoComplete="new-password"
          />
        </Field>
      </div>
      <div className="mt-6 flex justify-end gap-2 border-t border-border pt-4">
        <Button variant="secondary" onClick={onClose}>
          Cancelar
        </Button>
        <Button variant="primary" disabled={!valid || saving} onClick={() => void handleSave()}>
          {saving ? 'Salvando…' : 'Salvar'}
        </Button>
      </div>
    </Modal>
  );
}

export function UsersPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<AdminUserSummary | null>(null);
  const [blockTarget, setBlockTarget] = useState<AdminUserSummary | null>(null);
  const [blockError, setBlockError] = useState<string | null>(null);
  const [blocking, setBlocking] = useState(false);

  const params = { q: query || undefined, role: role || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
  const { data, isPending, error } = useQuery({
    queryKey: ['admin', 'users', params],
    queryFn: () => listUsers(params),
    placeholderData: keepPreviousData,
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
  }

  function applySearch() {
    setPage(0);
    setQuery(search.trim());
  }

  async function handleCreate(values: UserFormValues) {
    await createUser({
      email: values.email.trim(),
      username: values.username.trim(),
      password: values.password,
      firstName: values.firstName.trim() || undefined,
      lastName: values.lastName.trim() || undefined,
      globalRole: values.globalRole,
    });
    setCreateOpen(false);
    refresh();
  }

  async function handleUpdate(values: UserFormValues) {
    if (!editing) return;
    await updateUser(editing.id, {
      email: values.email.trim(),
      username: values.username.trim(),
      firstName: values.firstName.trim() || undefined,
      lastName: values.lastName.trim() || undefined,
      globalRole: values.globalRole,
    });
    setEditing(null);
    refresh();
  }

  async function handleConfirmBlock() {
    if (!blockTarget) return;
    setBlocking(true);
    setBlockError(null);
    try {
      if (blockTarget.isActive) await blockUser(blockTarget.id);
      else await unblockUser(blockTarget.id);
      refresh();
    } catch (err) {
      setBlockError(err instanceof ApiError ? err.message : 'Não foi possível atualizar o status do cliente.');
    } finally {
      setBlocking(false);
      setBlockTarget(null);
    }
  }

  const total = data?.total ?? 0;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  return (
    <>
      <PageHeader
        title="Clientes"
        subtitle="Todas as contas cadastradas na plataforma."
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Novo Cliente
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-text-faint" aria-hidden="true" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applySearch()}
            placeholder="Buscar por nome ou e-mail…"
            className="pl-9"
            aria-label="Buscar clientes"
          />
        </div>
        <div className="w-48">
          <Select
            value={role}
            onChange={(e) => {
              setPage(0);
              setRole(e.target.value);
            }}
            aria-label="Filtrar por papel"
          >
            <option value="">Todos os papéis</option>
            <option value="user">Cliente</option>
            <option value="support">Suporte</option>
            <option value="admin">Administrador</option>
            <option value="root_admin">Root</option>
          </Select>
        </div>
        <Button variant="secondary" onClick={applySearch}>
          Buscar
        </Button>
      </div>

      {error && <Alert className="mb-4">Não foi possível carregar os clientes.</Alert>}
      {blockError && <Alert className="mb-4">{blockError}</Alert>}

      {isPending ? (
        <LoadingRow />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Nenhum cliente encontrado"
          description={query || role ? 'Tente ajustar a busca ou os filtros.' : 'Crie o primeiro acima.'}
        />
      ) : (
        <>
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>Cliente</TH>
                  <TH>Papel</TH>
                  <TH>Servidores</TH>
                  <TH>Status</TH>
                  <TH>Último acesso</TH>
                  <TH>Criado em</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {data.items.map((u) => (
                  <TR key={u.id}>
                    <TD>
                      <div className="flex items-center gap-3">
                        <Avatar name={u.username} email={u.email} size="sm" />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-text">{u.username}</p>
                          <p className="truncate text-xs text-text-muted">{u.email}</p>
                        </div>
                      </div>
                    </TD>
                    <TD>
                      <span className="text-text-muted">{ROLE_LABEL[u.globalRole] ?? u.globalRole}</span>
                    </TD>
                    <TD className="tabular-nums">{u.serverCount}</TD>
                    <TD>
                      <div className="flex items-center gap-1.5">
                        <Badge tone={u.isActive ? 'ok' : 'neutral'}>{u.isActive ? 'ativo' : 'inativo'}</Badge>
                        {u.twoFactorEnabled && (
                          <span title="Autenticação em dois fatores ativa">
                            <ShieldCheck className="h-4 w-4 text-ok" aria-label="2FA ativo" />
                          </span>
                        )}
                      </div>
                    </TD>
                    <TD className="text-text-muted">{formatDate(u.lastLoginAt)}</TD>
                    <TD className="text-text-muted">{formatDate(u.createdAt)}</TD>
                    <TD>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setEditing(u)}>
                          Editar
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setBlockTarget(u)}>
                          {u.isActive ? 'Bloquear' : 'Desbloquear'}
                        </Button>
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>

          {total > PAGE_SIZE && (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm text-text-muted tabular-nums">
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} de {total}
              </p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  Anterior
                </Button>
                <Button variant="secondary" size="sm" disabled={page >= lastPage} onClick={() => setPage((p) => p + 1)}>
                  Próxima
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      <UserFormModal
        open={createOpen}
        title="Novo cliente"
        initial={EMPTY_FORM}
        requirePassword
        onSubmit={handleCreate}
        onClose={() => setCreateOpen(false)}
      />

      <UserFormModal
        open={editing !== null}
        title={editing ? `Editar ${editing.username}` : ''}
        initial={editing ? userToForm(editing) : EMPTY_FORM}
        requirePassword={false}
        onSubmit={handleUpdate}
        onClose={() => setEditing(null)}
      />

      <ConfirmDialog
        open={blockTarget !== null}
        title={blockTarget?.isActive ? 'Bloquear cliente' : 'Desbloquear cliente'}
        message={
          blockTarget?.isActive
            ? `${blockTarget?.username} perde acesso ao painel imediatamente, mas os servidores permanecem intactos.`
            : `${blockTarget?.username} volta a ter acesso ao painel.`
        }
        confirmLabel={blockTarget?.isActive ? 'Bloquear' : 'Desbloquear'}
        tone={blockTarget?.isActive ? 'danger' : 'default'}
        loading={blocking}
        onConfirm={() => void handleConfirmBlock()}
        onCancel={() => setBlockTarget(null)}
      />
    </>
  );
}
