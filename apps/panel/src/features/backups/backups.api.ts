import { apiFetch } from '@/shared/api/client';
import type { BackupSummary, TransferLink } from '@/shared/api/types';

const base = (serverId: string) => `/api/client/servers/${serverId}/backups`;

export function listBackups(serverId: string) {
  return apiFetch<BackupSummary[]>(base(serverId));
}

export function createBackup(serverId: string, ignorePatterns?: string[]) {
  return apiFetch<BackupSummary>(base(serverId), { method: 'POST', body: JSON.stringify({ ignorePatterns }) });
}

export function deleteBackup(serverId: string, backupId: string) {
  return apiFetch<void>(`${base(serverId)}/${backupId}`, { method: 'DELETE' });
}

export function restoreBackup(serverId: string, backupId: string) {
  return apiFetch<void>(`${base(serverId)}/${backupId}/restore`, { method: 'POST' });
}

export function mintBackupDownloadLink(serverId: string, backupId: string) {
  return apiFetch<TransferLink>(`${base(serverId)}/${backupId}/download-link`, { method: 'POST' });
}
