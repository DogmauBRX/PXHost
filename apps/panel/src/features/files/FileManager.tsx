import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { File as FileIcon, FileArchive, FilePlus, Folder, FolderPlus, Upload } from 'lucide-react';
import { chmod, compress, decompress, deleteFile, listFiles, mintDownloadLink, mintUploadLink, mkdir, renameFile, writeFile } from './files.api';
import { formatBytes, formatDate } from './format';
import { getServer } from '@/features/servers/servers.api';
import { FileEditor } from './FileEditor';
import { ApiError } from '@/shared/api/client';
import {
  Alert,
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  LoadingRow,
  PageHeader,
  PromptDialog,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableWrap,
} from '@/ui/primitives';
import type { FileEntry } from '@/shared/api/types';

function joinPath(dir: string, name: string): string {
  return dir === '.' ? name : `${dir}/${name}`;
}

function isArchive(name: string): boolean {
  return name.toLowerCase().endsWith('.zip');
}

// Entry.Mode is a Unix-style rendering like "-rw-r--r--" — the leading
// char is file type, not a permission bit, so it's dropped before reading
// the three rwx triplets.
function modeStringToOctal(mode: string): string {
  const bits = mode.slice(1);
  if (bits.length !== 9) return '644';
  let result = '';
  for (let i = 0; i < 3; i++) {
    const triplet = bits.slice(i * 3, i * 3 + 3);
    let n = 0;
    if (triplet[0] === 'r') n += 4;
    if (triplet[1] === 'w') n += 2;
    if (triplet[2] === 'x' || triplet[2] === 's' || triplet[2] === 't') n += 1;
    result += String(n);
  }
  return result;
}

type SortKey = 'name' | 'size' | 'modTime';

type PendingPrompt =
  | { kind: 'mkdir' }
  | { kind: 'newfile' }
  | { kind: 'rename'; name: string }
  | { kind: 'compress'; names: string[] }
  | { kind: 'chmod'; name: string; currentMode: string };

export function FileManager({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const [path, setPath] = useState('.');
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<{ name: string; isDir: boolean }[] | null>(null);
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const [dragActive, setDragActive] = useState(false);

  const { data: entries, isLoading, isError } = useQuery({ queryKey: ['files', serverId, path], queryFn: () => listFiles(serverId, path) });
  const { data: server } = useQuery({ queryKey: ['server', serverId], queryFn: () => getServer(serverId) });
  const permissions = server?.permissions ?? [];
  const canWrite = permissions.includes('file.write');
  const canDelete = permissions.includes('file.delete');

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['files', serverId, path] });
  }

  function navigateTo(next: string) {
    setSelected(new Set());
    setPath(next);
  }

  async function withErrorHandling(fn: () => Promise<void>) {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'A operação falhou.');
    }
  }

  const visibleEntries = useMemo(() => {
    if (!entries) return [];
    const term = search.trim().toLowerCase();
    const filtered = term ? entries.filter((e) => e.name.toLowerCase().includes(term)) : entries;
    return [...filtered].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let cmp = 0;
      if (sort.key === 'name') cmp = a.name.localeCompare(b.name);
      else if (sort.key === 'size') cmp = a.size - b.size;
      else cmp = a.modTime.localeCompare(b.modTime);
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [entries, search, sort]);

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  }

  function toggleSelected(name: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((s) => (s.size === visibleEntries.length ? new Set() : new Set(visibleEntries.map((e) => e.name))));
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

  async function handleBulkDelete() {
    if (!deleteTargets) return;
    await withErrorHandling(async () => {
      for (const t of deleteTargets) {
        await deleteFile(serverId, joinPath(path, t.name), t.isDir);
      }
      setSelected(new Set());
      refresh();
    });
    setDeleteTargets(null);
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
    } else if (prompt?.kind === 'newfile') {
      await withErrorHandling(async () => {
        await writeFile(serverId, joinPath(path, value), '');
        refresh();
      });
    } else if (prompt?.kind === 'compress') {
      const dest = value.toLowerCase().endsWith('.zip') ? value : `${value}.zip`;
      await withErrorHandling(async () => {
        await compress(
          serverId,
          prompt.names.map((n) => joinPath(path, n)),
          joinPath(path, dest),
        );
        setSelected(new Set());
        refresh();
      });
    } else if (prompt?.kind === 'chmod') {
      if (/^[0-7]{1,4}$/.test(value)) {
        await withErrorHandling(async () => {
          await chmod(serverId, joinPath(path, prompt.name), parseInt(value, 8));
          refresh();
        });
      } else {
        setActionError('Modo inválido — use dígitos octais, por exemplo 644.');
      }
    }
    setPrompt(null);
  }

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setUploadProgress({ done: 0, total: files.length });
    await withErrorHandling(async () => {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const link = await mintUploadLink(serverId, joinPath(path, file.name), file.size);
        const res = await fetch(link.url, { method: 'POST', body: file });
        if (!res.ok) throw new ApiError(res.status, 'UPLOAD_FAILED', `O envio de "${file.name}" falhou (status ${res.status}).`);
        setUploadProgress({ done: i + 1, total: files.length });
      }
      refresh();
    });
    setUploadProgress(null);
  }

  async function handleExtract(name: string) {
    await withErrorHandling(async () => {
      const destName = name.replace(/\.zip$/i, '');
      const result = await decompress(serverId, joinPath(path, name), joinPath(path, destName));
      refresh();
      setActionNotice(
        result.skipped.length > 0
          ? `${result.extracted} arquivo(s) extraído(s) em "${destName}". ${result.skipped.length} item(ns) ignorado(s) (links simbólicos ou similares).`
          : `${result.extracted} arquivo(s) extraído(s) em "${destName}".`,
      );
    });
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    if (!canWrite) return;
    e.preventDefault();
    setDragActive(true);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    if (!canWrite) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length) void uploadFiles(files);
  }

  if (editingPath) {
    return <FileEditor serverId={serverId} path={editingPath} onClose={() => setEditingPath(null)} />;
  }

  const crumbs = path === '.' ? [] : path.split('/');
  const selectedEntries = visibleEntries.filter((e: FileEntry) => selected.has(e.name));

  return (
    <>
      <PageHeader
        title="Arquivos"
        actions={
          canWrite ? (
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={() => setPrompt({ kind: 'mkdir' })}>
                <FolderPlus className="h-4 w-4" aria-hidden="true" />
                Nova pasta
              </Button>
              <Button variant="secondary" onClick={() => setPrompt({ kind: 'newfile' })}>
                <FilePlus className="h-4 w-4" aria-hidden="true" />
                Novo arquivo
              </Button>
              <Button variant="primary" disabled={uploadProgress !== null} onClick={() => fileInputRef.current?.click()}>
                <Upload className="h-4 w-4" aria-hidden="true" />
                {uploadProgress ? `Enviando ${uploadProgress.done}/${uploadProgress.total}…` : 'Enviar arquivos'}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  if (files.length) void uploadFiles(files);
                }}
              />
            </div>
          ) : undefined
        }
      >
        <nav className="mt-3 flex items-center gap-1 font-mono text-sm text-text-muted">
          <button onClick={() => navigateTo('.')} className="rounded px-1.5 py-0.5 hover:bg-surface-2 hover:text-text">
            /
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <span>/</span>
              <button
                onClick={() => navigateTo(crumbs.slice(0, i + 1).join('/'))}
                className="rounded px-1.5 py-0.5 hover:bg-surface-2 hover:text-text"
              >
                {c}
              </button>
            </span>
          ))}
        </nav>
      </PageHeader>

      {actionNotice && (
        <Alert tone="info" className="mb-4" onDismiss={() => setActionNotice(null)}>
          {actionNotice}
        </Alert>
      )}
      {actionError && <Alert className="mb-4">{actionError}</Alert>}
      {isError && <Alert className="mb-4">Não foi possível carregar esta pasta.</Alert>}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input placeholder="Buscar nesta pasta…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
        {canWrite && selectedEntries.length > 0 && (
          <>
            <span className="text-xs text-text-muted">{selectedEntries.length} selecionado(s)</span>
            <Button variant="secondary" size="sm" onClick={() => setPrompt({ kind: 'compress', names: selectedEntries.map((e) => e.name) })}>
              <FileArchive className="h-4 w-4" aria-hidden="true" />
              Compactar
            </Button>
            {canDelete && (
              <Button variant="ghost" size="sm" onClick={() => setDeleteTargets(selectedEntries.map((e) => ({ name: e.name, isDir: e.isDir })))}>
                Excluir selecionados
              </Button>
            )}
          </>
        )}
      </div>

      <div
        onDragOver={handleDragOver}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        className={dragActive ? 'rounded-card ring-2 ring-accent ring-offset-2 ring-offset-surface' : ''}
      >
        {isLoading ? (
          <LoadingRow />
        ) : visibleEntries.length === 0 ? (
          <EmptyState icon={Folder} title={search ? 'Nenhum arquivo corresponde à busca' : 'Esta pasta está vazia'} />
        ) : (
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  {canWrite && (
                    <TH className="w-8">
                      <input
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer rounded border-border"
                        checked={selected.size > 0 && selected.size === visibleEntries.length}
                        onChange={toggleSelectAll}
                        aria-label="Selecionar tudo"
                      />
                    </TH>
                  )}
                  <TH>
                    <button onClick={() => toggleSort('name')} className="hover:text-text">
                      Nome {sort.key === 'name' ? (sort.dir === 'asc' ? '▲' : '▼') : ''}
                    </button>
                  </TH>
                  <TH className="text-right">
                    <button onClick={() => toggleSort('size')} className="hover:text-text">
                      Tamanho {sort.key === 'size' ? (sort.dir === 'asc' ? '▲' : '▼') : ''}
                    </button>
                  </TH>
                  <TH>
                    <button onClick={() => toggleSort('modTime')} className="hover:text-text">
                      Modificado {sort.key === 'modTime' ? (sort.dir === 'asc' ? '▲' : '▼') : ''}
                    </button>
                  </TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {visibleEntries.map((e) => (
                  <TR key={e.name}>
                    {canWrite && (
                      <TD>
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer rounded border-border"
                          checked={selected.has(e.name)}
                          onChange={() => toggleSelected(e.name)}
                          aria-label={`Selecionar ${e.name}`}
                        />
                      </TD>
                    )}
                    <TD>
                      {e.isDir ? (
                        <button
                          onClick={() => navigateTo(joinPath(path, e.name))}
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
                    <TD className="text-xs text-text-faint">{formatDate(e.modTime)}</TD>
                    <TD>
                      <div className="flex justify-end gap-1">
                        {!e.isDir && (
                          <Button variant="ghost" size="sm" onClick={() => void handleDownload(e.name)}>
                            Baixar
                          </Button>
                        )}
                        {!e.isDir && isArchive(e.name) && canWrite && (
                          <Button variant="ghost" size="sm" onClick={() => void handleExtract(e.name)}>
                            Extrair
                          </Button>
                        )}
                        {canWrite && (
                          <Button variant="ghost" size="sm" onClick={() => setPrompt({ kind: 'rename', name: e.name })}>
                            Renomear
                          </Button>
                        )}
                        {canWrite && (
                          <Button variant="ghost" size="sm" onClick={() => setPrompt({ kind: 'chmod', name: e.name, currentMode: e.mode })}>
                            Permissões
                          </Button>
                        )}
                        {canDelete && (
                          <Button variant="ghost" size="sm" onClick={() => setDeleteTargets([{ name: e.name, isDir: e.isDir }])}>
                            Excluir
                          </Button>
                        )}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        )}
      </div>

      <ConfirmDialog
        open={deleteTargets !== null}
        title="Excluir"
        message={
          deleteTargets
            ? deleteTargets.length === 1
              ? `Excluir ${deleteTargets[0].isDir ? 'esta pasta e todo o seu conteúdo' : 'este arquivo'}: ${deleteTargets[0].name}?`
              : `Excluir ${deleteTargets.length} itens selecionados? Pastas serão excluídas com todo o seu conteúdo.`
            : ''
        }
        confirmLabel="Excluir"
        tone="danger"
        onConfirm={() => void handleBulkDelete()}
        onCancel={() => setDeleteTargets(null)}
      />

      <PromptDialog
        open={prompt !== null}
        title={
          prompt?.kind === 'mkdir'
            ? 'Nova pasta'
            : prompt?.kind === 'newfile'
              ? 'Novo arquivo'
              : prompt?.kind === 'rename'
                ? 'Renomear'
                : prompt?.kind === 'compress'
                  ? 'Compactar'
                  : prompt?.kind === 'chmod'
                    ? 'Permissões'
                    : ''
        }
        label={
          prompt?.kind === 'mkdir'
            ? 'Nome da pasta'
            : prompt?.kind === 'newfile'
              ? 'Nome do arquivo'
              : prompt?.kind === 'rename'
                ? 'Novo nome'
                : prompt?.kind === 'compress'
                  ? 'Nome do arquivo .zip'
                  : prompt?.kind === 'chmod'
                    ? 'Modo (octal)'
                    : ''
        }
        hint={
          prompt?.kind === 'chmod'
            ? 'Três dígitos octais, ex.: 644 (arquivo) ou 755 (executável).'
            : prompt?.kind === 'compress'
              ? `Vai conter ${prompt.names.length} item(ns) selecionado(s).`
              : undefined
        }
        defaultValue={
          prompt?.kind === 'rename'
            ? prompt.name
            : prompt?.kind === 'chmod'
              ? modeStringToOctal(prompt.currentMode)
              : prompt?.kind === 'compress'
                ? prompt.names.length === 1
                  ? prompt.names[0].replace(/\.[^./]+$/, '')
                  : 'arquivos'
                : ''
        }
        confirmLabel={
          prompt?.kind === 'mkdir'
            ? 'Criar'
            : prompt?.kind === 'newfile'
              ? 'Criar'
              : prompt?.kind === 'rename'
                ? 'Renomear'
                : prompt?.kind === 'compress'
                  ? 'Compactar'
                  : prompt?.kind === 'chmod'
                    ? 'Aplicar'
                    : 'Confirmar'
        }
        onSubmit={(value) => void handlePromptSubmit(value)}
        onCancel={() => setPrompt(null)}
      />
    </>
  );
}
