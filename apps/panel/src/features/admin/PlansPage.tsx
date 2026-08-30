import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers } from 'lucide-react';
import { applyPlan, createPlan, getPlanDrift, listPlans, updatePlan } from './admin.api';
import { ApiError } from '@/shared/api/client';
import type { PlanApplyResult, PlanDriftReport } from '@/shared/api/types';
import { Alert, Button, Card, CardBody, EmptyState, Field, Input, LoadingRow, PageHeader } from '@/ui/primitives';

function PlanEditor({ planId, onClose }: { planId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [memoryMb, setMemoryMb] = useState('');
  const [diskMb, setDiskMb] = useState('');
  const [cpuLimitPercent, setCpuLimitPercent] = useState('');
  const [drift, setDrift] = useState<PlanDriftReport | null>(null);
  const [applyResult, setApplyResult] = useState<PlanApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      const input: Record<string, number> = {};
      if (memoryMb.trim()) input.memoryMb = Number(memoryMb);
      if (diskMb.trim()) input.diskMb = Number(diskMb);
      if (cpuLimitPercent.trim()) input.cpuLimitPercent = Number(cpuLimitPercent);
      await updatePlan(planId, input);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'plans'] });
      setDrift(null);
      setApplyResult(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar o plano.');
    } finally {
      setBusy(false);
    }
  }

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
      const result = await applyPlan(planId);
      setApplyResult(result);
      setDrift(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível aplicar o plano.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 space-y-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="CPU (%)" htmlFor="edit-cpu" className="w-28">
          <Input id="edit-cpu" value={cpuLimitPercent} onChange={(e) => setCpuLimitPercent(e.target.value)} placeholder="sem alteração" />
        </Field>
        <Field label="Memória (MB)" htmlFor="edit-mem" className="w-28">
          <Input id="edit-mem" value={memoryMb} onChange={(e) => setMemoryMb(e.target.value)} placeholder="sem alteração" />
        </Field>
        <Field label="Disco (MB)" htmlFor="edit-disk" className="w-28">
          <Input id="edit-disk" value={diskMb} onChange={(e) => setDiskMb(e.target.value)} placeholder="sem alteração" />
        </Field>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void handleSave()}>
          Salvar plano
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void handleDryRun()}>
          Ver dry run
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Fechar
        </Button>
      </div>

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
          {drift.affectedCount > 0 && (
            <Button variant="danger" size="sm" disabled={busy} onClick={() => void handleApply()} className="mt-2">
              Aplicar a {drift.affectedCount} servidor(es)
            </Button>
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

export function PlansPage() {
  const queryClient = useQueryClient();
  const { data: plans, isLoading, isError } = useQuery({ queryKey: ['admin', 'plans'], queryFn: listPlans });
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [memoryMb, setMemoryMb] = useState('1024');
  const [diskMb, setDiskMb] = useState('5120');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    if (!name.trim() || !slug.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createPlan({ name: name.trim(), slug: slug.trim(), memoryMb: Number(memoryMb), diskMb: Number(diskMb) });
      setName('');
      setSlug('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'plans'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível criar o plano.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <PageHeader title="Plans" subtitle="Perfis de recursos que definem o que cada servidor pode usar." />

      <Card className="mb-6">
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Nome" htmlFor="plan-name" className="w-40">
            <Input id="plan-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Básico" />
          </Field>
          <Field label="Slug" htmlFor="plan-slug" className="w-32">
            <Input id="plan-slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="basico" />
          </Field>
          <Field label="Memória (MB)" htmlFor="plan-mem" className="w-28">
            <Input id="plan-mem" value={memoryMb} onChange={(e) => setMemoryMb(e.target.value)} />
          </Field>
          <Field label="Disco (MB)" htmlFor="plan-disk" className="w-28">
            <Input id="plan-disk" value={diskMb} onChange={(e) => setDiskMb(e.target.value)} />
          </Field>
          <Button variant="primary" disabled={creating || !name.trim() || !slug.trim()} onClick={() => void handleCreate()}>
            {creating ? 'Criando…' : 'Criar plano'}
          </Button>
        </CardBody>
      </Card>

      {error && <Alert className="mb-6">{error}</Alert>}
      {isError && <Alert className="mb-6">Não foi possível carregar os planos.</Alert>}

      {isLoading ? (
        <LoadingRow />
      ) : !plans || plans.length === 0 ? (
        <EmptyState icon={Layers} title="Nenhum plano ainda" description="Crie o primeiro acima." />
      ) : (
        <div className="space-y-3">
          {plans.map((p) => (
            <Card key={p.id}>
              <CardBody>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-text">{p.name}</p>
                    <p className="font-mono text-xs text-text-faint">
                      {p.slug} · {p.cpuLimitPercent}% CPU · {p.memoryMb} MB RAM · {p.diskMb} MB disco
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => setEditingId(editingId === p.id ? null : p.id)}>
                    {editingId === p.id ? 'Fechar' : 'Editar / Aplicar'}
                  </Button>
                </div>
                {editingId === p.id && <PlanEditor planId={p.id} onClose={() => setEditingId(null)} />}
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
