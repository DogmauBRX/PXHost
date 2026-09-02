import { useRef, useState, type DragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { mintUploadLink } from '@/features/files/files.api';
import { ApiError } from '@/shared/api/client';
import { Alert, Button } from '@/ui/primitives';
import type { AddonSourcePanelProps } from '../addons.types';

export function UploadPanel({ serverId, ctx }: AddonSourcePanelProps) {
  const queryClient = useQueryClient();
  const dir = ctx.software.addonDir as string;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  async function handleFiles(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      for (const file of files) {
        const link = await mintUploadLink(serverId, `${dir}/${file.name}`, file.size);
        const res = await fetch(link.url, { method: 'POST', body: file });
        if (!res.ok) throw new ApiError(res.status, 'UPLOAD_FAILED', `O envio de "${file.name}" falhou (status ${res.status}).`);
      }
      setNotice(`${files.length} arquivo(s) enviado(s) para ${ctx.software.addonDirDisplay}. Confira na aba "Instalados".`);
      void queryClient.invalidateQueries({ queryKey: ['files', serverId, dir] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'O envio falhou.');
    }
    setUploading(false);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) void handleFiles(files);
  }

  const noun = ctx.software.addonNoun === 'mod' ? 'mod(s)' : 'plugin(s)';

  return (
    <div className="flex flex-col gap-4">
      {notice && (
        <Alert tone="info" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        className={`flex flex-col items-center justify-center gap-3 rounded-card border border-dashed px-6 py-14 text-center transition-colors ${
          dragActive ? 'border-accent bg-accent/5' : 'border-border bg-surface'
        }`}
      >
        <Upload className="h-8 w-8 text-text-faint" aria-hidden="true" />
        <p className="text-sm text-text-muted">Arraste arquivos .jar aqui, ou</p>
        <Button variant="primary" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
          {uploading ? 'Enviando…' : `Escolher ${noun}`}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) void handleFiles(files);
          }}
        />
        <p className="text-xs text-text-faint">
          Vai para <code className="rounded bg-surface-2 px-1 py-0.5">{ctx.software.addonDirDisplay}</code> — reinicie o servidor para carregar.
        </p>
      </div>
    </div>
  );
}
