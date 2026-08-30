import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Search, ShieldCheck, Users } from 'lucide-react';
import { listUsers } from './admin.api';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  EmptyState,
  Input,
  LoadingRow,
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

export function UsersPage() {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(0);

  const params = { q: query || undefined, role: role || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
  const { data, isPending, error } = useQuery({
    queryKey: ['admin', 'users', params],
    queryFn: () => listUsers(params),
    placeholderData: keepPreviousData,
  });

  function applySearch() {
    setPage(0);
    setQuery(search.trim());
  }

  const total = data?.total ?? 0;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  return (
    <>
      <PageHeader
        title="Clientes"
        subtitle="Todas as contas cadastradas na plataforma."
        actions={
          <span className="text-sm text-text-muted tabular-nums">
            {total} {total === 1 ? 'conta' : 'contas'}
          </span>
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

      {isPending ? (
        <LoadingRow />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Nenhum cliente encontrado"
          description={query || role ? 'Tente ajustar a busca ou os filtros.' : 'Ainda não há contas cadastradas.'}
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
    </>
  );
}
