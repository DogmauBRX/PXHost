import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { getSiteAnnouncement, updateSiteAnnouncement, type UpdateSiteAnnouncementInput } from './admin.api';
import { ApiError } from '@/shared/api/client';
import type { SiteAnnouncement } from '@/shared/api/types';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, CardDescription, Field, LoadingRow, PageHeader, Textarea, Toggle } from '@/ui/primitives';

interface FormValues {
  message: string;
  isActive: boolean;
}

function toForm(a: SiteAnnouncement): FormValues {
  return { message: a.message, isActive: a.isActive };
}

/**
 * A site-wide warning banner an admin can turn on/off — shown to every
 * visitor, logged out on the public site and logged in on the panel
 * (`AnnouncementBanner.tsx`, rendered by both `PublicShell` and
 * `AppShell`). Single record (`GET/PATCH /api/admin/site-announcement`),
 * same load/edit/save shape as `SettingsPage.tsx`'s own cards — no list,
 * nothing to select, just the one row.
 */
export function SiteAnnouncementPage() {
  const queryClient = useQueryClient();
  const { data: announcement, isLoading } = useQuery({ queryKey: ['admin', 'site-announcement'], queryFn: getSiteAnnouncement });
  const [values, setValues] = useState<FormValues | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (announcement) setValues(toForm(announcement));
  }, [announcement]);

  const mutation = useMutation({
    mutationFn: (input: UpdateSiteAnnouncementInput) => updateSiteAnnouncement(input),
    onSuccess: (updated) => {
      queryClient.setQueryData(['admin', 'site-announcement'], updated);
      // Visitors' own banners refetch on their own interval
      // (AnnouncementBanner.tsx) — no cross-client push exists in this
      // app, so "takes a little while to reach everyone" is expected and
      // fine for a status message, not the kind of thing that needs to
      // be instantaneous.
      setValues(toForm(updated));
      setNotice('Aviso atualizado.');
      setError(null);
    },
    onError: (err) => {
      setNotice(null);
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar o aviso.');
    },
  });

  function patch(p: Partial<FormValues>) {
    setValues((v) => (v ? { ...v, ...p } : v));
    setNotice(null);
  }

  function handleSave() {
    if (!values) return;
    setError(null);
    mutation.mutate({ message: values.message.trim(), isActive: values.isActive });
  }

  return (
    <>
      <PageHeader title="Aviso do site" subtitle="Uma mensagem de alerta exibida para todos os visitantes, dentro e fora do painel." />

      <div className="grid max-w-2xl gap-6">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Mensagem</CardTitle>
              <CardDescription>Fica visível assim que ativada — na página inicial e em todas as telas do painel.</CardDescription>
            </div>
          </CardHeader>
          <CardBody>
            {isLoading || !values ? (
              <LoadingRow />
            ) : (
              <div className="flex flex-col gap-4">
                {notice && (
                  <Alert tone="ok" onDismiss={() => setNotice(null)}>
                    {notice}
                  </Alert>
                )}
                {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}

                <Field label="Texto do aviso" htmlFor="announcement-message" hint="Ex.: Manutenção programada no Node R620 às 22h de hoje.">
                  <Textarea
                    id="announcement-message"
                    rows={3}
                    value={values.message}
                    onChange={(e) => patch({ message: e.target.value })}
                    placeholder="Digite a mensagem que será exibida no topo do site..."
                  />
                </Field>

                <Toggle
                  id="announcement-active"
                  checked={values.isActive}
                  onChange={(checked) => patch({ isActive: checked })}
                  label="Aviso ativo"
                  description="Desligado, o texto fica salvo mas ninguém o vê."
                />

                <div>
                  <Button variant="primary" disabled={mutation.isPending || (values.isActive && !values.message.trim())} onClick={handleSave}>
                    <Save className="h-4 w-4" aria-hidden="true" />
                    {mutation.isPending ? 'Salvando…' : 'Salvar'}
                  </Button>
                </div>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
