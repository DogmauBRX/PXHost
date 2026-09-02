import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { listServers } from '@/features/servers/servers.api';
import { AssistantChat } from './AssistantChat';
import { EmptyState, LoadingRow, PageHeader, Select } from '@/ui/primitives';

/** The standalone /client/assistant route — same AssistantChat the server-page drawer uses, just with a server picker up top since this page isn't scoped to one server the way the drawer is. */
export function AssistantPage() {
  const { data: servers, isLoading } = useQuery({ queryKey: ['servers'], queryFn: listServers });
  const [pickedServerId, setPickedServerId] = useState<string | null>(null);

  if (isLoading) return <LoadingRow />;

  if (!servers || servers.length === 0) {
    return (
      <>
        <PageHeader title="Assistente" />
        <EmptyState icon={Bot} title="Você ainda não tem servidores" description="Assim que tiver um servidor, o assistente pode ajudar com o dia a dia dele." />
      </>
    );
  }

  const activeServerId = pickedServerId ?? servers[0].id;

  return (
    <>
      <PageHeader
        title="Assistente"
        actions={
          servers.length > 1 ? (
            <Select value={activeServerId} onChange={(e) => setPickedServerId(e.target.value)} className="w-56">
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          ) : undefined
        }
      >
        <p className="mt-1 text-sm text-text-muted">Tire dúvidas sobre o dia a dia do seu servidor.</p>
      </PageHeader>

      <div className="flex h-[calc(100vh-260px)] min-h-[420px] flex-col rounded-card border border-border bg-surface p-4">
        {/* Keyed by server: switching servers should start a fresh conversation, not carry the old one's transcript into a different context. */}
        <AssistantChat key={activeServerId} serverId={activeServerId} />
      </div>
    </>
  );
}
