import { describeSoftware } from '../templates/software';

/**
 * Response shaping for client-facing server payloads — deliberately kept
 * OUT of `ServerAccessService` (~10 consumers today; it resolves
 * ownership/permissions, it does not format a response) and out of the
 * agent-facing admin service (which has its own shape). Lives here,
 * next to the one controller that actually needs it.
 */

interface ServerWithTemplate {
  template: { softwareKind: string | null } | null;
  [key: string]: unknown;
}

export function toClientServerSummary<T extends ServerWithTemplate>(row: T) {
  return { ...row, software: describeSoftware(row.template?.softwareKind ?? null) };
}

export function toClientServerDetail<T extends ServerWithTemplate>(
  row: T,
  role: 'owner' | 'subuser' | 'admin',
  permissions: string[],
) {
  return { ...toClientServerSummary(row), role, permissions };
}
