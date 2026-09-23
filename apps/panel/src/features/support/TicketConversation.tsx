import type { ReactNode } from 'react';
import type { SupportTicketDetail } from '@/shared/api/types';
import { Badge } from '@/ui/primitives';
import { formatDateTimeShort } from '@/shared/format/datetime';
import { TICKET_CATEGORY_LABEL, TICKET_PRIORITY_LABEL, TICKET_PRIORITY_TONE, TICKET_STATUS_LABEL, TICKET_STATUS_TONE } from './ticket-labels';

export function TicketConversation({ ticket, actions, composer }: { ticket: SupportTicketDetail; actions?: ReactNode; composer?: ReactNode }) {
  return (
    <section className="flex min-h-[32rem] flex-col overflow-hidden rounded-card border border-border bg-surface">
      <header className="border-b border-border p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge tone={TICKET_STATUS_TONE[ticket.status]}>{TICKET_STATUS_LABEL[ticket.status]}</Badge>
              <Badge tone={TICKET_PRIORITY_TONE[ticket.priority]}>{TICKET_PRIORITY_LABEL[ticket.priority]}</Badge>
            </div>
            <h2 className="text-lg font-semibold text-text">{ticket.subject}</h2>
            <p className="mt-1 text-xs text-text-muted">
              {TICKET_CATEGORY_LABEL[ticket.category]}
              {ticket.server && ` · ${ticket.server.name} (${ticket.server.shortId})`}
            </p>
          </div>
          {actions}
        </div>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto bg-bg/40 p-5">
        {ticket.messages.map((message) => (
          <article key={message.id} className={`flex ${message.isStaff ? 'justify-start' : 'justify-end'}`}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-3 ${message.isStaff ? 'rounded-tl-sm border border-border bg-surface' : 'rounded-tr-sm bg-accent text-accent-contrast'}`}>
              <div className={`mb-1 flex items-center gap-2 text-xs ${message.isStaff ? 'text-text-muted' : 'text-accent-contrast/80'}`}>
                <span className="font-semibold">{message.isStaff ? `Equipe · ${message.author.username}` : message.author.username}</span>
                <span>{formatDateTimeShort(message.createdAt)}</span>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-6">{message.body}</p>
            </div>
          </article>
        ))}
      </div>

      {composer && <footer className="border-t border-border p-4">{composer}</footer>}
    </section>
  );
}
