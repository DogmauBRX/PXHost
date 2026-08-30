import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { applyPlan, createPlan, getPlanDrift, listPlans, updatePlan } from './admin.api';
import { Button } from '@/ui/primitives/Button';
import { ApiError } from '@/shared/api/client';
import type { PlanApplyResult, PlanDriftReport } from '@/shared/api/types';

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
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">CPU (%)</label>
          <input value={cpuLimitPercent} onChange={(e) => setCpuLimitPercent(e.target.value)} placeholder="sem alteração" className="w-28 rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-text outline-none focus:border-accent" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Memória (MB)</label>
          <input value={memoryMb} onChange={(e) => setMemoryMb(e.target.value)} placeholder="sem alteração" className="w-28 rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-text outline-none focus:border-accent" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Disco (MB)</label>
          <input value={diskMb} onChange={(e) => setDiskMb(e.target.value)} placeholder="sem alteração" className="w-28 rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-text outline-none focus:border-accent" />
        </div>
        <Button variant="primary" disabled={busy} onClick={() => void handleSave()}>
          Salvar plano
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => void handleDryRun()}>
          Ver dry run
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Fechar
        </Button>
      </div>

      {error && <p className="text-sm text-fail">{error}</p>}

      {drift && (
        <div className="rounded-md bg-surface-2 p-3">
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
            <Button variant="danger" disabled={busy} onClick={() => void handleApply()}>
              Aplicar a {drift.affectedCount} servidor(es)
            </Button>
          )}
        </div>
      )}

      {applyResult && (
        <div className="rounded-md bg-surface-2 p-3 text-sm text-text">
          <p>{applyResult.appliedCount} servidor(es) atualizado(s).</p>
          {applyResult.failures.length > 0 && (
            <p className="text-fail">{applyResult.failures.length} falha(s): {applyResult.failures.map((f) => f.error).join('; ')}</p>
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
    <div className="flex h-full flex-col gap-4">
      <h1 className="font-medium text-text">Plans</h1>

      <div className="flex items-end gap-2 rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Nome</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Básico" className="w-40 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Slug</label>
          <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="basico" className="w-32 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Memória (MB)</label>
          <input value={memoryMb} onChange={(e) => setMemoryMb(e.target.value)} className="w-28 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Disco (MB)</label>
          <input value={diskMb} onChange={(e) => setDiskMb(e.target.value)} className="w-28 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent" />
        </div>
        <Button variant="primary" disabled={creating} onClick={() => void handleCreate()}>
          {creating ? 'Criando…' : 'Criar plano'}
        </Button>
      </div>

      {error && <p className="rounded-md bg-fail-tint px-3 py-2 text-sm text-fail">{error}</p>}

      <div className="min-h-0 flex-1 space-y-3 overflow-auto">
        {isLoading && <p className="text-sm text-text-muted">Carregando…</p>}
        {isError && <p className="text-sm text-fail">Não foi possível carregar os planos.</p>}
        {plans?.map((p) => (
          <div key={p.id} className="rounded-lg border border-border bg-surface p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-text">{p.name}</p>
                <p className="font-mono text-xs text-text-faint">
                  {p.slug} · {p.cpuLimitPercent}% CPU · {p.memoryMb} MB RAM · {p.diskMb} MB disco
                </p>
              </div>
              <Button variant="secondary" onClick={() => setEditingId(editingId === p.id ? null : p.id)}>
                {editingId === p.id ? 'Fechar' : 'Editar / Aplicar'}
              </Button>
            </div>
            {editingId === p.id && <PlanEditor planId={p.id} onClose={() => setEditingId(null)} />}
          </div>
        ))}
      </div>
    </div>
  );
}
