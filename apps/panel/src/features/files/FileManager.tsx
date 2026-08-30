import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { File as FileIcon, Folder, FolderPlus, Upload } from 'lucide-react';
import { deleteFile, listFiles, mintDownloadLink, mintUploadLink, mkdir, renameFile } from './files.api';
import { FileEditor } from './FileEditor';
import { ApiError } from '@/shared/api/client';
import {
  Alert,
  Button,
  ConfirmDialog,
  EmptyState,
  LoadingRow,
  PageHeader,
  PromptDialog,
  TBody,
  TD,
  TR,
  Table,
  TableWrap,
} from '@/ui/primitives';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function joinPath(dir: string, name: string): string {
  return dir === '.' ? name : `${dir}/${name}`;
}

type PendingPrompt = { kind: 'mkdir' } | { kind: 'rename'; name: string };

export function FileManager({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const [path, setPath] = useState('.');
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ name: string; isDir: boolean } | null>(null);
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null);

  const { data: entries, isLoading, isError } = useQuery({ queryKey: ['files', serverId, path], queryFn: () => listFiles(serverId, path) });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['files', serverId, path] });
  }

  async function withErrorHandling(fn: () => Promise<void>) {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'A operação falhou.');
    }
  }

  async function handleDownload(name: string) {
    const link = await mintDownloadLink(serverId, joinPath(path, name));
    const a = document.createElement('a');
    a.href = link.url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    await withErrorHandling(async () => {
      await deleteFile(serverId, joinPath(path, deleteTarget.name), deleteTarget.isDir);
      refresh();
    });
    setDeleteTarget(null);
  }

  async function handlePromptSubmit(value: string) {
    if (prompt?.kind === 'rename') {
      if (value !== prompt.name) {
        await withErrorHandling(async () => {
          await renameFile(serverId, joinPath(path, prompt.name), joinPath(path, value));
          refresh();
        });
      }
    } else if (prompt?.kind === 'mkdir') {
      await withErrorHandling(async () => {
        await mkdir(serverId, joinPath(path, value));
        refresh();
      });
    }
    setPrompt(null);
  }

  async function handleUpload(file: File) {
    setUploading(true);
    await withErrorHandling(async () => {
      const link = await mintUploadLink(serverId, joinPath(path, file.name), file.size);
      const res = await fetch(link.url, { method: 'POST', body: file });
      if (!res.ok) throw new ApiError(res.status, 'UPLOAD_FAILED', `O agente recusou o envio (status ${res.status}).`);
      refresh();
    });
    setUploading(false);
  }

  if (editingPath) {
    return <FileEditor serverId={serverId} path={editingPath} onClose={() => setEditingPath(null)} />;
  }

  const crumbs = path === '.' ? [] : path.split('/');

  return (
    <>
      <PageHeader
        title="Arquivos"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setPrompt({ kind: 'mkdir' })}>
              <FolderPlus className="h-4 w-4" aria-hidden="true" />
              Nova pasta
            </Button>
            <Button variant="primary" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-4 w-4" aria-hidden="true" />
              {uploading ? 'Enviando…' : 'Enviar arquivo'}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void handleUpload(file);
              }}
            />
          </div>
        }
      >
        <nav className="mt-3 flex items-center gap-1 font-mono text-sm text-text-muted">
          <button onClick={() => setPath('.')} className="rounded px-1.5 py-0.5 hover:bg-surface-2 hover:text-text">
            /
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <span>/</span>
              <button
                onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}
                className="rounded px-1.5 py-0.5 hover:bg-surface-2 hover:text-text"
              >
                {c}
              </button>
            </span>
          ))}
        </nav>
      </PageHeader>

      {actionError && <Alert className="mb-6">{actionError}</Alert>}
      {isError && <Alert className="mb-6">Não foi possível carregar esta pasta.</Alert>}

      {isLoading ? (
        <LoadingRow />
      ) : !entries || entries.length === 0 ? (
        <EmptyState icon={Folder} title="Esta pasta está vazia" />
      ) : (
        <TableWrap>
          <Table>
            <TBody>
              {entries.map((e) => (
                <TR key={e.name}>
                  <TD>
                    {e.isDir ? (
                      <button
                        onClick={() => setPath(joinPath(path, e.name))}
                        className="inline-flex items-center gap-2 font-medium text-text hover:text-accent-strong"
                      >
                        <Folder className="h-4 w-4 text-text-faint" aria-hidden="true" />
                        {e.name}
                      </button>
                    ) : (
                      <button
                        onClick={() => setEditingPath(joinPath(path, e.name))}
                        className="inline-flex items-center gap-2 text-text hover:text-accent-strong"
                      >
                        <FileIcon className="h-4 w-4 text-text-faint" aria-hidden="true" />
                        {e.name}
                      </button>
                    )}
                  </TD>
                  <TD className="text-right font-mono text-xs text-text-faint">{e.isDir ? '' : formatBytes(e.size)}</TD>
                  <TD>
                    <div className="flex justify-end gap-1">
                      {!e.isDir && (
                        <Button variant="ghost" size="sm" onClick={() => void handleDownload(e.name)}>
                          Baixar
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => setPrompt({ kind: 'rename', name: e.name })}>
                        Renomear
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget({ name: e.name, isDir: e.isDir })}>
                        Excluir
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Excluir"
        message={
          deleteTarget
            ? `Excluir ${deleteTarget.isDir ? 'esta pasta e todo o seu conteúdo' : 'este arquivo'}: ${deleteTarget.name}?`
            : ''
        }
        confirmLabel="Excluir"
        tone="danger"
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />

      <PromptDialog
        open={prompt !== null}
        title={prompt?.kind === 'mkdir' ? 'Nova pasta' : 'Renomear'}
        label={prompt?.kind === 'mkdir' ? 'Nome da pasta' : 'Novo nome'}
        defaultValue={prompt?.kind === 'rename' ? prompt.name : ''}
        confirmLabel={prompt?.kind === 'mkdir' ? 'Criar' : 'Renomear'}
        onSubmit={(value) => void handlePromptSubmit(value)}
        onCancel={() => setPrompt(null)}
      />
    </>
  );
}
