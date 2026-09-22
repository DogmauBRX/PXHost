import { useQuery } from '@tanstack/react-query';
import { Layers } from 'lucide-react';
import { listServers } from '@/features/servers/servers.api';
import { PlanRecommendationCard } from './PlanRecommendationCard';
import { Card, CardBody, CardHeader, CardTitle, EmptyState, LoadingRow, PageHeader } from '@/ui/primitives';

export function PlanPage() {
  const { data: servers, isLoading: loadingServers } = useQuery({ queryKey: ['servers'], queryFn: listServers });

  return (
    <>
      <PageHeader title="Meu Plano" subtitle="Recursos aplicados aos seus servidores." />

      <h2 className="mb-3 text-sm font-semibold text-text">Seu plano atual</h2>
      {loadingServers ? (
        <LoadingRow />
      ) : !servers || servers.length === 0 ? (
        <EmptyState icon={Layers} title="Nenhum servidor ainda" description="O plano aparece aqui assim que você tiver um servidor." />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {servers.map((s) => (
            <Card key={s.id}>
              <CardHeader>
                <CardTitle>{s.plan?.name ?? s.name}</CardTitle>
              </CardHeader>
              <CardBody className="space-y-3">
                <div className="space-y-1 text-sm text-text-muted">
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
                </div>
                {s.plan && <PlanRecommendationCard planName={s.plan.name} memoryMb={s.memoryMb} plan={s.plan} />}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

    </>
  );
}
