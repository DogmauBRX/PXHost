import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { readFile, writeFile } from './files.api';
import { Alert, Badge, Button, CodeEditor, LoadingRow } from '@/ui/primitives';

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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleClose}>
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            Voltar
          </Button>
          <span className="font-mono text-sm text-text">{path}</span>
          {dirty && <Badge tone="warn">não salvo</Badge>}
        </div>
        <Button variant="primary" onClick={() => void handleSave()} disabled={!dirty || saving}>
          {saving ? 'Salvando…' : 'Salvar'}
        </Button>
      </div>

      {error && <Alert>{error}</Alert>}

      {isLoading && <LoadingRow />}
      {isError && <Alert>Não foi possível abrir este arquivo.</Alert>}

      {draft !== null && (
        <CodeEditor value={draft} onChange={setDraft} language={path.split('/').pop() ?? 'texto'} />
      )}
    </div>
  );
}
