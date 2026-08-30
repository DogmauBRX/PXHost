import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createLocation, listLocations } from './admin.api';
import { Button } from '@/ui/primitives/Button';
import { ApiError } from '@/shared/api/client';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR');
}

export function LocationsPage() {
  const queryClient = useQueryClient();
  const { data: locations, isLoading, isError } = useQuery({ queryKey: ['admin', 'locations'], queryFn: listLocations });
  const [shortCode, setShortCode] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    if (!shortCode.trim() || !name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createLocation({ shortCode: shortCode.trim(), name: name.trim() });
      setShortCode('');
      setName('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'locations'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível criar a location.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <h1 className="font-medium text-text">Locations</h1>

      <div className="flex items-end gap-2 rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Código (short_code)</label>
          <input value={shortCode} onChange={(e) => setShortCode(e.target.value)} placeholder="us-east" className="w-40 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Nome</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="US East" className="w-56 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent" />
        </div>
        <Button variant="primary" disabled={creating} onClick={() => void handleCreate()}>
          {creating ? 'Criando…' : 'Criar location'}
        </Button>
      </div>

      {error && <p className="rounded-md bg-fail-tint px-3 py-2 text-sm text-fail">{error}</p>}

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-surface">
        {isLoading && <p className="p-4 text-sm text-text-muted">Carregando…</p>}
        {isError && <p className="p-4 text-sm text-fail">Não foi possível carregar as locations.</p>}
        {locations && locations.length === 0 && <p className="p-4 text-sm text-text-muted">Nenhuma location ainda.</p>}
        {locations && locations.length > 0 && (
          <table className="w-full text-sm">
            <tbody>
              {locations.map((l) => (
                <tr key={l.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                  <td className="px-4 py-2">
                    <p className="font-mono text-text">{l.shortCode}</p>
                    <p className="text-xs text-text-faint">{l.name}</p>
                  </td>
                  <td className="px-4 py-2 text-right text-xs text-text-faint">{formatDate(l.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
