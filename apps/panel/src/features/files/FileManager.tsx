import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteFile, listFiles, mintDownloadLink, mintUploadLink, mkdir, renameFile } from './files.api';
import { FileEditor } from './FileEditor';
import { Button } from '@/ui/primitives/Button';
import { ApiError } from '@/shared/api/client';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function joinPath(dir: string, name: string): string {
  return dir === '.' ? name : `${dir}/${name}`;
}

export function FileManager({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const [path, setPath] = useState('.');
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

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

  async function handleDelete(name: string, isDir: boolean) {
    const label = isDir ? 'esta pasta e todo o seu conteúdo' : 'este arquivo';
    if (!window.confirm(`Excluir ${label}: ${name}?`)) return;
    await withErrorHandling(async () => {
      await deleteFile(serverId, joinPath(path, name), isDir);
      refresh();
    });
  }

  async function handleRename(name: string) {
    const next = window.prompt('Novo nome:', name);
    if (!next || next === name) return;
    await withErrorHandling(async () => {
      await renameFile(serverId, joinPath(path, name), joinPath(path, next));
      refresh();
    });
  }

  async function handleMkdir() {
    const name = window.prompt('Nome da nova pasta:');
    if (!name) return;
    await withErrorHandling(async () => {
      await mkdir(serverId, joinPath(path, name));
      refresh();
    });
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
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <nav className="flex items-center gap-1 font-mono text-sm text-text-muted">
          <button onClick={() => setPath('.')} className="hover:text-text">
            /
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <span>/</span>
              <button onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))} className="hover:text-text">
                {c}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => void handleMkdir()}>
            Nova pasta
          </Button>
          <Button variant="primary" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
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
      </div>

      {actionError && <p className="rounded-md bg-fail-tint px-3 py-2 text-sm text-fail">{actionError}</p>}

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-surface">
        {isLoading && <p className="p-4 text-sm text-text-muted">Carregando…</p>}
        {isError && <p className="p-4 text-sm text-fail">Não foi possível carregar esta pasta.</p>}
        {entries && entries.length === 0 && <p className="p-4 text-sm text-text-muted">Esta pasta está vazia.</p>}
        {entries && entries.length > 0 && (
          <table className="w-full text-sm">
            <tbody>
              {entries.map((e) => (
                <tr key={e.name} className="border-b border-border last:border-0 hover:bg-surface-2">
                  <td className="px-4 py-2">
                    {e.isDir ? (
                      <button onClick={() => setPath(joinPath(path, e.name))} className="font-medium text-text hover:text-accent">
                        📁 {e.name}
                      </button>
                    ) : (
                      <button onClick={() => setEditingPath(joinPath(path, e.name))} className="text-text hover:text-accent">
                        📄 {e.name}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-text-faint">{e.isDir ? '' : formatBytes(e.size)}</td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-1">
                      {!e.isDir && (
                        <Button variant="ghost" onClick={() => void handleDownload(e.name)}>
                          Baixar
                        </Button>
                      )}
                      <Button variant="ghost" onClick={() => void handleRename(e.name)}>
                        Renomear
                      </Button>
                      <Button variant="ghost" onClick={() => void handleDelete(e.name, e.isDir)}>
                        Excluir
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
