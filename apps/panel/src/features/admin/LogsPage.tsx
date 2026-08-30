import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { listAuditLogs } from './admin.api';
import {
  Alert,
  Button,
  EmptyState,
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

// Action namespaces as emitted by AuditService. Prefix-matched server-side,
// so `auth.` covers auth.login.success, auth.refresh_reuse, and so on.
const ACTION_FILTERS = [
  { value: '', label: 'Todas as ações' },
  { value: 'auth.', label: 'Autenticação' },
  { value: 'server.', label: 'Servidores' },
  { value: 'node.', label: 'Nodes' },
  { value: 'plan.', label: 'Planos' },
  { value: 'backup.', label: 'Backups' },
  { value: 'database.', label: 'Bancos de dados' },
  { value: 'billing.', label: 'Cobrança' },
] as const;

function formatDate(value: string): string {
  return new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
}

export function LogsPage() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(0);

  const params = { action: action || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
  const { data, isPending, error } = useQuery({
    queryKey: ['admin', 'audit-logs', params],
    queryFn: () => listAuditLogs(params),
    placeholderData: keepPreviousData,
  });

  const total = data?.total ?? 0;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  return (
    <>
      <PageHeader
        title="Logs"
        subtitle="Trilha de auditoria administrativa. Registros são somente-leitura e imutáveis."
        actions={
          <span className="text-sm text-text-muted tabular-nums">
            {total} {total === 1 ? 'registro' : 'registros'}
          </span>
        }
      />

      <div className="mb-4 w-64">
        <Select
          value={action}
          onChange={(e) => {
            setPage(0);
            setAction(e.target.value);
          }}
          aria-label="Filtrar por tipo de ação"
        >
          {ACTION_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
      </div>

      {error && <Alert className="mb-4">Não foi possível carregar os logs.</Alert>}

      {isPending ? (
        <LoadingRow />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="Nenhum registro"
          description={action ? 'Nenhuma ação desse tipo foi registrada.' : 'A trilha de auditoria está vazia.'}
        />
      ) : (
        <>
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>Quando</TH>
                  <TH>Ação</TH>
                  <TH>Autor</TH>
                  <TH>Alvo</TH>
                  <TH>IP</TH>
                </TR>
              </THead>
              <TBody>
                {data.items.map((log) => (
                  <TR key={log.id}>
                    <TD className="whitespace-nowrap text-text-muted tabular-nums">{formatDate(log.occurredAt)}</TD>
                    <TD>
                      <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-text">{log.action}</code>
                    </TD>
                    <TD>
                      {log.actor ? (
                        <div className="min-w-0">
                          <p className="truncate text-text">{log.actor.username}</p>
                          <p className="truncate text-xs text-text-muted">{log.actor.email}</p>
                        </div>
                      ) : (
                        <span className="text-text-faint">{log.actorEmail ?? 'Sistema'}</span>
                      )}
                    </TD>
                    <TD className="text-text-muted">
                      {log.targetType ? (
                        <span className="font-mono text-xs">
                          {log.targetType}
                          {log.targetId ? `:${log.targetId.slice(0, 8)}` : ''}
                        </span>
                      ) : (
                        '—'
                      )}
                    </TD>
                    <TD className="font-mono text-xs text-text-muted">{log.actorIp ?? '—'}</TD>
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
