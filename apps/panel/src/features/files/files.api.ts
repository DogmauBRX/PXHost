import { apiFetch } from '@/shared/api/client';
import type { FileEntry, TransferLink } from '@/shared/api/types';

const base = (serverId: string) => `/api/client/servers/${serverId}/files`;

export function listFiles(serverId: string, path: string) {
  return apiFetch<FileEntry[]>(`${base(serverId)}?path=${encodeURIComponent(path)}`);
}

export function readFile(serverId: string, path: string) {
  return apiFetch<{ content: string }>(`${base(serverId)}/contents?path=${encodeURIComponent(path)}`);
}

export function writeFile(serverId: string, path: string, content: string) {
  return apiFetch<{ bytesWritten: number }>(`${base(serverId)}/contents?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
}

export function renameFile(serverId: string, from: string, to: string) {
  return apiFetch<void>(`${base(serverId)}/rename`, { method: 'POST', body: JSON.stringify({ from, to }) });
}

export function deleteFile(serverId: string, path: string, recursive: boolean) {
  return apiFetch<void>(`${base(serverId)}?path=${encodeURIComponent(path)}&recursive=${recursive}`, { method: 'DELETE' });
}

export function mkdir(serverId: string, path: string) {
  return apiFetch<void>(`${base(serverId)}/mkdir`, { method: 'POST', body: JSON.stringify({ path }) });
}

export function mintDownloadLink(serverId: string, path: string) {
  return apiFetch<TransferLink>(`${base(serverId)}/download-link`, { method: 'POST', body: JSON.stringify({ path }) });
}

export function mintUploadLink(serverId: string, path: string, maxBytes?: number) {
  return apiFetch<TransferLink>(`${base(serverId)}/upload-link`, { method: 'POST', body: JSON.stringify({ path, maxBytes }) });
}

export function chmod(serverId: string, path: string, mode: number) {
  return apiFetch<void>(`${base(serverId)}/chmod`, { method: 'POST', body: JSON.stringify({ path, mode }) });
}

export function compress(serverId: string, paths: string[], dest: string) {
  return apiFetch<void>(`${base(serverId)}/compress`, { method: 'POST', body: JSON.stringify({ paths, dest }) });
}

export function decompress(serverId: string, path: string, dest: string) {
  return apiFetch<{ extracted: number; skipped: string[] }>(`${base(serverId)}/decompress`, {
    method: 'POST',
    body: JSON.stringify({ path, dest }),
  });
}
