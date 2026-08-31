import { createFileRoute } from '@tanstack/react-router';
import { ServersPage } from '@/features/servers/ServersPage';

export const Route = createFileRoute('/client/servers/')({
  component: ServersPage,
});
