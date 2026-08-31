import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getReadyz,
  listNodes,
  listPartitions,
  listSigningKeys,
  maintainPartitions,
  retireSigningKey,
  rotateSigningKey,
} from './admin.api';
import { ApiError } from '@/shared/api/client';
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

export function SystemPage() {
  return (
    <>
      <PageHeader title="Sistema" subtitle="Saúde da infraestrutura, chaves de assinatura e manutenção de partições de log." />
      <div className="space-y-6">
        <InfraHealthCard />
        <SigningKeysCard />
        <PartitionsCard />
      </div>
    </>
  );
}
