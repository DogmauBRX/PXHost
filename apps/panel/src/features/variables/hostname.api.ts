import { apiFetch } from '@/shared/api/client';

export function updateServerHostname(serverId: string, hostname: string | null) {
  return apiFetch<{ customHostname: string | null }>(`/api/client/servers/${serverId}/hostname`, {
    method: 'PATCH',
    body: JSON.stringify({ hostname }),
  });
}
