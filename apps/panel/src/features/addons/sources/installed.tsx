import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Folder, Package } from 'lucide-react';
import { deleteFile, listFiles, mintDownloadLink } from '@/features/files/files.api';
import { formatBytes, formatDate } from '@/features/files/format';
import { ApiError } from '@/shared/api/client';
import { Alert, Button, ConfirmDialog, EmptyState, LoadingRow, TBody, TD, TH, THead, TR, Table, TableWrap } from '@/ui/primitives';
import type { AddonSourcePanelProps } from '../addons.types';

/** Top-level listing of the software's addon directory — a shortcut, not a full browser; deep navigation stays in Arquivos. */
export function InstalledPanel({ serverId, ctx }: AddonSourcePanelProps) {
  const queryClient = useQueryClient();
  const dir = ctx.software.addonDir as string;
  const canDelete = ctx.permissions.includes('file.delete');
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ name: string; isDir: boolean } | null>(null);

  const { data: entries, isLoading, isError } = useQuery({ queryKey: ['files', serverId, dir], queryFn: () => listFiles(serverId, dir) });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['files', serverId, dir] });
  }

  async function handleDownload(name: string) {
    const link = await mintDownloadLink(serverId, `${dir}/${name}`);
    const a = document.createElement('a');
    a.href = link.url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setActionError(null);
    try {
      await deleteFile(serverId, `${dir}/${deleteTarget.name}`, deleteTarget.isDir);
      refresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'A operação falhou.');
    }
    setDeleteTarget(null);
  }

  if (isLoading) return <LoadingRow />;
  if (isError) return <Alert>Não foi possível carregar {ctx.software.addonDirDisplay}.</Alert>;

  const noun = ctx.software.addonNoun === 'mod' ? 'mod' : 'plugin';

  return (
    <>
      {actionError && <Alert className="mb-4">{actionError}</Alert>}

      {!entries || entries.length === 0 ? (
        <EmptyState
          icon={Package}
          title={`Nenhum ${noun} instalado ainda`}
          description={`Envie um arquivo na aba "Enviar arquivo" para instalar seu primeiro ${noun}.`}
        />
      ) : (
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>Nome</TH>
                <TH className="text-right">Tamanho</TH>
                <TH>Modificado</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {entries.map((e) => (
                <TR key={e.name}>
                  <TD>
                    <span className="inline-flex items-center gap-2">
                      {e.isDir ? (
                        <Folder className="h-4 w-4 text-text-faint" aria-hidden="true" />
                      ) : (
                        <Package className="h-4 w-4 text-text-faint" aria-hidden="true" />
                      )}
                      {e.name}
                    </span>
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
                      {canDelete && (
                        <Button variant="ghost" size="sm" onClick={() => setDeleteTarget({ name: e.name, isDir: e.isDir })}>
                          Remover
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

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Remover"
        message={deleteTarget ? `Remover ${deleteTarget.isDir ? 'esta pasta e todo o seu conteúdo' : 'este arquivo'}: ${deleteTarget.name}?` : ''}
        confirmLabel="Remover"
        tone="danger"
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}
