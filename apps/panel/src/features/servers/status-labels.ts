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

// `Server.powerState` / the agent's own runtime state (srv.State) -> pt-BR.
// A DIFFERENT axis from SERVER_STATUS_LABELS above: that one is the row's
// lifecycle (installing/ready/suspended/...), this one is whether the
// container is up right now. `crashed` only started reaching the UI once
// the agent learned to notice a container dying on its own
// (agent/internal/srv/crash.go) — before that, a crashed server sat on
// "running" forever.
export const POWER_STATE_LABELS: Record<string, string> = {
  running: 'Ativo',
  starting: 'Iniciando',
  stopping: 'Parando',
  offline: 'Desligado',
  crashed: 'Caiu',
};

export function powerStateLabel(state: string): string {
  return POWER_STATE_LABELS[state] ?? state.replace(/_/g, ' ');
}
