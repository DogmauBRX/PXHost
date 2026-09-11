import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Layers, TrendingUp } from 'lucide-react';
import { listServers } from '@/features/servers/servers.api';
import { listClientPlans } from './plans.api';
import { PlanRecommendationCard } from './PlanRecommendationCard';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, EmptyState, LoadingRow, PageHeader } from '@/ui/primitives';
import { formatBillingPeriod, formatMemory, formatPrice, formatRange } from '@/shared/format/plan';
import type { ClientPlan } from '@/shared/api/types';

interface PlanTierGroup {
  name: string;
  /** The variant shown on the card — the monthly one when there is one (matches what a visitor sees by default on the public catalog), else whichever variant is cheapest. */
  representative: ClientPlan;
}

/**
 * "Todos os planos" lists every PUBLISHED plan, but a tier normally has
 * one row per billing period (mensal, trimestral, ...) — shown separately
 * they read as different plans instead of cycles of the same one. Merge
 * by name into one card per tier, then rank tiers by RAM (same heuristic
 * the public catalog's hero-icon tier already uses — there's no separate
 * tier field on Plan, and RAM is the one number that reliably orders
 * "entry" below "top" regardless of what an admin names or prices a plan).
 */
function groupPlansByTier(plans: ClientPlan[]): PlanTierGroup[] {
  const byName = new Map<string, ClientPlan[]>();
  for (const plan of plans) {
    const variants = byName.get(plan.name) ?? [];
    variants.push(plan);
    byName.set(plan.name, variants);
  }
  const groups = Array.from(byName.entries()).map(([name, variants]) => ({
    name,
    representative: variants.find((v) => v.billingPeriod === 'monthly') ?? [...variants].sort((a, b) => a.priceCents - b.priceCents)[0],
  }));
  return groups.sort((a, b) => a.representative.memoryMb - b.representative.memoryMb);
}

/**
 * Two halves: "Seu plano atual" — the plan attached to each of the
 * customer's servers, with the resource limits actually applied (the
 * server's own memoryMb/diskMb/cpuLimitPercent, not the plan's own
 * definition — a plan can drift after a server was created, so the server
 * row is the ground truth for what that server can use today) — and
 * "Todos os planos," a comparison grid from the public catalog. This is
 * the destination the upsell card's "Ver planos" link points at.
 */
export function PlanPage() {
  const { data: servers, isLoading: loadingServers } = useQuery({ queryKey: ['servers'], queryFn: listServers });
  const { data: plans, isLoading: loadingPlans } = useQuery({ queryKey: ['client-plans'], queryFn: listClientPlans });

  const currentPlanNames = new Set((servers ?? []).map((s) => s.plan?.name).filter((name): name is string => Boolean(name)));

  const tierGroups = useMemo(() => groupPlansByTier(plans ?? []), [plans]);
  // The customer's BEST tier today, across every server they have — an
  // "upgrade" offer only makes sense above that, never above some lower
  // tier a server happens to also be on.
  const currentTierRank = useMemo(
    () => tierGroups.reduce((best, g, i) => (currentPlanNames.has(g.name) ? Math.max(best, i) : best), -1),
    [tierGroups, currentPlanNames],
  );

  return (
    <>
      <PageHeader title="Meu Plano" subtitle="Recursos aplicados a cada um dos seus servidores, e o catálogo completo." />

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
                {s.plan && <PlanRecommendationCard planName={s.plan.name} memoryMb={s.memoryMb} plan={s.plan} software={s.software} />}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <h2 className="mt-8 mb-3 text-sm font-semibold text-text">Todos os planos</h2>
      {loadingPlans ? (
        <LoadingRow />
      ) : !plans || plans.length === 0 ? (
        <EmptyState icon={Layers} title="Nenhum plano publicado" />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tierGroups.map((group, i) => {
            const p = group.representative;
            const isCurrent = currentPlanNames.has(group.name);
            const canUpgrade = i > currentTierRank;
            const players = formatRange(p.recommendedPlayersMin, p.recommendedPlayersMax);
            const mods = formatRange(p.recommendedModsMin, p.recommendedModsMax);
            const plugins = formatRange(p.recommendedPluginsMin, p.recommendedPluginsMax);
            return (
              <Card key={group.name} className={isCurrent ? 'border-accent' : undefined}>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <CardTitle>{p.name}</CardTitle>
                    {isCurrent && <Badge tone="ok">seu plano</Badge>}
                  </div>
                </CardHeader>
                <CardBody className="space-y-2">
                  <p className="text-2xl font-semibold text-text">
                    {formatPrice(p.priceCents, p.currency)}
                    <span className="text-sm font-normal text-text-faint">/{formatBillingPeriod(p.billingPeriod)}</span>
                  </p>
                  {p.description && <p className="text-sm text-text-muted">{p.description}</p>}
                  <ul className="space-y-1 text-sm text-text-muted">
                    <li>💾 {formatMemory(p.memoryMb)} de RAM</li>
                    <li>📀 {formatMemory(p.diskMb)} de disco</li>
                    <li>⚙️ {p.cpuLimitPercent}% de CPU</li>
                    {p.maxBackups > 0 && <li>🗄️ até {p.maxBackups} backups</li>}
                    {p.maxServers != null && <li>🖥️ até {p.maxServers} servidor(es)</li>}
                    {players && <li>👥 {players} jogadores</li>}
                    {mods && <li>🧩 {mods} mods</li>}
                    {plugins && <li>🔌 {plugins} plugins</li>}
                  </ul>
                  {canUpgrade && (
                    <Link to="/checkout/$planSlug" params={{ planSlug: p.slug }} className="block pt-1">
                      <Button variant="primary" className="w-full gap-1.5">
                        <TrendingUp className="h-4 w-4" aria-hidden="true" />
                        Fazer upgrade
                      </Button>
                    </Link>
                  )}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
