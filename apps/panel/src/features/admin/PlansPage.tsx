import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, Plus } from 'lucide-react';
import { applyPlan, createPlan, getPlanCapacity, getPlanDrift, listPlans, updatePlan, type CreatePlanInput } from './admin.api';
import { ApiError } from '@/shared/api/client';
import type { AdminPlan, PlanApplyResult, PlanDriftReport } from '@/shared/api/types';
import { discountPercent, formatPrice, formatRange } from '@/shared/format/plan';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Field,
  Input,
  LoadingRow,
  Modal,
  PageHeader,
  Select,
  Textarea,
} from '@/ui/primitives';

// ---- create/edit form (shared shape) ----

interface PlanFormValues {
  name: string;
  slug: string;
  description: string;
  isPublic: boolean;
  sortOrder: string;
  priceReais: string;
  compareAtPriceReais: string;
  currency: string;
  billingPeriod: string;
  planFamily: string;
  cpuVcpu: string;
  memoryGb: string;
  swapMb: string;
  diskGb: string;
  ioWeight: string;
  maxDatabases: string;
  maxBackups: string;
  backupRetentionDays: string;
  maxAllocations: string;
  maxSchedules: string;
  maxServers: string;
  maxSlots: string;
  isFeatured: boolean;
  highlightLabel: string;
  recommendedPlayersMin: string;
  recommendedPlayersMax: string;
  recommendedModsMin: string;
  recommendedModsMax: string;
  recommendedPluginsMin: string;
  recommendedPluginsMax: string;
}

const EMPTY_FORM: PlanFormValues = {
  name: '',
  slug: '',
  description: '',
  isPublic: true,
  sortOrder: '0',
  priceReais: '',
  compareAtPriceReais: '',
  currency: 'BRL',
  billingPeriod: 'monthly',
  planFamily: '',
  cpuVcpu: '1',
  memoryGb: '1',
  swapMb: '0',
  diskGb: '5',
  ioWeight: '500',
  maxDatabases: '0',
  maxBackups: '0',
  backupRetentionDays: '7',
  maxAllocations: '1',
  maxSchedules: '5',
  maxServers: '',
  maxSlots: '',
  isFeatured: false,
  highlightLabel: '',
  recommendedPlayersMin: '',
  recommendedPlayersMax: '',
  recommendedModsMin: '',
  recommendedModsMax: '',
  recommendedPluginsMin: '',
  recommendedPluginsMax: '',
};

function planToForm(p: AdminPlan): PlanFormValues {
  return {
    name: p.name,
    slug: p.slug,
    description: p.description ?? '',
    isPublic: p.isPublic,
    sortOrder: String(p.sortOrder),
    priceReais: (p.priceCents / 100).toString(),
    compareAtPriceReais: p.compareAtPriceCents != null ? (p.compareAtPriceCents / 100).toString() : '',
    currency: p.currency,
    billingPeriod: p.billingPeriod,
    planFamily: p.planFamily ?? '',
    cpuVcpu: percentToVcpu(p.cpuLimitPercent),
    memoryGb: mbToGb(p.memoryMb),
    swapMb: String(p.swapMb),
    diskGb: mbToGb(p.diskMb),
    ioWeight: String(p.ioWeight),
    maxDatabases: String(p.maxDatabases),
    maxBackups: String(p.maxBackups),
    backupRetentionDays: String(p.backupRetentionDays),
    maxAllocations: String(p.maxAllocations),
    maxSchedules: String(p.maxSchedules),
    maxServers: p.maxServers != null ? String(p.maxServers) : '',
    maxSlots: p.maxSlots != null ? String(p.maxSlots) : '',
    isFeatured: p.isFeatured,
    highlightLabel: p.highlightLabel ?? '',
    recommendedPlayersMin: p.recommendedPlayersMin != null ? String(p.recommendedPlayersMin) : '',
    recommendedPlayersMax: p.recommendedPlayersMax != null ? String(p.recommendedPlayersMax) : '',
    recommendedModsMin: p.recommendedModsMin != null ? String(p.recommendedModsMin) : '',
    recommendedModsMax: p.recommendedModsMax != null ? String(p.recommendedModsMax) : '',
    recommendedPluginsMin: p.recommendedPluginsMin != null ? String(p.recommendedPluginsMin) : '',
    recommendedPluginsMax: p.recommendedPluginsMax != null ? String(p.recommendedPluginsMax) : '',
  };
}

// number-or-undefined for an optional field left blank
function n(v: string): number | undefined {
  const t = v.trim();
  return t === '' ? undefined : Number(t);
}

// Every price field's own placeholder shows the Brazilian comma-decimal
// convention ("49,90") — an admin typing that literally, as prompted,
// produced `Number("49,90")` === NaN before this existed, which
// silently cleared the price on save. `Number()` itself only ever
// accepts a period, so both formats need normalizing here, not just
// the one the placeholder happens to suggest.
function parseReais(v: string): number {
  return Number(v.trim().replace(',', '.'));
}

// The form edits CPU/memória/disco the way an admin thinks about them
// (vCPUs, GB) — Plan.cpuLimitPercent/memoryMb/diskMb themselves stay in
// the API's own units (a Docker cgroup quota where 100 = one full core,
// and MB), same convention formatVcpu/formatMemory already use for
// read-only display elsewhere. Conversion happens only at this form's
// two boundaries: planToForm (load) and toInput (save) below.
function percentToVcpu(percent: number): string {
  const vcpu = percent / 100;
  return Number.isInteger(vcpu) ? String(vcpu) : String(Number(vcpu.toFixed(2)));
}

function vcpuToPercent(v: string): number {
  return Math.round(Number(v.trim().replace(',', '.')) * 100);
}

function mbToGb(mb: number): string {
  const gb = mb / 1024;
  return Number.isInteger(gb) ? String(gb) : String(Number(gb.toFixed(2)));
}

function gbToMb(v: string): number {
  return Math.round(Number(v.trim().replace(',', '.')) * 1024);
}

function toInput(v: PlanFormValues): CreatePlanInput {
  return {
    name: v.name.trim(),
    slug: v.slug.trim(),
    description: v.description.trim() || undefined,
    isPublic: v.isPublic,
    sortOrder: n(v.sortOrder),
    priceCents: v.priceReais.trim() ? Math.round(parseReais(v.priceReais) * 100) : undefined,
    compareAtPriceCents: v.compareAtPriceReais.trim() ? Math.round(parseReais(v.compareAtPriceReais) * 100) : undefined,
    currency: v.currency,
    billingPeriod: v.billingPeriod,
    planFamily: v.planFamily.trim() || undefined,
    cpuLimitPercent: v.cpuVcpu.trim() ? vcpuToPercent(v.cpuVcpu) : undefined,
    memoryMb: gbToMb(v.memoryGb),
    swapMb: n(v.swapMb),
    diskMb: gbToMb(v.diskGb),
    ioWeight: n(v.ioWeight),
    maxDatabases: n(v.maxDatabases),
    maxBackups: n(v.maxBackups),
    backupRetentionDays: n(v.backupRetentionDays),
    maxAllocations: n(v.maxAllocations),
    maxSchedules: n(v.maxSchedules),
    maxServers: n(v.maxServers),
    maxSlots: n(v.maxSlots),
    isFeatured: v.isFeatured,
    highlightLabel: v.highlightLabel.trim() || undefined,
    recommendedPlayersMin: n(v.recommendedPlayersMin),
    recommendedPlayersMax: n(v.recommendedPlayersMax),
    recommendedModsMin: n(v.recommendedModsMin),
    recommendedModsMax: n(v.recommendedModsMax),
    recommendedPluginsMin: n(v.recommendedPluginsMin),
    recommendedPluginsMax: n(v.recommendedPluginsMax),
  };
}

function isValid(v: PlanFormValues): boolean {
  if (!v.name.trim() || !v.slug.trim() || !v.memoryGb.trim() || !v.diskGb.trim()) return false;
  const ranges: [string, string][] = [
    [v.recommendedPlayersMin, v.recommendedPlayersMax],
    [v.recommendedModsMin, v.recommendedModsMax],
    [v.recommendedPluginsMin, v.recommendedPluginsMax],
  ];
  if (!ranges.every(([min, max]) => n(min) == null || n(max) == null || n(min)! <= n(max)!)) return false;
  // Mirrors the API's plans_compare_at_price_check — an anchor price
  // that isn't actually higher than the real price would just 400 on
  // submit; catching it here means the "Salvar" button itself reflects
  // the invalid state instead of a round trip to find out.
  const price = v.priceReais.trim() ? parseReais(v.priceReais) : 0;
  const comparePrice = v.compareAtPriceReais.trim() ? parseReais(v.compareAtPriceReais) : null;
  if (Number.isNaN(price) || (comparePrice != null && Number.isNaN(comparePrice))) return false;
  if (comparePrice != null && comparePrice <= price) return false;
  return true;
}

function RangeField({
  label,
  hint,
  min,
  max,
  onMin,
  onMax,
}: {
  label: string;
  hint: string;
  min: string;
  max: string;
  onMin: (v: string) => void;
  onMax: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-text">{label}</label>
      <div className="flex items-center gap-2">
        <Input value={min} onChange={(e) => onMin(e.target.value)} placeholder="mín." className="w-24" />
        <span className="text-text-faint">–</span>
        <Input value={max} onChange={(e) => onMax(e.target.value)} placeholder="máx." className="w-24" />
      </div>
      <p className="text-xs text-text-faint">{hint}</p>
    </div>
  );
}

function PlanFormModal({ open, mode, plan, onClose }: { open: boolean; mode: 'create' | 'edit'; plan: AdminPlan | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<PlanFormValues>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setValues(plan ? planToForm(plan) : EMPTY_FORM);
      setError(null);
    }
  }, [open, plan]);

  function patch(p: Partial<PlanFormValues>) {
    setValues((v) => ({ ...v, ...p }));
  }

  async function handleSave() {
    if (!isValid(values)) return;
    setSaving(true);
    setError(null);
    try {
      const input = toInput(values);
      if (mode === 'create') await createPlan(input);
      else if (plan) {
        // UpdatePlanDto forbids `slug` (immutable once created, same rule
        // the disabled Slug field above enforces) — the API 400s
        // ("property slug should not exist") if it's present at all, so
        // it can't just ride along unused like the other create-only
        // fields below.
        const { slug: _slug, ...updateInput } = input;
        await updatePlan(plan.id, updateInput);
      }
      void queryClient.invalidateQueries({ queryKey: ['admin', 'plans'] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar o plano.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'create' ? 'Novo plano' : `Editar “${plan?.name}”`}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" disabled={!isValid(values) || saving} onClick={() => void handleSave()}>
            {saving ? 'Salvando…' : 'Salvar plano'}
          </Button>
        </>
      }
    >
      {error && (
        <Alert className="mb-4" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <div className="space-y-6">
        <fieldset className="space-y-4">
          <legend className="text-xs font-semibold tracking-wide text-text-faint uppercase">Identificação</legend>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Nome" htmlFor="plan-name" required>
              <Input id="plan-name" value={values.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Intermediário" />
            </Field>
            <Field label="Slug" htmlFor="plan-slug" required hint={mode === 'edit' ? 'Não pode ser alterado depois de criado.' : undefined}>
              <Input id="plan-slug" value={values.slug} onChange={(e) => patch({ slug: e.target.value })} placeholder="medio" disabled={mode === 'edit'} />
            </Field>
            <Field label="Ordem de exibição" htmlFor="plan-sort" hint="Menor aparece primeiro.">
              <Input id="plan-sort" value={values.sortOrder} onChange={(e) => patch({ sortOrder: e.target.value })} />
            </Field>
            <div className="flex items-center gap-2 pt-6">
              <input
                id="plan-public"
                type="checkbox"
                checked={values.isPublic}
                onChange={(e) => patch({ isPublic: e.target.checked })}
                className="h-4 w-4 rounded border-border-strong text-accent accent-accent"
              />
              <label htmlFor="plan-public" className="text-sm text-text">
                Público (visível para clientes)
              </label>
            </div>
            <div className="flex items-center gap-2 pt-6">
              <input
                id="plan-featured"
                type="checkbox"
                checked={values.isFeatured}
                onChange={(e) => patch({ isFeatured: e.target.checked })}
                className="h-4 w-4 rounded border-border-strong text-accent accent-accent"
              />
              <label htmlFor="plan-featured" className="text-sm text-text">
                Destacar no site comercial
              </label>
            </div>
            <Field
              label="Selo de destaque"
              htmlFor="plan-highlight-label"
              hint={values.isFeatured ? 'Deixe em branco para usar "Mais popular".' : 'Só é exibido quando o plano está marcado como destaque.'}
            >
              <Input
                id="plan-highlight-label"
                value={values.highlightLabel}
                onChange={(e) => patch({ highlightLabel: e.target.value })}
                placeholder="Mais popular"
                disabled={!values.isFeatured}
              />
            </Field>
            <Field label="Descrição" htmlFor="plan-description" className="sm:col-span-2">
              <Textarea id="plan-description" value={values.description} onChange={(e) => patch({ description: e.target.value })} rows={2} />
            </Field>
          </div>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="text-xs font-semibold tracking-wide text-text-faint uppercase">Comercial</legend>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Preço (R$)" htmlFor="plan-price">
              <Input id="plan-price" value={values.priceReais} onChange={(e) => patch({ priceReais: e.target.value })} placeholder="49,90" />
            </Field>
            <Field
              label="Preço “de” (R$, opcional)"
              htmlFor="plan-compare-price"
              hint="Mostrado riscado no site, com o desconto calculado. Deixe em branco para não exibir."
            >
              <Input
                id="plan-compare-price"
                value={values.compareAtPriceReais}
                onChange={(e) => patch({ compareAtPriceReais: e.target.value })}
                placeholder="69,90"
              />
            </Field>
            <Field label="Moeda" htmlFor="plan-currency">
              <Select id="plan-currency" value={values.currency} onChange={(e) => patch({ currency: e.target.value })}>
                <option value="BRL">BRL</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
              </Select>
            </Field>
            <Field label="Período" htmlFor="plan-period">
              <Select id="plan-period" value={values.billingPeriod} onChange={(e) => patch({ billingPeriod: e.target.value })}>
                <option value="monthly">Mensal</option>
                <option value="quarterly">Trimestral</option>
                <option value="semiannual">Semestral</option>
                <option value="annual">Anual</option>
              </Select>
            </Field>
            <Field
              label="Família (ciclos)"
              htmlFor="plan-family"
              hint="Dois planos com a mesma família viram um único produto com seletor de ciclo no checkout. Deixe em branco para um plano de ciclo único."
            >
              <Input id="plan-family" value={values.planFamily} onChange={(e) => patch({ planFamily: e.target.value })} placeholder="basico" />
            </Field>
          </div>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="text-xs font-semibold tracking-wide text-text-faint uppercase">Recursos</legend>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Field label="CPU (vCPUs)" htmlFor="plan-cpu" required hint="1 vCPU = 100% de um núcleo.">
              <Input id="plan-cpu" value={values.cpuVcpu} onChange={(e) => patch({ cpuVcpu: e.target.value })} placeholder="1" />
            </Field>
            <Field label="Memória (GB)" htmlFor="plan-mem" required>
              <Input id="plan-mem" value={values.memoryGb} onChange={(e) => patch({ memoryGb: e.target.value })} placeholder="2" />
            </Field>
            <Field label="Swap (MB)" htmlFor="plan-swap">
              <Input id="plan-swap" value={values.swapMb} onChange={(e) => patch({ swapMb: e.target.value })} />
            </Field>
            <Field label="Disco (GB)" htmlFor="plan-disk" required>
              <Input id="plan-disk" value={values.diskGb} onChange={(e) => patch({ diskGb: e.target.value })} placeholder="5" />
            </Field>
            <Field label="Peso de I/O" htmlFor="plan-io">
              <Input id="plan-io" value={values.ioWeight} onChange={(e) => patch({ ioWeight: e.target.value })} />
            </Field>
          </div>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="text-xs font-semibold tracking-wide text-text-faint uppercase">Limites</legend>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Field label="Máx. bancos de dados" htmlFor="plan-maxdb">
              <Input id="plan-maxdb" value={values.maxDatabases} onChange={(e) => patch({ maxDatabases: e.target.value })} />
            </Field>
            <Field label="Máx. backups" htmlFor="plan-maxbackups">
              <Input id="plan-maxbackups" value={values.maxBackups} onChange={(e) => patch({ maxBackups: e.target.value })} />
            </Field>
            <Field label="Retenção de backup (dias)" htmlFor="plan-retention">
              <Input id="plan-retention" value={values.backupRetentionDays} onChange={(e) => patch({ backupRetentionDays: e.target.value })} />
            </Field>
            <Field label="Máx. alocações" htmlFor="plan-maxalloc">
              <Input id="plan-maxalloc" value={values.maxAllocations} onChange={(e) => patch({ maxAllocations: e.target.value })} />
            </Field>
            <Field label="Máx. agendamentos" htmlFor="plan-maxsched">
              <Input id="plan-maxsched" value={values.maxSchedules} onChange={(e) => patch({ maxSchedules: e.target.value })} />
            </Field>
            <Field label="Número de servidores" htmlFor="plan-maxservers" hint="Exibido ao cliente; não é aplicado automaticamente.">
              <Input id="plan-maxservers" value={values.maxServers} onChange={(e) => patch({ maxServers: e.target.value })} placeholder="ilimitado" />
            </Field>
            <Field label="Vagas (estoque)" htmlFor="plan-maxslots" hint="Máximo de servidores neste plano, no total. Reduzir não afeta servidores existentes.">
              <Input id="plan-maxslots" value={values.maxSlots} onChange={(e) => patch({ maxSlots: e.target.value })} placeholder="ilimitado" />
            </Field>
          </div>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="text-xs font-semibold tracking-wide text-text-faint uppercase">Recomendações (exibidas ao cliente)</legend>
          <p className="text-xs text-text-faint">
            Deixe o campo máximo em branco para exibir “80+”. Deixe os dois em branco para não exibir essa recomendação.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <RangeField
              label="👥 Jogadores"
              hint="Ex.: 15–30"
              min={values.recommendedPlayersMin}
              max={values.recommendedPlayersMax}
              onMin={(v) => patch({ recommendedPlayersMin: v })}
              onMax={(v) => patch({ recommendedPlayersMax: v })}
            />
            <RangeField
              label="🧩 Mods"
              hint="Ex.: 30–80"
              min={values.recommendedModsMin}
              max={values.recommendedModsMax}
              onMin={(v) => patch({ recommendedModsMin: v })}
              onMax={(v) => patch({ recommendedModsMax: v })}
            />
            <RangeField
              label="🔌 Plugins"
              hint="Ex.: 15–40"
              min={values.recommendedPluginsMin}
              max={values.recommendedPluginsMax}
              onMin={(v) => patch({ recommendedPluginsMin: v })}
              onMax={(v) => patch({ recommendedPluginsMax: v })}
            />
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}

// ---- drift/apply, unchanged behavior, moved out of the save modal ----

function PlanDriftPanel({ planId }: { planId: string }) {
  const [drift, setDrift] = useState<PlanDriftReport | null>(null);
  const [applyResult, setApplyResult] = useState<PlanApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blockedNodes = drift?.capacity.filter((c) => !c.fits) ?? [];

  async function handleDryRun() {
    setBusy(true);
    setError(null);
    try {
      setApplyResult(null);
      setDrift(await getPlanDrift(planId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível calcular o dry run.');
    } finally {
      setBusy(false);
    }
  }

  async function handleApply() {
    setBusy(true);
    setError(null);
    try {
      setApplyResult(await applyPlan(planId));
      setDrift(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível aplicar o plano.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4">
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void handleDryRun()}>
        Ver dry run
      </Button>

      {error && <Alert>{error}</Alert>}

      {drift && (
        <div className="rounded-lg bg-surface-2 p-3">
          <p className="mb-2 text-sm text-text">
            {drift.affectedCount === 0 ? 'Nenhum servidor divergiria deste plano.' : `${drift.affectedCount} servidor(es) seriam alterados:`}
          </p>
          {drift.servers.map((s) => (
            <div key={s.serverId} className="mb-1 text-xs text-text-muted">
              <span className="font-medium text-text">{s.serverName}</span>
              {': '}
              {s.changes.map((c) => `${c.field} ${String(c.from)}→${String(c.to)}`).join(', ')}
            </div>
          ))}
          {/* Capacity plan Fase 6 — the wall shown BEFORE the click, not discovered as a 409 after it. */}
          {drift.capacity.length > 0 && (
            <div className="mt-3 space-y-1 border-t border-border pt-2">
              {drift.capacity.map((c) => (
                <p key={c.nodeId} className={`text-xs ${c.fits ? 'text-text-faint' : 'text-fail'}`}>
                  {c.fits ? `${c.nodeName}: cabe` : `${c.nodeName}: não cabe — ${c.reasons.join('; ')}`}
                </p>
              ))}
            </div>
          )}
          {drift.affectedCount > 0 && (
            <>
              {blockedNodes.length > 0 && (
                <Alert tone="warn" className="mt-2">
                  Aplicar excederia a capacidade em {blockedNodes.length} node(s) — nada será alterado até isso ser resolvido.
                </Alert>
              )}
              <Button variant="danger" size="sm" disabled={busy || blockedNodes.length > 0} onClick={() => void handleApply()} className="mt-2">
                Aplicar a {drift.affectedCount} servidor(es)
              </Button>
            </>
          )}
        </div>
      )}

      {applyResult && (
        <div className="rounded-lg bg-surface-2 p-3 text-sm text-text">
          <p>{applyResult.appliedCount} servidor(es) atualizado(s).</p>
          {applyResult.failures.length > 0 && (
            <p className="text-fail">
              {applyResult.failures.length} falha(s): {applyResult.failures.map((f) => f.error).join('; ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---- page ----

export function PlansPage() {
  const { data: plans, isLoading, isError } = useQuery({ queryKey: ['admin', 'plans'], queryFn: listPlans });
  const { data: occupancy } = useQuery({ queryKey: ['admin', 'capacity', 'plans'], queryFn: getPlanCapacity });
  const occupancyById = new Map((occupancy ?? []).map((o) => [o.id, o]));
  const [formOpen, setFormOpen] = useState<{ mode: 'create' | 'edit'; plan: AdminPlan | null } | null>(null);
  const [driftOpenId, setDriftOpenId] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Plans"
        subtitle="Perfis de recursos e recomendações que definem o que cada servidor pode usar."
        actions={
          <Button variant="primary" onClick={() => setFormOpen({ mode: 'create', plan: null })}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Novo plano
          </Button>
        }
      />

      {isError && <Alert className="mb-6">Não foi possível carregar os planos.</Alert>}

      {isLoading ? (
        <LoadingRow />
      ) : !plans || plans.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="Nenhum plano ainda"
          action={
            <Button variant="primary" onClick={() => setFormOpen({ mode: 'create', plan: null })}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Novo plano
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {plans.map((p) => {
            const players = formatRange(p.recommendedPlayersMin, p.recommendedPlayersMax);
            const mods = formatRange(p.recommendedModsMin, p.recommendedModsMax);
            const occ = occupancyById.get(p.id);
            // Capacity plan (auto-derivation) §6/§11 — `effectiveSlots` is
            // min(capacidade real dos nodes, maxSlots) whenever occ is
            // loaded; `null` means genuinely unlimited (no maxSlots AND
            // every eligible node unlimited). The physical number is
            // called out separately only when it's the TIGHTER of the
            // two — i.e. the admin's commercial ceiling is unrealistic.
            const physicalTighter = occ && p.maxSlots != null && occ.derivedSlots != null && occ.derivedSlots < p.maxSlots;
            return (
              <Card key={p.id}>
                <CardBody>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-text">{p.name}</p>
                        {!p.isPublic && <Badge tone="neutral">privado</Badge>}
                        {p.isFeatured && <Badge tone="ok">{p.highlightLabel ?? 'destaque'}</Badge>}
                        {discountPercent(p.priceCents, p.compareAtPriceCents) != null && (
                          <Badge tone="warn">{discountPercent(p.priceCents, p.compareAtPriceCents)}% off</Badge>
                        )}
                        {occ && (
                          <Badge tone={occ.effectiveSlots != null && occ.occupied >= occ.effectiveSlots ? 'fail' : physicalTighter ? 'warn' : 'neutral'}>
                            {occ.occupied} / {occ.effectiveSlots ?? '∞'} vaga{occ.effectiveSlots === 1 ? '' : 's'}
                          </Badge>
                        )}
                        {physicalTighter && (
                          <Badge tone="warn">capacidade física: {occ!.derivedSlots}</Badge>
                        )}
                      </div>
                      <p className="mt-0.5 font-mono text-xs text-text-faint">
                        {p.slug} · {p.memoryMb} MB RAM · {formatPrice(p.priceCents, p.currency)}/mês
                        {players && ` · 👥 ${players}`}
                        {mods && ` · 🧩 ${mods}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="secondary" size="sm" onClick={() => setFormOpen({ mode: 'edit', plan: p })}>
                        Editar
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDriftOpenId(driftOpenId === p.id ? null : p.id)}>
                        {driftOpenId === p.id ? 'Ocultar' : 'Aplicar'}
                      </Button>
                    </div>
                  </div>
                  {driftOpenId === p.id && <PlanDriftPanel planId={p.id} />}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      <PlanFormModal open={formOpen !== null} mode={formOpen?.mode ?? 'create'} plan={formOpen?.plan ?? null} onClose={() => setFormOpen(null)} />
    </>
  );
}
