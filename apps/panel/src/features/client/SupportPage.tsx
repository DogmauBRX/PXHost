import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LifeBuoy, MessageSquarePlus, ShieldCheck } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { listServers } from '@/features/servers/servers.api';
import { createClientTicket, getClientTicket, listClientTickets, replyClientTicket } from '@/features/support/tickets.api';
import { TicketConversation } from '@/features/support/TicketConversation';
import { CopySupportEmail } from '@/features/support/CopySupportEmail';
import { CLIENT_TICKET_CATEGORY_OPTIONS, TICKET_PRIORITY_LABEL, TICKET_STATUS_LABEL, TICKET_STATUS_TONE } from '@/features/support/ticket-labels';
import type { SupportTicketCategory } from '@/shared/api/types';
import { ApiError } from '@/shared/api/client';
import { formatDateTimeShort } from '@/shared/format/datetime';
import { Alert, Badge, Button, EmptyState, Field, Input, LoadingRow, Modal, PageHeader, Select, Textarea } from '@/ui/primitives';

export function SupportPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [reply, setReply] = useState('');
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<SupportTicketCategory>('server_error');
  const [serverId, setServerId] = useState('');
  const [message, setMessage] = useState('');

  const { data: tickets, isPending, error } = useQuery({ queryKey: ['client', 'support', 'tickets'], queryFn: listClientTickets, refetchInterval: 10_000 });
  const { data: servers } = useQuery({ queryKey: ['client', 'servers'], queryFn: listServers });
  const { data: selected, isPending: detailPending } = useQuery({
    queryKey: ['client', 'support', 'tickets', selectedId],
    queryFn: () => getClientTicket(selectedId!),
    enabled: selectedId !== null,
    refetchInterval: 10_000,
  });

  useEffect(() => {
    if (!selectedId && tickets?.length) setSelectedId(tickets[0].id);
  }, [selectedId, tickets]);

  const refresh = (id?: string) => {
    void queryClient.invalidateQueries({ queryKey: ['client', 'support', 'tickets'] });
    if (id) void queryClient.invalidateQueries({ queryKey: ['client', 'support', 'tickets', id] });
  };

  const createMutation = useMutation({
    mutationFn: () => createClientTicket({ subject, category, serverId: serverId || undefined, message }),
    onSuccess: (ticket) => {
      setCreateOpen(false);
      setSelectedId(ticket.id);
      setSubject(''); setCategory('server_error'); setServerId(''); setMessage('');
      refresh(ticket.id);
    },
  });
  const replyMutation = useMutation({
    mutationFn: () => replyClientTicket(selectedId!, reply),
    onSuccess: () => { setReply(''); refresh(selectedId!); },
  });
  const mutationError = createMutation.error ?? replyMutation.error;

  return (
    <>
      <PageHeader
        title="Suporte"
        subtitle="Abra um ticket e converse com a equipe sem sair do painel."
      />
      {mutationError && <Alert tone="fail" className="mb-4">{mutationError instanceof ApiError ? mutationError.message : 'Não foi possível concluir a ação.'}</Alert>}

      <div className="grid gap-4 lg:grid-cols-[21rem_minmax(0,1fr)]">
        <aside className="space-y-2">
          {isPending ? <LoadingRow /> : error ? (
            <Alert tone="fail">Não foi possível carregar seus tickets.</Alert>
          ) : !tickets?.length ? (
            <EmptyState icon={LifeBuoy} title="Nenhum ticket aberto" description="Quando precisar de ajuda, abra seu primeiro chamado." />
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
              <p className="mt-2 line-clamp-2 text-xs text-text-muted">{ticket.messages[0]?.body}</p>
              <p className="mt-2 text-[0.68rem] text-text-faint">{formatDateTimeShort(ticket.lastMessageAt)} · {ticket._count.messages} mensagens</p>
            </button>
          ))}
          <div className="rounded-card border border-border bg-surface p-4">
            <p className="text-xs text-text-muted">Também prefere e-mail?</p>
            <CopySupportEmail icon="mail" className="mt-2 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:text-accent-strong" />
          </div>
        </aside>

        <div>
          {selectedId && detailPending ? <LoadingRow /> : selected ? (
            <TicketConversation
              ticket={selected}
              actions={<div className="flex items-center gap-2"><Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}><MessageSquarePlus className="h-4 w-4" />Novo ticket</Button></div>}
              composer={selected.status !== 'closed' ? (
                <div className="space-y-3">
                  <Textarea rows={3} maxLength={5000} value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Escreva sua resposta…" />
                  <div className="flex justify-end"><Button variant="primary" disabled={!reply.trim() || replyMutation.isPending} onClick={() => replyMutation.mutate()}>{replyMutation.isPending ? 'Enviando…' : 'Enviar resposta'}</Button></div>
                </div>
              ) : <p className="text-center text-sm text-text-muted">Este ticket foi encerrado pela equipe de suporte.</p>}
            />
          ) : (
            <div className="rounded-card border border-border bg-surface p-8 text-center">
              <ShieldCheck className="mx-auto h-8 w-8 text-ok" />
              <h2 className="mt-3 font-semibold text-text">Atendimento seguro</h2>
              <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">Nunca envie senhas, códigos de acesso ou dados do cartão. Selecione um ticket ou abra um novo chamado.</p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                <Link to="/central" hash="suporte" className="inline-flex h-10 items-center rounded-lg border border-border px-4 text-sm font-semibold text-text-muted transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-text">Ver orientações de suporte</Link>
                <Button variant="primary" onClick={() => setCreateOpen(true)}><MessageSquarePlus className="h-4 w-4" />Novo ticket</Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Novo ticket"
        description="Conte o que aconteceu com o máximo de detalhes possível."
        size="lg"
        footer={<><Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancelar</Button><Button variant="primary" disabled={subject.trim().length < 4 || message.trim().length < 10 || createMutation.isPending} onClick={() => createMutation.mutate()}>{createMutation.isPending ? 'Abrindo…' : 'Abrir ticket'}</Button></>}
      >
        <div className="space-y-4">
          <Field label="Assunto" htmlFor="ticket-subject" required><Input id="ticket-subject" maxLength={120} value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Ex.: servidor não inicia" /></Field>
          <Field
            label="Categoria do problema"
            htmlFor="ticket-category"
            hint={`Prioridade definida automaticamente: ${TICKET_PRIORITY_LABEL[CLIENT_TICKET_CATEGORY_OPTIONS.find((option) => option.value === category)!.priority]}`}
          >
            <Select id="ticket-category" value={category} onChange={(event) => setCategory(event.target.value as SupportTicketCategory)}>
              {CLIENT_TICKET_CATEGORY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Select>
          </Field>
          <Field label="Servidor relacionado" htmlFor="ticket-server" hint="Opcional"><Select id="ticket-server" value={serverId} onChange={(event) => setServerId(event.target.value)}><option value="">Nenhum</option>{servers?.map((server) => <option key={server.id} value={server.id}>{server.name} ({server.shortId})</option>)}</Select></Field>
          <Field label="Mensagem" htmlFor="ticket-message" required><Textarea id="ticket-message" rows={7} maxLength={5000} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Descreva o problema, quando começou e o que você já tentou." /></Field>
        </div>
      </Modal>
    </>
  );
}
