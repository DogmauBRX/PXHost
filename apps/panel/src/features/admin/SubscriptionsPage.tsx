import { useState } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { CreditCard, Search } from 'lucide-react';
import { getSubscription, listSubscriptions, updateSubscriptionStatus } from './admin.api';
import { ApiError } from '@/shared/api/client';
import type { AdminSubscription, SubscriptionStatus } from '@/shared/api/types';
import {
  Alert,
  Badge,
  Button,
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
import { formatBillingPeriod, formatPrice } from '@/shared/format/plan';

const PAGE_SIZE = 25;

const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  pending: 'Pendente',
  active: 'Ativo',
  past_due: 'Atrasado',
  suspended: 'Suspenso',
  cancelled: 'Cancelado',
  expired: 'Expirado',
};
const STATUS_TONE: Record<SubscriptionStatus, 'ok' | 'warn' | 'fail' | 'neutral'> = {
  pending: 'warn',
  active: 'ok',
  past_due: 'warn',
  suspended: 'fail',
  cancelled: 'neutral',
  expired: 'neutral',
};
const STATUS_OPTIONS: SubscriptionStatus[] = ['pending', 'active', 'past_due', 'suspended', 'cancelled', 'expired'];

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Admin visibility and control over every customer's subscription
 * (commercial plan §18). Mirrors UsersPage's filter/pagination shape —
 * same `q` + closed-set filter + offset pagination the backend already
 * expects (SubscriptionsService.listForAdmin).
 */
export function SubscriptionsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);

  const params = { q: query || undefined, status: (status || undefined) as SubscriptionStatus | undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
  const { data, isPending, error } = useQuery({
    queryKey: ['admin', 'subscriptions', params],
    queryFn: () => listSubscriptions(params),
    placeholderData: keepPreviousData,
  });

  function applySearch() {
    setPage(0);
    setQuery(search.trim());
  }

  const total = data?.total ?? 0;
  const hasNext = (page + 1) * PAGE_SIZE < total;

  return (
    <>
      <PageHeader title="Assinaturas" subtitle="Contratos comerciais de cada cliente." />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Buscar" htmlFor="sub-search" className="flex-1">
          <div className="flex gap-2">
            <Input
              id="sub-search"
              placeholder="E-mail ou usuário do cliente"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applySearch()}
            />
            <Button variant="secondary" onClick={applySearch}>
              <Search className="h-4 w-4" />
            </Button>
          </div>
        </Field>
        <Field label="Status" htmlFor="sub-status" className="w-full sm:w-48">
          <Select
            id="sub-status"
            value={status}
            onChange={(e) => {
              setPage(0);
              setStatus(e.target.value);
            }}
          >
            <option value="">Todos</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {isPending ? (
        <LoadingRow />
      ) : error ? (
        <Alert tone="fail">{error instanceof ApiError ? error.message : 'Não foi possível carregar as assinaturas.'}</Alert>
      ) : !data || data.items.length === 0 ? (
        <EmptyState icon={CreditCard} title="Nenhuma assinatura encontrada" />
      ) : (
        <>
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>Cliente</TH>
                  <TH>Plano</TH>
                  <TH>Preço</TH>
                  <TH>Status</TH>
                  <TH>Criada em</TH>
                </TR>
              </THead>
              <TBody>
                {data.items.map((sub: AdminSubscription) => (
                  <TR key={sub.id} className="cursor-pointer" onClick={() => setDetailId(sub.id)}>
                    <TD>
                      <p className="font-medium text-text">{sub.user.username}</p>
                      <p className="text-xs text-text-faint">{sub.user.email}</p>
                    </TD>
                    <TD>{sub.plan.name}</TD>
                    <TD className="font-mono">
                      {formatPrice(sub.priceCents, sub.currency)}/{formatBillingPeriod(sub.billingPeriod)}
                    </TD>
                    <TD>
                      <Badge tone={STATUS_TONE[sub.status]}>{STATUS_LABEL[sub.status]}</Badge>
                    </TD>
                    <TD className="text-text-faint">{formatDate(sub.createdAt)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>

          <div className="mt-4 flex items-center justify-between text-sm text-text-muted">
            <span>{total} assinatura(s)</span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Anterior
              </Button>
              <Button variant="secondary" size="sm" disabled={!hasNext} onClick={() => setPage((p) => p + 1)}>
                Próxima
              </Button>
            </div>
          </div>
        </>
      )}

      <SubscriptionDetailModal
        id={detailId}
        onClose={() => setDetailId(null)}
        onChanged={() => {
          // Two DIFFERENT query keys, not a prefix match — 'subscriptions'
          // (the list, plural) and 'subscription' (this modal's own
          // detail+history query, singular) — found live: after applying
          // a status change, the table behind the modal updated but the
          // still-open modal kept showing the pre-change status and
          // history until closed and reopened.
          void queryClient.invalidateQueries({ queryKey: ['admin', 'subscriptions'] });
          void queryClient.invalidateQueries({ queryKey: ['admin', 'subscription'] });
        }}
      />
    </>
  );
}

function SubscriptionDetailModal({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const [nextStatus, setNextStatus] = useState<SubscriptionStatus | ''>('');
  const [reason, setReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: detail, isPending } = useQuery({
    queryKey: ['admin', 'subscription', id],
    queryFn: () => getSubscription(id!),
    enabled: !!id,
  });

  const mutation = useMutation({
    mutationFn: () => updateSubscriptionStatus(id!, nextStatus as SubscriptionStatus, reason.trim() || undefined),
    onSuccess: () => {
      setNextStatus('');
      setReason('');
      setActionError(null);
      onChanged();
    },
    onError: (err) => setActionError(err instanceof ApiError ? err.message : 'Não foi possível alterar o status.'),
  });

  return (
    <Modal open={!!id} onClose={onClose} title="Detalhes da assinatura" size="lg">
      {isPending || !detail ? (
        <LoadingRow />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-text-faint">Cliente</p>
              <p className="text-text">{detail.user.username}</p>
              <p className="text-text-faint">{detail.user.email}</p>
            </div>
            <div>
              <p className="text-text-faint">Plano</p>
              <p className="text-text">{detail.plan.name}</p>
            </div>
            <div>
              <p className="text-text-faint">Preço</p>
              <p className="text-text">
                {formatPrice(detail.priceCents, detail.currency)}/{formatBillingPeriod(detail.billingPeriod)}
              </p>
            </div>
            <div>
              <p className="text-text-faint">Status atual</p>
              <Badge tone={STATUS_TONE[detail.status]}>{STATUS_LABEL[detail.status]}</Badge>
            </div>
            <div>
              <p className="text-text-faint">Criada em</p>
              <p className="text-text">{formatDate(detail.createdAt)}</p>
            </div>
            <div>
              <p className="text-text-faint">Próxima cobrança</p>
              <p className="text-text">{formatDate(detail.currentPeriodEndsAt)}</p>
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-text">Histórico</h3>
            <ul className="space-y-1.5 text-sm text-text-muted">
              {detail.events.map((ev) => (
                <li key={ev.id} className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
                  <span>
                    {ev.fromStatus ? `${STATUS_LABEL[ev.fromStatus]} → ${STATUS_LABEL[ev.toStatus]}` : `Criada como ${STATUS_LABEL[ev.toStatus]}`}
                    {ev.reason && <span className="text-text-faint"> — {ev.reason}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-text-faint">{formatDate(ev.createdAt)}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="border-t border-border pt-4">
            <h3 className="mb-3 text-sm font-semibold text-text">Alterar status</h3>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <Field label="Novo status" htmlFor="sub-next-status" className="w-full sm:w-48">
                <Select id="sub-next-status" value={nextStatus} onChange={(e) => setNextStatus(e.target.value as SubscriptionStatus)}>
                  <option value="">Selecione…</option>
                  {STATUS_OPTIONS.filter((s) => s !== detail.status).map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Motivo (opcional)" htmlFor="sub-reason" className="flex-1">
                <Input id="sub-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
              <Button variant="primary" disabled={!nextStatus || mutation.isPending} onClick={() => mutation.mutate()}>
                {mutation.isPending ? 'Salvando…' : 'Aplicar'}
              </Button>
            </div>
            {actionError && (
              <Alert tone="fail" className="mt-3">
                {actionError}
              </Alert>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
