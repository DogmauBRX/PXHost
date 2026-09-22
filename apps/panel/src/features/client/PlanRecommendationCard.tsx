import { Lightbulb } from 'lucide-react';
import type { ClientPlan } from '@/shared/api/types';
import { Card, CardBody } from '@/ui/primitives';
import { formatMemory, formatRange } from '@/shared/format/plan';

interface PlanRecommendationCardProps {
  planName: string;
  /** The SERVER's own memoryMb (the snapshot truth), not the plan's — a plan can drift after the server was created. */
  memoryMb: number;
  plan: ClientPlan;
}

/**
 * Renders the user's exact copy: "Seu plano X possui Y de RAM. Recomendamos
 * aproximadamente: ..." Returns null when the plan publishes no
 * recommendation at all, rather than an empty card — a plan is free to
 * simply not have this metadata yet.
 */
export function PlanRecommendationCard({ planName, memoryMb, plan }: PlanRecommendationCardProps) {
  const players = formatRange(plan.recommendedPlayersMin, plan.recommendedPlayersMax);

  const rows: { icon: string; label: string; value: string }[] = [];
  if (players) rows.push({ icon: '👥', label: 'jogadores', value: players });

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardBody className="flex gap-3">
        <Lightbulb className="mt-0.5 h-5 w-5 shrink-0 text-warn" aria-hidden="true" />
        <div className="min-w-0 text-sm text-text">
          <p>
            Seu plano <span className="font-semibold">{planName}</span> possui <span className="font-semibold">{formatMemory(memoryMb)}</span> de RAM.
          </p>
          <p className="mt-1 text-text-muted">Recomendamos aproximadamente:</p>
          <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
            {rows.map((r) => (
              <li key={r.label} className="flex items-center gap-1.5">
                <span aria-hidden="true">{r.icon}</span>
                <span className="font-medium text-text">{r.value}</span>
                <span className="text-text-faint">{r.label}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-text-faint">
            Esse valor é uma recomendação e pode variar dependendo do mapa e da configuração do servidor.
          </p>
        </div>
      </CardBody>
    </Card>
  );
}
