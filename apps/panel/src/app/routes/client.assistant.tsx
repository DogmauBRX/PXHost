import { createFileRoute } from '@tanstack/react-router';
import { AssistantPage } from '@/features/assistant/AssistantPage';

export const Route = createFileRoute('/client/assistant')({
  component: AssistantPage,
});
