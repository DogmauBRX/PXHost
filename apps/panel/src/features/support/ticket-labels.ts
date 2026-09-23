import type { SupportTicketCategory, SupportTicketPriority, SupportTicketStatus } from '@/shared/api/types';

export const TICKET_STATUS_LABEL: Record<SupportTicketStatus, string> = {
  open: 'Aberto',
  in_progress: 'Em atendimento',
  waiting_customer: 'Aguardando você',
  closed: 'Fechado',
};

export const TICKET_STATUS_TONE: Record<SupportTicketStatus, 'ok' | 'warn' | 'fail' | 'neutral'> = {
  open: 'warn',
  in_progress: 'ok',
  waiting_customer: 'warn',
  closed: 'neutral',
};

export const TICKET_PRIORITY_LABEL: Record<SupportTicketPriority, string> = {
  low: 'Baixa',
  normal: 'Normal',
  high: 'Alta',
  urgent: 'Urgente',
};

export const TICKET_PRIORITY_TONE: Record<SupportTicketPriority, 'ok' | 'warn' | 'fail' | 'neutral'> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'warn',
  urgent: 'fail',
};

export const TICKET_CATEGORY_LABEL: Record<SupportTicketCategory, string> = {
  technical: 'Problema técnico',
  billing: 'Pagamento ou assinatura',
  account: 'Conta e acesso',
  other: 'Outro assunto',
};
