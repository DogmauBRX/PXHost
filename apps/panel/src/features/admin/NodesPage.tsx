import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive, ListCollapse } from 'lucide-react';
import { createAllocationRange, createNode, issueBootstrapToken, listAllocations, listLocations, listNodes, rotateNodeToken } from './admin.api';
import { ApiError } from '@/shared/api/client';
import type { BootstrapTokenResponse } from '@/shared/api/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  LoadingRow,
  PageHeader,
  Select,
} from '@/ui/primitives';

const HEALTH_LABELS: Record<string, string> = { online: 'Online', offline: 'Offline', degraded: 'Degradado', unknown: 'Desconhecido' };
const HEALTH_TONE: Record<string, 'ok' | 'warn' | 'fail' | 'neutral'> = { online: 'ok', degraded: 'warn', offline: 'fail', unknown: 'neutral' };

function NodeAllocations({ nodeId }: { nodeId: string }) {
  const queryClient = useQueryClient();
  const { data: allocations } = useQuery({ queryKey: ['admin', 'allocations', nodeId], queryFn: () => listAllocations(nodeId) });
  const [ip, setIp] = useState('');
  const [startPort, setStartPort] = useState('26000');
  const [endPort, setEndPort] = useState('26010');
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    if (!ip.trim()) return;
    setError(null);
    try {
      await createAllocationRange(nodeId, { ip: ip.trim(), startPort: Number(startPort), endPort: Number(endPort) });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'allocations', nodeId] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível criar as alocações.');
    }
  }

  return (
    <div className="mt-4 rounded-lg bg-surface-2 p-3">
      <p className="mb-2 text-xs font-semibold tracking-wide text-text-faint uppercase">Alocações ({allocations?.length ?? 0})</p>
      <div className="flex flex-wrap items-end gap-2">
        <Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="203.0.113.10" className="w-36 font-mono text-xs" />
        <Input value={startPort} onChange={(e) => setStartPort(e.target.value)} className="w-20 font-mono text-xs" />
        <span className="pb-2.5 text-xs text-text-faint">até</span>
        <Input value={endPort} onChange={(e) => setEndPort(e.target.value)} className="w-20 font-mono text-xs" />
        <Button variant="secondary" size="sm" onClick={() => void handleCreate()}>
          + Adicionar faixa
        </Button>
      </div>
      {error && <p className="mt-1 text-xs text-fail">{error}</p>}
    </div>
  );
}

export function NodesPage() {
  const queryClient = useQueryClient();
  const { data: nodes, isLoading, isError } = useQuery({ queryKey: ['admin', 'nodes'], queryFn: listNodes });
  const { data: locations } = useQuery({ queryKey: ['admin', 'locations'], queryFn: listLocations });

  const [locationId, setLocationId] = useState('');
  const [name, setName] = useState('');
  const [fqdn, setFqdn] = useState('');
  const [scheme, setScheme] = useState<'http' | 'https'>('https');
  const [daemonPort, setDaemonPort] = useState('8443');
  const [memoryTotalMb, setMemoryTotalMb] = useState('8192');
  const [diskTotalMb, setDiskTotalMb] = useState('102400');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapTokenResponse | null>(null);
  const [rotateTarget, setRotateTarget] = useState<{ id: string; name: string } | null>(null);

  async function handleCreate() {
    if (!locationId || !name.trim() || !fqdn.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createNode({ locationId, name: name.trim(), fqdn: fqdn.trim(), scheme, daemonPort: Number(daemonPort), memoryTotalMb: Number(memoryTotalMb), diskTotalMb: Number(diskTotalMb) });
      setName('');
      setFqdn('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'nodes'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível criar o node.');
    } finally {
      setCreating(false);
    }
  }

  async function handleIssueBootstrap(nodeId: string) {
    setError(null);
    try {
      const res = await issueBootstrapToken(nodeId);
      setBootstrap(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível emitir o token de bootstrap.');
    }
  }

  async function handleConfirmRotate() {
    if (!rotateTarget) return;
    setError(null);
    try {
      const res = await rotateNodeToken(rotateTarget.id);
      setBootstrap(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível rotacionar o token.');
    } finally {
      setRotateTarget(null);
    }
  }

  return (
    <>
      <PageHeader title="Nodes" subtitle="Máquinas físicas ou virtuais que rodam o agente e hospedam servidores." />

      <Card className="mb-6">
        <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Location" htmlFor="node-location">
            <Select id="node-location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Selecione…</option>
              {locations?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.shortCode})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Nome" htmlFor="node-name">
            <Input id="node-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="node-01" />
          </Field>
          <Field label="FQDN" htmlFor="node-fqdn">
            <Input id="node-fqdn" value={fqdn} onChange={(e) => setFqdn(e.target.value)} placeholder="node01.exemplo.com" />
          </Field>
          <Field label="Esquema" htmlFor="node-scheme">
            <Select id="node-scheme" value={scheme} onChange={(e) => setScheme(e.target.value as 'http' | 'https')}>
              <option value="https">https</option>
              <option value="http">http</option>
            </Select>
          </Field>
          <Field label="Porta do daemon" htmlFor="node-port">
            <Input id="node-port" value={daemonPort} onChange={(e) => setDaemonPort(e.target.value)} />
          </Field>
          <Field label="Memória total (MB)" htmlFor="node-mem">
            <Input id="node-mem" value={memoryTotalMb} onChange={(e) => setMemoryTotalMb(e.target.value)} />
          </Field>
          <Field label="Disco total (MB)" htmlFor="node-disk" className="sm:col-span-2">
            <Input id="node-disk" value={diskTotalMb} onChange={(e) => setDiskTotalMb(e.target.value)} />
          </Field>
          <div className="flex items-end sm:col-span-1">
            <Button variant="primary" disabled={creating || !locationId || !name.trim() || !fqdn.trim()} onClick={() => void handleCreate()} className="w-full">
              {creating ? 'Criando…' : 'Criar node'}
            </Button>
          </div>
        </CardBody>
      </Card>

      {error && <Alert className="mb-6">{error}</Alert>}
      {isError && <Alert className="mb-6">Não foi possível carregar os nodes.</Alert>}

      {bootstrap && (
        <Alert tone="ok" title="Anote agora — não será exibido novamente" className="mb-6">
          <p className="mt-1 mb-2">Rode isto no node (expira em {new Date(bootstrap.expiresAt).toLocaleString('pt-BR')}):</p>
          <code className="block overflow-x-auto rounded-lg bg-surface px-3 py-2 font-mono text-xs whitespace-pre text-text">
            pxagent bootstrap --panel {'<panel-url>'} --token {bootstrap.token}
          </code>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => setBootstrap(null)}>
            Ok, anotei
          </Button>
        </Alert>
      )}

      {isLoading ? (
        <LoadingRow />
      ) : !nodes || nodes.length === 0 ? (
        <EmptyState icon={HardDrive} title="Nenhum node ainda" description="Cadastre o primeiro acima." />
      ) : (
        <div className="space-y-3">
          {nodes.map((n) => (
            <Card key={n.id}>
              <CardBody>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-text">{n.name}</p>
                      <Badge tone={HEALTH_TONE[n.healthStatus] ?? 'neutral'}>{HEALTH_LABELS[n.healthStatus] ?? n.healthStatus}</Badge>
                    </div>
                    <p className="mt-0.5 font-mono text-xs text-text-faint">
                      {n.scheme}://{n.fqdn}:{n.daemonPort}
                    </p>
                    <p className="text-xs text-text-faint">
                      {n.memoryTotalMb} MB RAM · {n.diskTotalMb} MB disco
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={() => void handleIssueBootstrap(n.id)}>
                      Emitir bootstrap token
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => setRotateTarget({ id: n.id, name: n.name })}>
                      Rotar token
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setExpanded(expanded === n.id ? null : n.id)}>
                      <ListCollapse className="h-4 w-4" aria-hidden="true" />
                      {expanded === n.id ? 'Ocultar alocações' : 'Alocações'}
                    </Button>
                  </div>
                </div>
                {expanded === n.id && <NodeAllocations nodeId={n.id} />}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={rotateTarget !== null}
        title="Rotar token do node"
        message={`Revogar o token atual de "${rotateTarget?.name}" agora? O node ficará offline até ser re-bootstrapped com o novo token.`}
        confirmLabel="Rotar token"
        tone="danger"
        onConfirm={() => void handleConfirmRotate()}
        onCancel={() => setRotateTarget(null)}
      />
    </>
  );
}
