import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { readFile, writeFile } from './files.api';
import { Button } from '@/ui/primitives/Button';

interface FileEditorProps {
  serverId: string;
  path: string;
  onClose: () => void;
}

export function FileEditor({ serverId, path, onClose }: FileEditorProps) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery({ queryKey: ['file', serverId, path], queryFn: () => readFile(serverId, path) });
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data) setDraft(data.content);
  }, [data]);

  const dirty = draft !== null && data !== undefined && draft !== data.content;

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  function handleClose() {
    if (dirty && !window.confirm('Você tem alterações não salvas. Fechar mesmo assim?')) return;
    onClose();
  }

  async function handleSave() {
    if (draft === null) return;
    setSaving(true);
    setError(null);
    try {
      await writeFile(serverId, path, draft);
      await queryClient.invalidateQueries({ queryKey: ['file', serverId, path] });
      await queryClient.invalidateQueries({ queryKey: ['files', serverId] });
    } catch {
      setError('Não foi possível salvar o arquivo.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={handleClose}>
            ← Voltar
          </Button>
          <span className="font-mono text-sm text-text">{path}</span>
          {dirty && <span className="font-mono text-xs text-warn">não salvo</span>}
        </div>
        <Button variant="primary" onClick={() => void handleSave()} disabled={!dirty || saving}>
          {saving ? 'Salvando…' : 'Salvar'}
        </Button>
      </div>

      {error && <p className="rounded-md bg-fail-tint px-3 py-2 text-sm text-fail">{error}</p>}

      {isLoading && <p className="text-sm text-text-muted">Carregando…</p>}
      {isError && <p className="text-sm text-fail">Não foi possível abrir este arquivo.</p>}

      {draft !== null && (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none rounded-lg border border-border bg-surface p-3 font-mono text-sm text-text outline-none focus:border-accent"
        />
      )}
    </div>
  );
}
