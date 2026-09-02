import { apiFetch } from '@/shared/api/client';
import type { AssistantMessage, AssistantReply, AssistantSuggestion } from '@/shared/api/types';

export function sendAssistantMessage(serverId: string, message: string, history: AssistantMessage[]) {
  return apiFetch<AssistantReply>('/api/client/assistant/chat', {
    method: 'POST',
    body: JSON.stringify({ serverId, message, history }),
  });
}

export function getAssistantSuggestions(serverId: string) {
  return apiFetch<AssistantSuggestion[]>(`/api/client/assistant/suggestions?serverId=${serverId}`);
}
