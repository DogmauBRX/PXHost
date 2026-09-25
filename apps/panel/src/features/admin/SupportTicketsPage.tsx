import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LifeBuoy, Search } from 'lucide-react';
import { ApiError } from '@/shared/api/client';
import type { SupportTicketPriority, SupportTicketStatus } from '@/shared/api/types';
import { formatDateTimeShort } from '@/shared/format/datetime';
import {
  getAdminTicket,
  deleteAdminTicket,
  listAdminTickets,
  replyAdminTicket,
  updateAdminTicket,
} from '@/features/support/tickets.api';
import { TicketConversation } from '@/features/support/TicketConversation';
import {
  TICKET_PRIORITY_LABEL,
  TICKET_PRIORITY_TONE,
  TICKET_STATUS_LABEL,
  TICKET_STATUS_TONE,
} from '@/features/support/ticket-labels';
import { Alert, Badge, Button, ConfirmDialog, EmptyState, Input, LoadingRow, PageHeader, Select, Textarea } from '@/ui/primitives';

export function SupportTicketsPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<SupportTicketStatus | ''>('');
  const [priority, setPriority] = useState<SupportTicketPriority | ''>('');
  const [reply, setReply] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);

  const filters = { q: query.trim() || undefined, status: status || undefined, priority: priority || undefined };
  const { data: tickets, isPending, error } = useQuery({
    queryKey: ['admin', 'support', 'tickets', filters],
    queryFn: () => listAdminTickets(filters),
    refetchInterval: 10_000,
  });
  const { data: selected, isPending: detailPending } = useQuery({
    queryKey: ['admin', 'support', 'tickets', selectedId],
    queryFn: () => getAdminTicket(selectedId!),
    enabled: selectedId !== null,
    refetchInterval: 10_000,
  });

  useEffect(() => {
    if (tickets?.length && (!selectedId || !tickets.some((ticket) => ticket.id === selectedId))) {
      setSelectedId(tickets[0].id);
    }
  }, [selectedId, tickets]);

  const refresh = (id: string) => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'support', 'tickets'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'support', 'tickets', id] });
  };
  const replyMutation = useMutation({
    mutationFn: () => replyAdminTicket(selectedId!, reply),
    onSuccess: () => { setReply(''); refresh(selectedId!); },
  });
  const updateMutation = useMutation({
    mutationFn: (input: { status?: SupportTicketStatus; priority?: SupportTicketPriority }) => updateAdminTicket(selectedId!, input),
    onSuccess: () => refresh(selectedId!),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteAdminTicket(selectedId!),
    onSuccess: () => {
      setDeleteOpen(false);
      setSelectedId(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'support', 'tickets'] });
    },
  });
  const mutationError = replyMutation.error ?? updateMutation.error ?? deleteMutation.error;

  return (
    <>
      <PageHeader title="Tickets de suporte" subtitle="Acompanhe solicitações e responda aos clientes pelo painel." />
      {mutationError && <Alert tone="fail" className="mb-4">{mutationError instanceof ApiError ? mutationError.message : 'Não foi possível concluir a ação.'}</Alert>}

      <div className="mb-4 grid gap-3 sm:grid-cols-[minmax(14rem,1fr)_12rem_12rem]">
        <label className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-faint" />
          <Input className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente, servidor ou assunto" />
        </label>
        <Select aria-label="Filtrar por status" value={status} onChange={(event) => setStatus(event.target.value as SupportTicketStatus | '')}>
          <option value="">Todos os status</option>
          {Object.entries(TICKET_STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
        <Select aria-label="Filtrar por prioridade" value={priority} onChange={(event) => setPriority(event.target.value as SupportTicketPriority | '')}>
          <option value="">Todas as prioridades</option>
          {Object.entries(TICKET_PRIORITY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
      </div>

      <div className="grid gap-4 xl:grid-cols-[24rem_minmax(0,1fr)]">
        <aside className="space-y-2">
          {isPending ? <LoadingRow /> : error ? <Alert tone="fail">Não foi possível carregar os tickets.</Alert> : !tickets?.length ? (
            <EmptyState icon={LifeBuoy} title="Nenhum ticket encontrado" description="A fila está vazia para os filtros selecionados." />
          ) : tickets.map((ticket) => (
            <button
              key={ticket.id}
              type="button"
              onClick={() => setSelectedId(ticket.id)}
              className={`w-full rounded-card border p-4 text-left transition-colors ${selectedId === ticket.id ? 'border-accent bg-accent-tint' : 'border-border bg-surface hover:border-border-strong'}`}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="line-clamp-2 text-sm font-semibold text-text">{ticket.subject}</p>
                <Badge tone={TICKET_STATUS_TONE[ticket.status]}>{TICKET_STATUS_LABEL[ticket.status]}</Badge>
              </div>
              <p className="mt-1 text-xs text-text-muted">{ticket.user.username} · {ticket.user.email}</p>
              {ticket.server && <p className="mt-1 text-xs text-text-faint">{ticket.server.name} ({ticket.server.shortId})</p>}
              <div className="mt-3 flex items-center justify-between gap-2">
                <Badge tone={TICKET_PRIORITY_TONE[ticket.priority]}>{TICKET_PRIORITY_LABEL[ticket.priority]}</Badge>
                <span className="text-[0.68rem] text-text-faint">{formatDateTimeShort(ticket.lastMessageAt)}</span>
              </div>
            </button>
          ))}
        </aside>

        <div>
          {selectedId && detailPending ? <LoadingRow /> : selected ? (
            <TicketConversation
              ticket={selected}
              actions={(
                <div className="flex flex-wrap gap-2">
                  <Select
                    aria-label="Alterar prioridade"
                    value={selected.priority}
                    disabled={updateMutation.isPending}
                    onChange={(event) => updateMutation.mutate({ priority: event.target.value as SupportTicketPriority })}
                  >
                    {Object.entries(TICKET_PRIORITY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </Select>
                  <Select
                    aria-label="Alterar status"
                    value={selected.status}
                    disabled={updateMutation.isPending}
                    onChange={(event) => updateMutation.mutate({ status: event.target.value as SupportTicketStatus })}
                  >
                    {Object.entries(TICKET_STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </Select>
                  <Button variant="danger" size="sm" disabled={deleteMutation.isPending} onClick={() => setDeleteOpen(true)}>Excluir ticket</Button>
                </div>
              )}
              composer={selected.status === 'closed' ? (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-text-muted">Reabra o ticket para enviar uma resposta.</p>
                  <Button variant="secondary" onClick={() => updateMutation.mutate({ status: 'in_progress' })}>Reabrir</Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <Textarea rows={3} maxLength={5000} value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Escreva uma resposta para o cliente…" />
                  <div className="flex justify-end"><Button variant="primary" disabled={!reply.trim() || replyMutation.isPending} onClick={() => replyMutation.mutate()}>{replyMutation.isPending ? 'Enviando…' : 'Enviar resposta'}</Button></div>
                </div>
              )}
            />
          ) : (
            <EmptyState icon={LifeBuoy} title="Selecione um ticket" description="Escolha uma solicitação na fila para ver a conversa." />
          )}
        </div>
      </div>
      <ConfirmDialog
        open={deleteOpen}
        title="Excluir ticket"
        message={`Excluir permanentemente o ticket${selected ? ` “${selected.subject}”` : ''} e todas as mensagens? Esta ação não pode ser desfeita.`}
        confirmLabel="Excluir permanentemente"
        tone="danger"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
        onCancel={() => setDeleteOpen(false)}
      />
    </>
  );
}
