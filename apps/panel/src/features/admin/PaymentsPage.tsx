import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Receipt, Search } from 'lucide-react';
import { listOrders, getOrder, retryProvisioning, refundOrder, archiveOrders } from './admin.api';
import { ApiError } from '@/shared/api/client';
import type { AdminOrder, OrderStatus, OrderProvisioningStatus } from '@/shared/api/types';
import {
  Alert,
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
import { formatPrice } from '@/shared/format/plan';
import { formatDateTimeShort } from '@/shared/format/datetime';

const PAGE_SIZE = 25;

const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: 'Pendente',
  paid: 'Pago',
  failed: 'Falhou',
  cancelled: 'Cancelado',
  refunded: 'Reembolsado',
  expired: 'Expirado',
};
const STATUS_TONE: Record<OrderStatus, 'ok' | 'warn' | 'fail' | 'neutral'> = {
  pending: 'warn',
  paid: 'ok',
  failed: 'fail',
  cancelled: 'neutral',
  refunded: 'neutral',
  expired: 'neutral',
};
const STATUS_OPTIONS: OrderStatus[] = ['pending', 'paid', 'failed', 'cancelled', 'refunded', 'expired'];

const PROVISIONING_LABEL: Record<OrderProvisioningStatus, string> = {
  not_required: '—',
  pending: 'Aguardando',
  running: 'Em andamento',
  done: 'Concluído',
  failed: 'Falhou',
};
const PROVISIONING_TONE: Record<OrderProvisioningStatus, 'ok' | 'warn' | 'fail' | 'neutral'> = {
  not_required: 'neutral',
  pending: 'warn',
  running: 'warn',
  done: 'ok',
  failed: 'fail',
};

function formatDate(value: string | null): string {
  return value ? formatDateTimeShort(value) : '—';
}

/**
 * Admin visibility and control over every customer's order/payment
 * (payments plan step 8). Mirrors `SubscriptionsPage.tsx`'s own filter/
 * pagination/detail-modal shape exactly, including its cache-
 * invalidation fix (list AND detail are two DIFFERENT query keys, both
 * invalidated on a successful mutation — found live as a stale-modal
 * bug on that page first).
 */
export function PaymentsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [page, setPage] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const params = {
    q: query || undefined,
    status: (status || undefined) as OrderStatus | undefined,
    paymentMethod: (paymentMethod || undefined) as 'pix' | 'boleto' | 'card' | undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const { data, isPending, error } = useQuery({
    queryKey: ['admin', 'orders', params],
    queryFn: () => listOrders(params),
    placeholderData: keepPreviousData,
  });

  // A different page/filter shows a different set of ids — a selection
  // carried over could silently archive rows the admin never looked at.
  useEffect(() => {
    setSelected(new Set());
  }, [page, query, status, paymentMethod]);

  const archiveMutation = useMutation({
    mutationFn: () => archiveOrders([...selected]),
    onSuccess: () => {
      setArchiveError(null);
      setConfirmArchive(false);
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ['admin', 'orders'] });
    },
    onError: (err) => setArchiveError(err instanceof ApiError ? err.message : 'Não foi possível arquivar os pedidos selecionados.'),
  });

  function toggleSelected(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    const ids = data?.items.map((o) => o.id) ?? [];
    setSelected((s) => (s.size === ids.length ? new Set() : new Set(ids)));
  }

  function applySearch() {
    setPage(0);
    setQuery(search.trim());
  }

  const total = data?.total ?? 0;
  const hasNext = (page + 1) * PAGE_SIZE < total;

  return (
    <>
      <PageHeader title="Pagamentos" subtitle="Pedidos e cobranças de cada cliente." />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Buscar" htmlFor="order-search" className="flex-1">
          <div className="flex gap-2">
            <Input
              id="order-search"
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
        <Field label="Status" htmlFor="order-status" className="w-full sm:w-44">
          <Select
            id="order-status"
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
        <Field label="Método" htmlFor="order-method" className="w-full sm:w-40">
          <Select
            id="order-method"
            value={paymentMethod}
            onChange={(e) => {
              setPage(0);
              setPaymentMethod(e.target.value);
            }}
          >
            <option value="">Todos</option>
            <option value="pix">Pix</option>
            <option value="boleto">Boleto</option>
            <option value="card">Cartão</option>
          </Select>
        </Field>
      </div>

      {isPending ? (
        <LoadingRow />
      ) : error ? (
        <Alert tone="fail">{error instanceof ApiError ? error.message : 'Não foi possível carregar os pedidos.'}</Alert>
      ) : !data || data.items.length === 0 ? (
        <EmptyState icon={Receipt} title="Nenhum pedido encontrado" />
      ) : (
        <>
          {selected.size > 0 && (
            <div className="mb-3 flex items-center gap-2">
              <span className="text-xs text-text-muted">{selected.size} selecionado(s)</span>
              <Button variant="ghost" size="sm" onClick={() => setConfirmArchive(true)}>
                Arquivar selecionados
              </Button>
            </div>
          )}

          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH className="w-8">
                    <input
                      type="checkbox"
                      className="h-4 w-4 cursor-pointer rounded border-border"
                      checked={selected.size > 0 && selected.size === data.items.length}
                      onChange={toggleSelectAll}
                      aria-label="Selecionar tudo"
                    />
                  </TH>
                  <TH>Cliente</TH>
                  <TH>Plano</TH>
                  <TH>Valor</TH>
                  <TH>Método</TH>
                  <TH>Status</TH>
                  <TH>Provisionamento</TH>
                  <TH>Criado em</TH>
                </TR>
              </THead>
              <TBody>
                {data.items.map((order: AdminOrder) => (
                  <TR key={order.id} className="cursor-pointer" onClick={() => setDetailId(order.id)}>
                    <TD onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer rounded border-border"
                        checked={selected.has(order.id)}
                        onChange={() => toggleSelected(order.id)}
                        aria-label={`Selecionar pedido de ${order.user.username}`}
                      />
                    </TD>
                    <TD>
                      <p className="font-medium text-text">{order.user.username}</p>
                      <p className="text-xs text-text-faint">{order.user.email}</p>
                    </TD>
                    <TD>{order.plan.name}</TD>
                    <TD className="font-mono">{formatPrice(order.amountCents, order.currency)}</TD>
                    <TD className="capitalize">{order.paymentMethod ?? '—'}</TD>
                    <TD>
                      <Badge tone={STATUS_TONE[order.status]}>{STATUS_LABEL[order.status]}</Badge>
                    </TD>
                    <TD>
                      <Badge tone={PROVISIONING_TONE[order.provisioningStatus]}>{PROVISIONING_LABEL[order.provisioningStatus]}</Badge>
                    </TD>
                    <TD className="text-text-faint">{formatDate(order.createdAt)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>

          <div className="mt-4 flex items-center justify-between text-sm text-text-muted">
            <span>{total} pedido(s)</span>
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

      <ConfirmDialog
        open={confirmArchive}
        title="Arquivar pedidos"
        message={`Isso remove ${selected.size} pedido(s) desta lista. O histórico financeiro não é apagado — apenas fica oculto do painel.`}
        confirmLabel="Arquivar"
        loading={archiveMutation.isPending}
        onConfirm={() => archiveMutation.mutate()}
        onCancel={() => {
          setConfirmArchive(false);
          setArchiveError(null);
        }}
      />
      {archiveError && (
        <Alert tone="fail" className="mt-3" onDismiss={() => setArchiveError(null)}>
          {archiveError}
        </Alert>
      )}

      <OrderDetailModal
        id={detailId}
        onClose={() => setDetailId(null)}
        onChanged={() => {
          // Two DIFFERENT query keys, not a prefix match — same fix
          // SubscriptionsPage.tsx's own comment documents finding live.
          void queryClient.invalidateQueries({ queryKey: ['admin', 'orders'] });
          void queryClient.invalidateQueries({ queryKey: ['admin', 'order'] });
        }}
      />
    </>
  );
}

function OrderDetailModal({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const [refundReason, setRefundReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const { data: detail, isPending } = useQuery({
    queryKey: ['admin', 'order', id],
    queryFn: () => getOrder(id!),
    enabled: !!id,
  });

  const retryMutation = useMutation({
    mutationFn: () => retryProvisioning(id!),
    onSuccess: () => {
      setActionError(null);
      setActionMessage('Reprocessamento enfileirado.');
      onChanged();
    },
    onError: (err) => setActionError(err instanceof ApiError ? err.message : 'Não foi possível reprocessar o provisionamento.'),
  });

  const refundMutation = useMutation({
    mutationFn: () => refundOrder(id!, refundReason.trim()),
    onSuccess: (result) => {
      setActionError(null);
      setActionMessage(`Reembolso solicitado ao provedor (status: ${result.providerStatus ?? 'desconhecido'}). A confirmação chega pelo webhook.`);
      setRefundReason('');
      onChanged();
    },
    onError: (err) => setActionError(err instanceof ApiError ? err.message : 'Não foi possível solicitar o reembolso.'),
  });

  function close() {
    setActionError(null);
    setActionMessage(null);
    setRefundReason('');
    onClose();
  }

  return (
    <Modal open={!!id} onClose={close} title="Detalhes do pedido" size="lg">
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
              <p className="text-text-faint">Valor</p>
              <p className="text-text">{formatPrice(detail.amountCents, detail.currency)}</p>
            </div>
            <div>
              <p className="text-text-faint">Status</p>
              <Badge tone={STATUS_TONE[detail.status]}>{STATUS_LABEL[detail.status]}</Badge>
            </div>
            <div>
              <p className="text-text-faint">Método</p>
              <p className="text-text capitalize">{detail.paymentMethod ?? '—'}</p>
            </div>
            <div>
              <p className="text-text-faint">Provisionamento</p>
              <Badge tone={PROVISIONING_TONE[detail.provisioningStatus]}>{PROVISIONING_LABEL[detail.provisioningStatus]}</Badge>
              {detail.provisioningError && <p className="mt-1 text-xs text-fail">{detail.provisioningError}</p>}
            </div>
            <div>
              <p className="text-text-faint">Servidor</p>
              <p className="text-text">{detail.server?.name ?? '—'}</p>
            </div>
            <div>
              <p className="text-text-faint">Pago em</p>
              <p className="text-text">{formatDate(detail.paidAt)}</p>
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-text">Pagamentos</h3>
            {detail.payments.length === 0 ? (
              <p className="text-sm text-text-faint">Nenhum pagamento registrado ainda.</p>
            ) : (
              <ul className="space-y-1.5 text-sm text-text-muted">
                {detail.payments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
                    <span>
                      <span className="font-mono text-xs text-text-faint">{p.id}</span> — {p.status}
                      {p.paidAmountCents != null && <span className="text-text-faint"> · {formatPrice(p.paidAmountCents, p.currency)}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-text-faint">{formatDate(p.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-text">Eventos de webhook</h3>
            {detail.webhookEvents.length === 0 ? (
              <p className="text-sm text-text-faint">Nenhum evento recebido ainda.</p>
            ) : (
              <ul className="space-y-1.5 text-sm text-text-muted">
                {detail.webhookEvents.map((ev) => (
                  <li key={ev.id} className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
                    <span>
                      {ev.type} — {ev.status}
                      {ev.error && <span className="text-fail"> ({ev.error})</span>}
                    </span>
                    <span className="shrink-0 text-xs text-text-faint">{formatDate(ev.receivedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {(detail.status === 'paid' && detail.provisioningStatus === 'failed') || detail.status === 'paid' ? (
            <div className="border-t border-border pt-4">
              <h3 className="mb-3 text-sm font-semibold text-text">Ações</h3>
              <div className="flex flex-col gap-3">
                {detail.status === 'paid' && detail.provisioningStatus === 'failed' && (
                  <Button variant="secondary" disabled={retryMutation.isPending} onClick={() => retryMutation.mutate()} className="w-fit">
                    {retryMutation.isPending ? 'Reprocessando…' : 'Reprocessar provisionamento'}
                  </Button>
                )}
                {detail.status === 'paid' && (
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                    <Field label="Motivo do reembolso" htmlFor="refund-reason" className="flex-1">
                      <Input id="refund-reason" value={refundReason} onChange={(e) => setRefundReason(e.target.value)} placeholder="Obrigatório" />
                    </Field>
                    <Button
                      variant="danger"
                      disabled={!refundReason.trim() || refundMutation.isPending}
                      onClick={() => refundMutation.mutate()}
                    >
                      {refundMutation.isPending ? 'Solicitando…' : 'Reembolsar'}
                    </Button>
                  </div>
                )}
              </div>
              {actionMessage && (
                <Alert tone="ok" className="mt-3">
                  {actionMessage}
                </Alert>
              )}
              {actionError && (
                <Alert tone="fail" className="mt-3">
                  {actionError}
                </Alert>
              )}
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
