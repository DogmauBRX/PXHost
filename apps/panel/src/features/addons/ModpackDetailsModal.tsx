import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Download, ExternalLink, HardDrive, PackageOpen } from 'lucide-react';
import { formatBytes, formatDateOnly } from '@/shared/format/datetime';
import { Alert, Badge, Button, LoadingRow, Modal, Select } from '@/ui/primitives';
import type { SoftwareKind } from '@/shared/api/types';
import { getLatestModpackInstallation, getModpackProject, getModpackVersions, installModpack, type ModpackSource } from './modpacks.api';

interface Props {
  serverId: string;
  source: ModpackSource;
  projectId: string | null;
  serverMinecraftVersion: string | null;
  serverSoftware: SoftwareKind | null;
  canInstall: boolean;
  onClose: () => void;
}

const EMPTY_VERSIONS: never[] = [];

export function ModpackDetailsModal(props: Props) {
  const { serverId, source, projectId, serverMinecraftVersion, serverSoftware, canInstall, onClose } = props;
  const [minecraftVersion, setMinecraftVersion] = useState('');
  const [loader, setLoader] = useState('');
  const [versionId, setVersionId] = useState('');
  const queryClient = useQueryClient();

  const projectQuery = useQuery({
    queryKey: ['modpack-project', serverId, source, projectId],
    queryFn: () => getModpackProject(serverId, source, projectId as string),
    enabled: projectId !== null,
  });
  const versionsQuery = useQuery({
    queryKey: ['modpack-versions', serverId, source, projectId],
    queryFn: () => getModpackVersions(serverId, source, projectId as string),
    enabled: projectId !== null,
  });
  const installationQuery = useQuery({
    queryKey: ['modpack-installation', serverId],
    queryFn: () => getLatestModpackInstallation(serverId),
    refetchInterval: (query) => isActive(query.state.data?.status) ? 2_000 : false,
  });

  const versions = versionsQuery.data ?? EMPTY_VERSIONS;
  const minecraftOptions = useMemo(() => [...new Set(versions.flatMap((v) => v.minecraftVersions))], [versions]);
  const effectiveMinecraft = minecraftOptions.includes(minecraftVersion)
    ? minecraftVersion
    : serverMinecraftVersion && minecraftOptions.includes(serverMinecraftVersion)
      ? serverMinecraftVersion
      : minecraftOptions[0] ?? '';
  const loaderOptions = useMemo(
    () => [...new Set(versions.filter((v) => !effectiveMinecraft || v.minecraftVersions.includes(effectiveMinecraft)).flatMap((v) => v.loaders))],
    [versions, effectiveMinecraft],
  );
  const effectiveLoader = loaderOptions.includes(loader)
    ? loader
    : serverSoftware && loaderOptions.includes(serverSoftware)
      ? serverSoftware
      : loaderOptions[0] ?? '';
  const releaseOptions = useMemo(
    () => versions.filter((v) => (!effectiveMinecraft || v.minecraftVersions.includes(effectiveMinecraft)) && (!effectiveLoader || v.loaders.includes(effectiveLoader))),
    [versions, effectiveMinecraft, effectiveLoader],
  );
  const selectedRelease = releaseOptions.find((v) => v.versionId === versionId) ?? releaseOptions[0];
  const compatible = Boolean(selectedRelease)
    && (!serverMinecraftVersion || serverMinecraftVersion === effectiveMinecraft)
    && (!serverSoftware || serverSoftware === effectiveLoader);
  const activeInstallation = isActive(installationQuery.data?.status) ? installationQuery.data : null;
  const installMutation = useMutation({
    mutationFn: () => installModpack(serverId, source, projectId as string, selectedRelease!.versionId),
    onSuccess: (value) => queryClient.setQueryData(['modpack-installation', serverId], value),
  });

  const project = projectQuery.data;
  const loading = projectQuery.isLoading || versionsQuery.isLoading;

  return (
    <Modal
      open={projectId !== null}
      onClose={onClose}
      title={project?.name ?? 'Detalhes do modpack'}
      description={project ? `Modrinth${project.author ? ` · por ${project.author}` : ''}` : undefined}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Fechar</Button>
          <Button
            variant="primary"
            disabled={!canInstall || !compatible || !selectedRelease || Boolean(activeInstallation) || installMutation.isPending}
            onClick={() => installMutation.mutate()}
          >
            <PackageOpen className="h-4 w-4" /> {installMutation.isPending ? 'Iniciando…' : activeInstallation ? 'Instalando…' : 'Instalar Modpack'}
          </Button>
        </>
      }
    >
      {loading && <LoadingRow label="Carregando detalhes e versões…" />}
      {(projectQuery.isError || versionsQuery.isError) && <Alert>Não foi possível carregar os detalhes deste modpack.</Alert>}
      {project && !loading && (
        <div className="space-y-5">
          <div className="flex items-start gap-4">
            {project.icon ? (
              <img src={project.icon} alt="" className="h-20 w-20 shrink-0 rounded-xl border border-border object-cover" />
            ) : (
              <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-surface-2"><PackageOpen className="h-8 w-8 text-text-faint" /></div>
            )}
            <div className="min-w-0">
              <p className="text-sm text-text-muted">{project.description}</p>
              <div className="mt-3 flex flex-wrap gap-3 text-xs text-text-faint">
                <span className="inline-flex items-center gap-1"><Download className="h-3.5 w-3.5" />{formatCount(project.downloads)} downloads</span>
                <span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" />Atualizado em {formatDateOnly(project.updatedAt)}</span>
                <a className="inline-flex items-center gap-1 text-accent-strong hover:underline" href={project.pageUrl} target="_blank" rel="noreferrer">
                  Página original <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">{project.categories.map((category) => <Badge key={category}>{category}</Badge>)}</div>
            </div>
          </div>

          <div className="grid gap-3 rounded-card border border-border bg-surface-2/40 p-4 sm:grid-cols-3">
            <label className="text-xs font-medium text-text-muted">Minecraft
              <Select className="mt-1" value={effectiveMinecraft} onChange={(e) => { setMinecraftVersion(e.target.value); setLoader(''); setVersionId(''); }}>
                {minecraftOptions.map((value) => <option key={value} value={value}>{value}</option>)}
              </Select>
            </label>
            <label className="text-xs font-medium text-text-muted">Loader
              <Select className="mt-1" value={effectiveLoader} onChange={(e) => { setLoader(e.target.value); setVersionId(''); }}>
                {loaderOptions.map((value) => <option key={value} value={value}>{loaderLabel(value)}</option>)}
              </Select>
            </label>
            <label className="text-xs font-medium text-text-muted">Versão
              <Select className="mt-1" value={selectedRelease?.versionId ?? ''} onChange={(e) => setVersionId(e.target.value)}>
                {releaseOptions.map((value) => <option key={value.versionId} value={value.versionId}>{value.versionNumber}</option>)}
              </Select>
            </label>
          </div>

          <div className="rounded-card border border-border p-4">
            <h3 className="text-sm font-semibold">Compatibilidade detectada</h3>
            <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
              <Compatibility label={`Minecraft ${effectiveMinecraft || 'não informado'}`} ok={!serverMinecraftVersion || serverMinecraftVersion === effectiveMinecraft} current={serverMinecraftVersion ? `Servidor: ${serverMinecraftVersion}` : 'Versão atual não detectada'} />
              <Compatibility label={effectiveLoader ? loaderLabel(effectiveLoader) : 'Loader não informado'} ok={!serverSoftware || serverSoftware === effectiveLoader} current={`Servidor: ${serverSoftware ? loaderLabel(serverSoftware) : 'não detectado'}`} />
            </div>
            <p className="mt-3 text-xs text-text-faint">RAM e espaço necessários não são publicados pelo Modrinth para esta release; nenhuma estimativa foi inventada.</p>
            {selectedRelease?.files[0] && <p className="mt-1 inline-flex items-center gap-1 text-xs text-text-faint"><HardDrive className="h-3.5 w-3.5" />Pacote: {formatBytes(selectedRelease.files[0].size)}</p>}
          </div>

          {!canInstall && <Alert tone="warn">Você não possui a permissão de instalar modpacks neste servidor.</Alert>}
          {!compatible && <Alert tone="warn">Esta release não corresponde à versão do Minecraft e ao loader atuais. Troque a seleção ou altere primeiro o software do servidor.</Alert>}
          {installMutation.isError && <Alert>Não foi possível iniciar a instalação: {installMutation.error.message}</Alert>}
          {activeInstallation && (
            <Alert tone="info" title={`${activeInstallation.progress}% · ${statusLabel(activeInstallation.status)}`}>
              {activeInstallation.message ?? 'Processando instalação…'}
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-3"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${activeInstallation.progress}%` }} /></div>
            </Alert>
          )}
          {installationQuery.data?.status === 'completed' && installationQuery.data.versionId === selectedRelease?.versionId && (
            <Alert tone="ok">Modpack instalado com sucesso. O backup de segurança foi mantido.</Alert>
          )}
          {installationQuery.data?.status === 'failed' && (
            <Alert title="Instalação não concluída">{installationQuery.data.message}{installationQuery.data.errorMessage ? `: ${installationQuery.data.errorMessage}` : ''}</Alert>
          )}
          <Alert tone="info">O servidor precisa estar desligado. Antes de alterar os arquivos, o Agent cria um backup, valida o pacote e instala em uma área de staging com rollback automático.</Alert>

          {project.body && <div><h3 className="mb-2 text-sm font-semibold">Sobre</h3><p className="whitespace-pre-wrap text-sm leading-6 text-text-muted">{project.body}</p></div>}
        </div>
      )}
    </Modal>
  );
}

function Compatibility({ label, current, ok }: { label: string; current: string; ok: boolean }) {
  return <div><p className={ok ? 'text-ok' : 'text-warn'}>{label} {ok ? '✓' : '!'}</p><p className="text-xs text-text-faint">{current}</p></div>;
}

function loaderLabel(value: string): string {
  return value === 'neoforge' ? 'NeoForge' : value.charAt(0).toUpperCase() + value.slice(1);
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function isActive(status?: string): boolean {
  return Boolean(status && ['pending', 'downloading', 'installing', 'configuring', 'rolling_back'].includes(status));
}

function statusLabel(status: string): string {
  return ({ pending: 'Na fila', downloading: 'Baixando', installing: 'Instalando', configuring: 'Configurando', rolling_back: 'Restaurando backup' } as Record<string, string>)[status] ?? status;
}
