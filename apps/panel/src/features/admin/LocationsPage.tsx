import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { createLocation, listLocations } from './admin.api';
import { ApiError } from '@/shared/api/client';
import {
  Alert,
  Button,
  Card,
  CardBody,
  EmptyState,
  Field,
  Input,
  LoadingRow,
  PageHeader,
  TBody,
  TD,
  TR,
  Table,
  TableWrap,
} from '@/ui/primitives';

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
    <>
      <PageHeader title="Locations" subtitle="Regiões físicas ou lógicas onde seus nodes ficam agrupados." />

      <Card className="mb-6">
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Código (short_code)" htmlFor="loc-code" className="w-40">
            <Input id="loc-code" value={shortCode} onChange={(e) => setShortCode(e.target.value)} placeholder="us-east" />
          </Field>
          <Field label="Nome" htmlFor="loc-name" className="w-56">
            <Input id="loc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="US East" />
          </Field>
          <Button variant="primary" disabled={creating || !shortCode.trim() || !name.trim()} onClick={() => void handleCreate()}>
            {creating ? 'Criando…' : 'Criar location'}
          </Button>
        </CardBody>
      </Card>

      {error && <Alert className="mb-6">{error}</Alert>}
      {isError && <Alert className="mb-6">Não foi possível carregar as locations.</Alert>}

      {isLoading ? (
        <LoadingRow />
      ) : !locations || locations.length === 0 ? (
        <EmptyState icon={MapPin} title="Nenhuma location ainda" description="Crie a primeira acima para começar a cadastrar nodes." />
      ) : (
        <TableWrap>
          <Table>
            <TBody>
              {locations.map((l) => (
                <TR key={l.id}>
                  <TD>
                    <p className="font-mono text-sm text-text">{l.shortCode}</p>
                    <p className="text-xs text-text-faint">{l.name}</p>
                  </TD>
                  <TD className="text-right text-xs text-text-faint">{formatDate(l.createdAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      )}
    </>
  );
}
