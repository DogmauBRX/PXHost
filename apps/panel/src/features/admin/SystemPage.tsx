import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getReadyz,
  listNodes,
  listPartitions,
  listSigningKeys,
  maintainPartitions,
  retireSigningKey,
  runDiagnostics,
  listCanaryRuns,
  runCanary,
  rotateSigningKey,
} from './admin.api';
import { ApiError } from '@/shared/api/client';
import type { CanaryRun, CanaryScenarioResult, DiagnosticStatus } from '@/shared/api/types';
import { Alert, Badge, Button, Card, CardBody, CardHeader, CardTitle, ConfirmDialog, PageHeader, TBody, TD, TR, Table, TableWrap } from '@/ui/primitives';

const KEY_STATE_TONE: Record<string, 'ok' | 'warn' | 'neutral'> = { current: 'ok', retiring: 'warn' };

function InfraHealthCard() {
  const readyz = useQuery({ queryKey: ['admin', 'readyz'], queryFn: getReadyz, refetchInterval: 30_000 });
  const nodes = useQuery({ queryKey: ['admin', 'nodes'], queryFn: listNodes });
  const onlineNodes = nodes.data?.filter((n) => n.healthStatus === 'online').length ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Saúde da infraestrutura</CardTitle>
      </CardHeader>
      <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg bg-surface-2 p-3">
          <p className="text-xs text-text-muted">Postgres</p>
          <Badge tone={readyz.data?.dependencies.database.ok ? 'ok' : 'fail'}>
            {readyz.isPending ? '…' : readyz.data?.dependencies.database.ok ? 'saudável' : 'com falha'}
          </Badge>
        </div>
        <div className="rounded-lg bg-surface-2 p-3">
          <p className="text-xs text-text-muted">Redis</p>
          <Badge tone={readyz.data?.dependencies.redis.ok ? 'ok' : 'fail'}>
            {readyz.isPending ? '…' : readyz.data?.dependencies.redis.ok ? 'saudável' : 'com falha'}
          </Badge>
        </div>
        <div className="rounded-lg bg-surface-2 p-3">
          <p className="text-xs text-text-muted">Nodes online</p>
          <p className="text-sm font-medium text-text">
            {onlineNodes} / {nodes.data?.length ?? '…'}
          </p>
        </div>
      </CardBody>
    </Card>
  );
}

function SigningKeysCard() {
  const queryClient = useQueryClient();
  const { data: keys, isPending, isError } = useQuery({ queryKey: ['admin', 'signing-keys'], queryFn: listSigningKeys });
  const [error, setError] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [retireTarget, setRetireTarget] = useState<string | null>(null);

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'signing-keys'] });
  }

  async function handleRotate() {
    setRotating(true);
    setError(null);
    try {
      await rotateSigningKey();
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível rotacionar a chave.');
    } finally {
      setRotating(false);
    }
  }

  async function handleConfirmRetire() {
    if (!retireTarget) return;
    setError(null);
    try {
      await retireSigningKey(retireTarget);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível aposentar a chave.');
    } finally {
      setRetireTarget(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Chaves de assinatura (JWKS)</CardTitle>
        </div>
        <Button variant="secondary" size="sm" disabled={rotating} onClick={() => void handleRotate()}>
          {rotating ? 'Rotacionando…' : 'Rotacionar chave'}
        </Button>
      </CardHeader>
      <CardBody className="space-y-3">
        {error && <Alert>{error}</Alert>}
        {isError && <Alert>Não foi possível carregar as chaves.</Alert>}
        {isPending ? (
          <p className="text-sm text-text-muted">Carregando…</p>
        ) : !keys || keys.length === 0 ? (
          <p className="text-sm text-text-muted">Nenhuma chave ativa.</p>
        ) : (
          <div className="space-y-2">
            {keys.map((k) => (
              <div key={k.kid} className="flex items-center justify-between gap-3 rounded-lg bg-surface-2 p-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-text">{k.kid}</p>
                  <Badge tone={KEY_STATE_TONE[k.state] ?? 'neutral'}>{k.state}</Badge>
                </div>
                {k.state === 'retiring' && (
                  <Button variant="ghost" size="sm" onClick={() => setRetireTarget(k.kid)}>
                    Aposentar
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardBody>

      <ConfirmDialog
        open={retireTarget !== null}
        title="Aposentar chave"
        message="Um token ainda assinado com essa chave para de verificar imediatamente. Só faça isso se tiver certeza de que nada em uso ainda depende dela."
        confirmLabel="Aposentar"
        tone="danger"
        onConfirm={() => void handleConfirmRetire()}
        onCancel={() => setRetireTarget(null)}
      />
    </Card>
  );
}

function PartitionsCard() {
  const queryClient = useQueryClient();
  const { data: partitions, isPending, isError } = useQuery({ queryKey: ['admin', 'partitions'], queryFn: listPartitions });
  const [error, setError] = useState<string | null>(null);
  const [maintaining, setMaintaining] = useState(false);

  async function handleMaintain() {
    setMaintaining(true);
    setError(null);
    try {
      await maintainPartitions();
      void queryClient.invalidateQueries({ queryKey: ['admin', 'partitions'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível rodar a manutenção.');
    } finally {
      setMaintaining(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Partições de log</CardTitle>
        <Button variant="secondary" size="sm" disabled={maintaining} onClick={() => void handleMaintain()}>
          {maintaining ? 'Rodando…' : 'Rodar manutenção'}
        </Button>
      </CardHeader>
      <CardBody>
        {error && <Alert className="mb-3">{error}</Alert>}
        {isError && <Alert className="mb-3">Não foi possível carregar as partições.</Alert>}
        {isPending ? (
          <p className="text-sm text-text-muted">Carregando…</p>
        ) : !partitions || partitions.length === 0 ? (
          <p className="text-sm text-text-muted">Nenhuma partição encontrada.</p>
        ) : (
          <TableWrap>
            <Table>
              <TBody>
                {partitions.map((p) => (
                  <TR key={p.table}>
                    <TD className="font-mono text-xs">{p.table}</TD>
                    <TD className="font-mono text-xs text-text-faint">{p.range ?? '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        )}
      </CardBody>
    </Card>
  );
}

const DIAG_LABEL: Record<DiagnosticStatus, string> = { ok: 'ok', warn: 'atenção', fail: 'falha' };

function DiagnosticRow({ label, status, detail }: { label: string; status: DiagnosticStatus; detail: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-2 last:border-b-0 sm:flex-row sm:items-start sm:gap-3">
      <div className="flex shrink-0 items-center gap-2 sm:w-72">
        <Badge tone={status}>{DIAG_LABEL[status]}</Badge>
        <span className="text-sm text-text">{label}</span>
      </div>
      <p className="min-w-0 break-words text-sm text-text-muted">{detail}</p>
    </div>
  );
}

function DiagnosticsCard() {
  const diagnostics = useMutation({ mutationFn: runDiagnostics });
  const result = diagnostics.data;

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>Diagnóstico da plataforma</CardTitle>
          <p className="mt-1 text-sm text-text-muted">
            Testa cada node por dentro (Docker, IPs das allocations, DNS e internet num container igual ao de um servidor) e se cada plano à venda tem um node que aceite novas compras.
          </p>
        </div>
        <Button onClick={() => diagnostics.mutate()} disabled={diagnostics.isPending}>
          {diagnostics.isPending ? 'Testando… (até 40s)' : 'Rodar diagnóstico'}
        </Button>
      </CardHeader>
      <CardBody className="space-y-5">
        {diagnostics.error && (
          <Alert tone="fail">{diagnostics.error instanceof ApiError ? diagnostics.error.message : 'Não foi possível rodar o diagnóstico.'}</Alert>
        )}
        {!result && !diagnostics.isPending && !diagnostics.error && (
          <p className="text-sm text-text-muted">Nenhum diagnóstico rodado nesta sessão.</p>
        )}
        {result && (
          <>
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <Badge tone={result.status}>{DIAG_LABEL[result.status]}</Badge>
              <span>Rodado em {new Date(result.ranAt).toLocaleString('pt-BR')}</span>
            </div>
            <section>
              <h3 className="mb-1 text-sm font-semibold text-text">Planos à venda</h3>
              {result.plans.length === 0 ? (
                <p className="text-sm text-text-muted">Nenhum plano público.</p>
              ) : (
                result.plans.map((plan) => <DiagnosticRow key={plan.planId} label={`${plan.name} (${plan.slug})`} status={plan.status} detail={plan.detail} />)
              )}
            </section>
            {result.nodes.map((node) => (
              <section key={node.nodeId}>
                <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-text">
                  {node.name}
                  <Badge tone={node.status}>{DIAG_LABEL[node.status]}</Badge>
                  {node.maintenanceMode && <Badge tone="neutral">manutenção</Badge>}
                </h3>
                {node.checks.map((check) => <DiagnosticRow key={check.key} label={check.label} status={check.status} detail={check.detail} />)}
              </section>
            ))}
          </>
        )}
      </CardBody>
    </Card>
  );
}

const RUN_TONE: Record<CanaryRun['status'], 'ok' | 'warn' | 'fail'> = { passed: 'ok', running: 'warn', failed: 'fail' };
const RUN_LABEL: Record<CanaryRun['status'], string> = { passed: 'ok', running: 'rodando', failed: 'falha' };
const SCENARIO_TONE: Record<CanaryScenarioResult['status'], 'ok' | 'warn' | 'fail' | 'neutral'> = {
  passed: 'ok',
  failed: 'fail',
  running: 'warn',
  pending: 'neutral',
  skipped: 'neutral',
};
const SCENARIO_LABEL: Record<CanaryScenarioResult['status'], string> = {
  passed: 'ok',
  failed: 'falha',
  running: 'rodando',
  pending: 'na fila',
  skipped: 'pulado',
};

function formatDuration(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}min ${s % 60}s`;
}

function CanaryScenario({ scenario }: { scenario: CanaryScenarioResult }) {
  const [open, setOpen] = useState(scenario.status === 'failed');
  return (
    <div className="border-b border-border py-2 last:border-b-0">
      <button type="button" className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => setOpen((v) => !v)}>
        <Badge tone={SCENARIO_TONE[scenario.status]}>{SCENARIO_LABEL[scenario.status]}</Badge>
        <span className="text-sm font-medium text-text">{scenario.softwareKind}</span>
        <span className="text-xs text-text-muted">
          {scenario.nodeName}
          {scenario.minecraftVersion ? ` · ${scenario.minecraftVersion}` : ''}
        </span>
        {scenario.detail && <span className="text-xs text-text-muted">— {scenario.detail}</span>}
      </button>
      {open && scenario.steps.length > 0 && (
        <div className="mt-2 space-y-1 pl-2">
          {scenario.steps.map((step, i) => (
            <div key={i} className="flex flex-col gap-0.5 text-sm sm:flex-row sm:gap-3">
              <span className={`shrink-0 sm:w-64 ${step.status === 'failed' ? 'text-fail' : 'text-text'}`}>
                {step.status === 'failed' ? '✗' : '✓'} {step.name} <span className="text-xs text-text-faint">({formatDuration(step.durationMs)})</span>
              </span>
              {step.detail && <span className="min-w-0 break-words text-text-muted">{step.detail}</span>}
            </div>
          ))}
          {scenario.logTail && scenario.logTail.length > 0 && (
            <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-surface-2 p-2 text-xs text-text-muted">{scenario.logTail.join('\n')}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function CanaryCard() {
  const queryClient = useQueryClient();
  const runs = useQuery({
    queryKey: ['admin', 'canary-runs'],
    queryFn: listCanaryRuns,
    refetchInterval: (query) => (query.state.data?.some((r) => r.status === 'running') ? 10_000 : false),
  });
  const trigger = useMutation({
    mutationFn: runCanary,
    onSuccess: () => setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['admin', 'canary-runs'] }), 3000),
  });
  const latest = runs.data?.[0];
  const isRunning = runs.data?.some((r) => r.status === 'running') ?? false;

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>Canário (teste noturno)</CardTitle>
          <p className="mt-1 text-sm text-text-muted">
            Toda noite às 04:00 cria um servidor de cada software, instala plugin/modpack, liga, reinicia, desliga, reinstala a versão atual e apaga tudo. Falhas são enviadas por e-mail aos administradores.
          </p>
        </div>
        <Button onClick={() => trigger.mutate()} disabled={trigger.isPending || isRunning}>
          {isRunning ? 'Rodando…' : trigger.isPending ? 'Enfileirando…' : 'Rodar agora'}
        </Button>
      </CardHeader>
      <CardBody className="space-y-4">
        {trigger.error && <Alert tone="fail">{trigger.error instanceof ApiError ? trigger.error.message : 'Não foi possível iniciar o canário.'}</Alert>}
        {trigger.isSuccess && !isRunning && <Alert tone="ok">Canário enfileirado — leva de 15 a 40 minutos.</Alert>}
        {runs.isPending ? (
          <p className="text-sm text-text-muted">Carregando…</p>
        ) : !latest ? (
          <p className="text-sm text-text-muted">Nenhuma execução ainda.</p>
        ) : (
          <>
            <section>
              <div className="mb-1 flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={RUN_TONE[latest.status]}>{RUN_LABEL[latest.status]}</Badge>
                <span className="text-text">Última execução: {new Date(latest.startedAt).toLocaleString('pt-BR')}</span>
                <span className="text-text-muted">{latest.trigger === 'manual' ? '(manual)' : '(agendada)'}</span>
              </div>
              {latest.summary && <p className="mb-2 text-sm text-text-muted">{latest.summary}</p>}
              {latest.results.map((scenario) => (
                <CanaryScenario key={`${latest.id}-${scenario.softwareKind}`} scenario={scenario} />
              ))}
            </section>
            {runs.data!.length > 1 && (
              <section>
                <h3 className="mb-1 text-sm font-semibold text-text">Histórico</h3>
                {runs.data!.slice(1).map((run) => (
                  <div key={run.id} className="flex flex-wrap items-center gap-2 border-b border-border py-1.5 text-sm last:border-b-0">
                    <Badge tone={RUN_TONE[run.status]}>{RUN_LABEL[run.status]}</Badge>
                    <span className="text-text">{new Date(run.startedAt).toLocaleString('pt-BR')}</span>
                    {run.finishedAt && <span className="text-xs text-text-faint">{formatDuration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime())}</span>}
                    <span className="min-w-0 break-words text-text-muted">{run.summary}</span>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

export function SystemPage() {
  return (
    <>
      <PageHeader title="Sistema" subtitle="Saúde da infraestrutura, chaves de assinatura e manutenção de partições de log." />
      <div className="space-y-6">
        <InfraHealthCard />
        <DiagnosticsCard />
        <CanaryCard />
        <SigningKeysCard />
        <PartitionsCard />
      </div>
    </>
  );
}
