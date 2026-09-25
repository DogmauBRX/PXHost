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
  server_offline: 'Servidor desligado ou indisponível',
  server_error: 'Erro para iniciar ou usar o servidor',
  performance_mods: 'Lentidão, desempenho ou mods',
  billing: 'Pagamento, cobrança ou assinatura',
  account_access: 'Conta, acesso ou segurança',
  general_question: 'Dúvida ou outro assunto',
};

export const CLIENT_TICKET_CATEGORY_OPTIONS: { value: SupportTicketCategory; label: string; priority: SupportTicketPriority }[] = [
  { value: 'server_offline', label: 'Servidor desligado ou indisponível', priority: 'urgent' },
  { value: 'server_error', label: 'Erro para iniciar ou usar o servidor', priority: 'high' },
  { value: 'performance_mods', label: 'Lentidão, desempenho ou mods', priority: 'normal' },
  { value: 'billing', label: 'Pagamento, cobrança ou assinatura', priority: 'normal' },
  { value: 'account_access', label: 'Conta, acesso ou segurança', priority: 'high' },
  { value: 'general_question', label: 'Dúvida ou outro assunto', priority: 'low' },
];
