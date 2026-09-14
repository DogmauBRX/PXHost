// `Server.status` -> pt-BR label, the one place this mapping exists.
// `AdminServersPage` used to keep its own copy of most of this map —
// deleted in favor of importing this. `StatusBadge` (ui/primitives/
// Badge.tsx) never imports this directly — it takes an optional `label`
// override instead, so the design-system layer stays free of domain
// vocabulary; every server-status call site passes
// `serverStatusLabel(status)` explicitly.
export const SERVER_STATUS_LABELS: Record<string, string> = {
  setup_pending: 'Configuração pendente',
  installing: 'Preparando',
  install_failed: 'Falha na instalação',
  ready: 'Pronto',
  suspended: 'Suspenso',
  restoring_backup: 'Restaurando backup',
  transferring: 'Transferindo',
  deleting: 'Excluindo',
};

export function serverStatusLabel(status: string): string {
  return SERVER_STATUS_LABELS[status] ?? status.replace(/_/g, ' ');
}
