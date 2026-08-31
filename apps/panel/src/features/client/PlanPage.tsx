import { useQuery } from '@tanstack/react-query';
import { Layers } from 'lucide-react';
import { listServers } from '@/features/servers/servers.api';
import { Card, CardBody, CardHeader, CardTitle, EmptyState, LoadingRow, PageHeader } from '@/ui/primitives';

/**
 * Shows the plan attached to each of the customer's servers, and the
 * resource limits actually applied — not a pricing/subscription page,
 * since this codebase has no billing system (see BillingPage). The
 * server's own memoryMb/diskMb/cpuLimitPercent are shown rather than the
 * plan's own definition, because those are the limits genuinely in effect
 * right now (a plan can drift after a server was created; the server row
 * is the ground truth for what that server can use today).
 */
export function PlanPage() {
  const { data, isLoading } = useQuery({ queryKey: ['servers'], queryFn: listServers });

  return (
    <>
      <PageHeader title="Plano" subtitle="Recursos aplicados a cada um dos seus servidores." />

      {isLoading ? (
        <LoadingRow />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Layers} title="Nenhum servidor ainda" description="O plano aparece aqui assim que você tiver um servidor." />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {data.map((s) => (
            <Card key={s.id}>
              <CardHeader>
                <CardTitle>{s.plan?.name ?? s.name}</CardTitle>
              </CardHeader>
              <CardBody className="space-y-1 text-sm text-text-muted">
                <p>
                  Servidor: <span className="text-text">{s.name}</span>
                </p>
                <p>
                  CPU: <span className="font-mono text-text">{s.cpuLimitPercent}%</span>
                </p>
                <p>
                  Memória: <span className="font-mono text-text">{s.memoryMb} MB</span>
                </p>
                <p>
                  Disco: <span className="font-mono text-text">{s.diskMb} MB</span>
                </p>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
