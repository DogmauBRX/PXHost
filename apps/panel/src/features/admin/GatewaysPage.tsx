import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Router } from 'lucide-react';
import { createGateway, deleteGateway, listGateways, reconcileGateways } from './admin.api';
import { ApiError } from '@/shared/api/client';
import { formatDateTime as formatDate } from '@/shared/format/datetime';
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
  TBody,
  TD,
  TR,
  Table,
  TableWrap,
} from '@/ui/primitives';

/**
 * Public-exposure plan — admin CRUD for `Gateway` rows only. There is
 * deliberately no per-route management UI here: a `PublicRoute`'s state
 * lives on the server itself (visible on the admin server detail page)
 * and is entirely driven by GatewayReconcileProcessor, never edited by
 * hand. With zero gateways registered (this page's empty state), the
 * feature is off everywhere — every server keeps showing its plain
 * internal ip:port, exactly as before this feature existed.
 */
export function GatewaysPage() {
  const queryClient = useQueryClient();
  const { data: gateways, isLoading, isError } = useQuery({ queryKey: ['admin', 'gateways'], queryFn: listGateways });

  const [name, setName] = useState('');
  const [publicHost, setPublicHost] = useState('');
  const [tunnelIp, setTunnelIp] = useState('');
  const [controlUrl, setControlUrl] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const canCreate = name.trim() && publicHost.trim() && tunnelIp.trim() && controlUrl.trim();

  async function handleCreate() {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      await createGateway({ name: name.trim(), publicHost: publicHost.trim(), tunnelIp: tunnelIp.trim(), controlUrl: controlUrl.trim() });
      setName('');
      setPublicHost('');
      setTunnelIp('');
      setControlUrl('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'gateways'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível criar o gateway.');
    } finally {
      setCreating(false);
    }
  }

  async function handleReconcile() {
    setReconciling(true);
    setError(null);
    try {
      await reconcileGateways();
      void queryClient.invalidateQueries({ queryKey: ['admin', 'gateways'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível reconciliar.');
    } finally {
      setReconciling(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteGateway(deleteTarget.id);
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'gateways'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível excluir o gateway.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Gateways públicos"
        subtitle="VPS que encaminham tráfego de jogo para nodes atrás de CGNAT/roteador residencial, via WireGuard."
        actions={
          <Button variant="secondary" disabled={reconciling} onClick={() => void handleReconcile()}>
            {reconciling ? 'Reconciliando…' : 'Reconciliar agora'}
          </Button>
        }
      />

      <Card className="mb-6">
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Nome" htmlFor="gw-name" className="w-40">
            <Input id="gw-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="VPS Principal" />
          </Field>
          <Field label="Host público" htmlFor="gw-public-host" className="w-56" hint="O que o cliente conecta — nunca o IP privado do node.">
            <Input id="gw-public-host" value={publicHost} onChange={(e) => setPublicHost(e.target.value)} placeholder="203.0.113.10" />
          </Field>
          <Field label="IP no túnel" htmlFor="gw-tunnel-ip" className="w-40">
            <Input id="gw-tunnel-ip" value={tunnelIp} onChange={(e) => setTunnelIp(e.target.value)} placeholder="10.10.0.1" />
          </Field>
          <Field label="URL de controle" htmlFor="gw-control-url" className="w-56" hint="O sidecar apps/gateway deste VPS, pela VPN.">
            <Input id="gw-control-url" value={controlUrl} onChange={(e) => setControlUrl(e.target.value)} placeholder="http://10.10.0.1:9443" />
          </Field>
          <Button variant="primary" disabled={creating || !canCreate} onClick={() => void handleCreate()}>
            {creating ? 'Criando…' : 'Criar gateway'}
          </Button>
        </CardBody>
      </Card>

      {error && <Alert className="mb-6" onDismiss={() => setError(null)}>{error}</Alert>}
      {isError && <Alert className="mb-6">Não foi possível carregar os gateways.</Alert>}

      {isLoading ? (
        <LoadingRow />
      ) : !gateways || gateways.length === 0 ? (
        <EmptyState
          icon={Router}
          title="Nenhum gateway ainda"
          description="Sem um gateway, todo servidor continua mostrando apenas seu endereço interno — crie o primeiro acima quando o VPS estiver pronto (veja docs/PUBLIC-EXPOSURE.md)."
        />
      ) : (
        <TableWrap>
          <Table>
            <TBody>
              {gateways.map((g) => (
                <TR key={g.id}>
                  <TD>
                    <p className="font-medium text-text">{g.name}</p>
                    <p className="font-mono text-xs text-text-faint">
                      {g.publicHost} · túnel {g.tunnelIp}
                    </p>
                  </TD>
                  <TD>
                    <Badge tone={g.isActive ? 'ok' : 'neutral'}>{g.isActive ? 'Ativo' : 'Inativo'}</Badge>
                    {g.lastError && <p className="mt-1 text-xs text-fail">{g.lastError}</p>}
                  </TD>
                  <TD className="text-xs text-text-faint">{g.lastAppliedAt ? `Aplicado ${formatDate(g.lastAppliedAt)}` : 'Nunca aplicado'}</TD>
                  <TD className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => setDeleteTarget({ id: g.id, name: g.name })}>
                      Excluir
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Excluir gateway"
        message={`Isso desativa "${deleteTarget?.name ?? ''}" — servidores expostos por ele param de ser reconciliados (o encaminhamento existente na VPS não é removido automaticamente).`}
        confirmLabel="Excluir"
        tone="danger"
        loading={deleting}
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}
