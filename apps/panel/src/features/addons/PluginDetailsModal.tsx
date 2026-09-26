import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Download, ExternalLink, HardDrive, PackageOpen } from 'lucide-react';
import { formatBytes, formatDateOnly } from '@/shared/format/datetime';
import { Alert, Badge, Button, LoadingRow, Modal, Select } from '@/ui/primitives';
import { getPluginProject, getPluginVersions, installPlugin, type PluginSource } from './plugins.api';

interface Props {
  serverId: string;
  projectId: string | null;
  softwareLabel: string;
  minecraftVersion: string | null;
  canInstall: boolean;
  source: PluginSource;
  onClose: () => void;
}

export function PluginDetailsModal({ serverId, projectId, softwareLabel, minecraftVersion, canInstall, source, onClose }: Props) {
  const [versionId, setVersionId] = useState('');
  const [success, setSuccess] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const projectQuery = useQuery({
    queryKey: ['plugin-project', source, serverId, projectId],
    queryFn: () => getPluginProject(serverId, projectId as string, source),
    enabled: projectId !== null,
  });
  const versionsQuery = useQuery({
    queryKey: ['plugin-versions', source, serverId, projectId],
    queryFn: () => getPluginVersions(serverId, projectId as string, source),
    enabled: projectId !== null,
  });
  const versions = versionsQuery.data ?? [];
  const selectedVersion = versions.find((version) => version.versionId === versionId) ?? versions[0];
  const selectedFile = selectedVersion?.files.find((file) => file.primary && file.filename.endsWith('.jar'))
    ?? selectedVersion?.files.find((file) => file.filename.endsWith('.jar'));
  const install = useMutation({
    mutationFn: () => installPlugin(serverId, projectId as string, selectedVersion!.versionId, source),
    onSuccess: (result) => {
      setSuccess(result.message);
      void queryClient.invalidateQueries({ queryKey: ['files', serverId, 'plugins'] });
    },
  });
  const project = projectQuery.data;
  const loading = projectQuery.isLoading || versionsQuery.isLoading;

  return (
    <Modal
      open={projectId !== null}
      onClose={onClose}
      title={project?.name ?? 'Detalhes do plugin'}
      description={project ? `${source === 'curseforge' ? 'CurseForge' : 'Modrinth'}${project.author ? ` · por ${project.author}` : ''}` : undefined}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Fechar</Button>
          <Button variant="primary" disabled={!canInstall || !selectedVersion || install.isPending} onClick={() => install.mutate()}>
            <PackageOpen className="h-4 w-4" /> {install.isPending ? 'Instalando…' : `Instalar ${source === 'curseforge' ? 'mod' : 'plugin'}`}
          </Button>
        </>
      }
    >
      {loading && <LoadingRow label="Carregando detalhes e versões compatíveis…" />}
      {(projectQuery.isError || versionsQuery.isError) && <Alert>Não foi possível carregar os detalhes deste {source === 'curseforge' ? 'mod' : 'plugin'}.</Alert>}
      {project && !loading && (
        <div className="space-y-5">
          <div className="flex items-start gap-4">
            {project.icon ? (
              <img src={project.icon} alt="" className="h-20 w-20 shrink-0 rounded-xl border border-border object-cover" />
            ) : (
              <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-surface-2"><PackageOpen className="h-8 w-8 text-text-faint" /></div>
            )}
            <div className="min-w-0">
              <p className="text-sm leading-6 text-text-muted">{project.description}</p>
              <div className="mt-3 flex flex-wrap gap-3 text-xs text-text-faint">
                <span className="inline-flex items-center gap-1"><Download className="h-3.5 w-3.5" />{formatCount(project.downloads)} downloads</span>
                <span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" />Atualizado em {formatDateOnly(project.updatedAt)}</span>
                <a className="inline-flex items-center gap-1 text-accent-strong hover:underline" href={project.pageUrl} target="_blank" rel="noreferrer">Página original <ExternalLink className="h-3.5 w-3.5" /></a>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">{project.categories.map((category) => <Badge key={category}>{categoryLabel(category)}</Badge>)}</div>
            </div>
          </div>

          <div className="grid gap-4 rounded-card border border-border bg-surface-2/40 p-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <label className="text-xs font-medium text-text-muted">Versão compatível
              <Select className="mt-1" value={selectedVersion?.versionId ?? ''} onChange={(event) => { setVersionId(event.target.value); setSuccess(null); }}>
                {versions.map((version) => <option key={version.versionId} value={version.versionId}>{version.versionNumber} · {releaseLabel(version.releaseType)}</option>)}
              </Select>
            </label>
            <div className="text-xs text-text-muted">
              <p className="font-medium">Ambiente detectado</p>
              <p className="mt-2 text-ok">{softwareLabel} · Minecraft {minecraftVersion ?? 'não detectado'} ✓</p>
            </div>
          </div>

          {selectedVersion && (
            <div className="rounded-card border border-border p-4">
              <h3 className="text-sm font-semibold">Release selecionada</h3>
              <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                <p>Versão: <span className="text-text-muted">{selectedVersion.versionNumber}</span></p>
                <p>Publicada: <span className="text-text-muted">{formatDateOnly(selectedVersion.publishedAt)}</span></p>
                <p>Downloads: <span className="text-text-muted">{formatCount(selectedVersion.downloads)}</span></p>
                {selectedFile && <p className="inline-flex items-center gap-1"><HardDrive className="h-3.5 w-3.5" /><span className="text-text-muted">{selectedFile.filename} · {formatBytes(selectedFile.size)}</span></p>}
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">{selectedVersion.loaders.map((loader) => <Badge key={loader}>{loaderLabel(loader)}</Badge>)}</div>
            </div>
          )}

          {versions.length === 0 && <Alert tone="warn">Não há release compatível com este software e esta versão do Minecraft.</Alert>}
          {!canInstall && <Alert tone="warn">Você não possui permissão para instalar {source === 'curseforge' ? 'mods' : 'plugins'} neste servidor.</Alert>}
          {install.isError && <Alert>Não foi possível instalar o {source === 'curseforge' ? 'mod' : 'plugin'}: {install.error.message}</Alert>}
          {success && <Alert tone="ok">{success}</Alert>}
          <Alert tone="info">O JAR será validado e salvo em <code>{source === 'curseforge' ? '/mods' : '/plugins'}</code>. Reinicie o servidor depois da instalação para carregá-lo.</Alert>

          {project.body && <div><h3 className="mb-2 text-sm font-semibold">Sobre</h3><p className="whitespace-pre-wrap text-sm leading-6 text-text-muted">{project.body}</p></div>}
        </div>
      )}
    </Modal>
  );
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function loaderLabel(value: string): string {
  return value === 'bungeecord' ? 'BungeeCord' : value.charAt(0).toUpperCase() + value.slice(1);
}

function categoryLabel(value: string): string {
  return value.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function releaseLabel(value: 'release' | 'beta' | 'alpha'): string {
  return value === 'release' ? 'Estável' : value === 'beta' ? 'Beta' : 'Alpha';
}
