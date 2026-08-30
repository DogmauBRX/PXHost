import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createAllocationRange, createNode, issueBootstrapToken, listAllocations, listLocations, listNodes, rotateNodeToken } from './admin.api';
import { Button } from '@/ui/primitives/Button';
import { ApiError } from '@/shared/api/client';
import type { BootstrapTokenResponse } from '@/shared/api/types';

const HEALTH_LABELS: Record<string, string> = { online: 'Online', offline: 'Offline', degraded: 'Degradado', unknown: 'Desconhecido' };

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
    <div className="mt-2 rounded-md bg-surface-2 p-3">
      <p className="mb-2 text-xs font-medium uppercase text-text-faint">Alocações ({allocations?.length ?? 0})</p>
      <div className="flex items-end gap-2">
        <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="203.0.113.10" className="w-36 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs text-text outline-none focus:border-accent" />
        <input value={startPort} onChange={(e) => setStartPort(e.target.value)} className="w-20 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs text-text outline-none focus:border-accent" />
        <span className="text-xs text-text-faint">até</span>
        <input value={endPort} onChange={(e) => setEndPort(e.target.value)} className="w-20 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs text-text outline-none focus:border-accent" />
        <Button variant="secondary" onClick={() => void handleCreate()}>
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

  async function handleRotateToken(nodeId: string) {
    setError(null);
    try {
      const res = await rotateNodeToken(nodeId);
      setBootstrap(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível rotacionar o token.');
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <h1 className="font-medium text-text">Nodes</h1>

      <div className="grid grid-cols-3 gap-2 rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Location</label>
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent">
            <option value="">Selecione…</option>
            {locations?.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.shortCode})
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Nome</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="node-01" className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">FQDN</label>
          <input value={fqdn} onChange={(e) => setFqdn(e.target.value)} placeholder="node01.exemplo.com" className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Esquema</label>
          <select value={scheme} onChange={(e) => setScheme(e.target.value as 'http' | 'https')} className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent">
            <option value="https">https</option>
            <option value="http">http</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Porta do daemon</label>
          <input value={daemonPort} onChange={(e) => setDaemonPort(e.target.value)} className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Memória total (MB)</label>
          <input value={memoryTotalMb} onChange={(e) => setMemoryTotalMb(e.target.value)} className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Disco total (MB)</label>
          <input value={diskTotalMb} onChange={(e) => setDiskTotalMb(e.target.value)} className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent" />
        </div>
        <div className="col-span-3">
          <Button variant="primary" disabled={creating} onClick={() => void handleCreate()}>
            {creating ? 'Criando…' : 'Criar node'}
          </Button>
        </div>
      </div>

      {error && <p className="rounded-md bg-fail-tint px-3 py-2 text-sm text-fail">{error}</p>}

      {bootstrap && (
        <div className="rounded-lg border border-accent/30 bg-accent-tint p-4">
          <p className="mb-2 text-sm text-text">Rode isto no node (expira em {new Date(bootstrap.expiresAt).toLocaleString('pt-BR')}) — não será exibido novamente:</p>
          <code className="block overflow-x-auto whitespace-pre rounded-md bg-surface px-3 py-2 font-mono text-xs text-text">
            pxagent bootstrap --panel {'<panel-url>'} --token {bootstrap.token}
          </code>
          <div className="mt-2">
            <Button variant="secondary" onClick={() => setBootstrap(null)}>
              Ok, anotei
            </Button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-3 overflow-auto">
        {isLoading && <p className="text-sm text-text-muted">Carregando…</p>}
        {isError && <p className="text-sm text-fail">Não foi possível carregar os nodes.</p>}
        {nodes && nodes.length === 0 && <p className="text-sm text-text-muted">Nenhum node ainda.</p>}
        {nodes?.map((n) => (
          <div key={n.id} className="rounded-lg border border-border bg-surface p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-text">{n.name}</p>
                <p className="font-mono text-xs text-text-faint">
                  {n.scheme}://{n.fqdn}:{n.daemonPort} · {HEALTH_LABELS[n.healthStatus] ?? n.healthStatus}
                </p>
                <p className="text-xs text-text-faint">
                  {n.memoryTotalMb} MB RAM · {n.diskTotalMb} MB disco
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="secondary" onClick={() => void handleIssueBootstrap(n.id)}>
                  Emitir bootstrap token
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    if (confirm(`Revogar o token atual de "${n.name}" agora? O node ficará offline até ser re-bootstrapped com o novo token.`)) void handleRotateToken(n.id);
                  }}
                >
                  Rotar token
                </Button>
                <Button variant="ghost" onClick={() => setExpanded(expanded === n.id ? null : n.id)}>
                  {expanded === n.id ? 'Ocultar alocações' : 'Alocações'}
                </Button>
              </div>
            </div>
            {expanded === n.id && <NodeAllocations nodeId={n.id} />}
          </div>
        ))}
      </div>
    </div>
  );
}
