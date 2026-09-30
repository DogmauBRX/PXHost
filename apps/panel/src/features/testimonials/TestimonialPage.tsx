import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { getMyTestimonial, getTestimonialEligibility, submitTestimonial } from './testimonials.api';
import { ApiError } from '@/shared/api/client';
import type { TestimonialStatus } from '@/shared/api/types';
import { Alert, Badge, Button, Card, CardBody, CardDescription, CardHeader, CardTitle, Field, LoadingRow, PageHeader, StarRating, Textarea } from '@/ui/primitives';

const STATUS_LABEL: Record<TestimonialStatus, { label: string; tone: 'ok' | 'warn' | 'fail' }> = {
  pending: { label: 'Em análise', tone: 'warn' },
  approved: { label: 'Aprovado', tone: 'ok' },
  rejected: { label: 'Não aprovado', tone: 'fail' },
};

/**
 * One depoimento per customer (TestimonialsService upserts by userId) —
 * this page is both "send your first one" and "edit it," never a list.
 * Editing always sends the testimonial back to 'pending' server-side, so
 * the status badge here is the honest current state, not a cached one.
 */
export function TestimonialPage() {
  const queryClient = useQueryClient();
  const eligibility = useQuery({ queryKey: ['client', 'testimonial-eligibility'], queryFn: getTestimonialEligibility });
  const existing = useQuery({ queryKey: ['client', 'testimonial'], queryFn: getMyTestimonial, enabled: eligibility.data?.eligible === true });
  const [rating, setRating] = useState(0);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (existing.data) {
      setRating(existing.data.rating);
      setMessage(existing.data.message);
    }
  }, [existing.data]);

  const mutation = useMutation({
    mutationFn: () => submitTestimonial({ rating, message: message.trim() }),
    onSuccess: (testimonial) => {
      queryClient.setQueryData(['client', 'testimonial'], testimonial);
      setNotice('Depoimento enviado! Ele passa por uma análise antes de aparecer no site.');
      setError(null);
    },
    onError: (err) => {
      setNotice(null);
      setError(err instanceof ApiError ? err.message : 'Não foi possível enviar seu depoimento.');
    },
  });

  function handleSubmit() {
    setError(null);
    setNotice(null);
    if (rating < 1) return setError('Escolha uma nota de 1 a 5 estrelas.');
    if (message.trim().length < 10) return setError('Escreva pelo menos 10 caracteres.');
    mutation.mutate();
  }

  return (
    <>
      <PageHeader title="Depoimento" subtitle="Conte como foi sua experiência com a GXhost. Os melhores depoimentos são destacados na página inicial." />

      <div className="max-w-2xl">
        {eligibility.isLoading ? (
          <LoadingRow />
        ) : !eligibility.data?.eligible ? (
          <Alert tone="info">Depoimentos são exclusivos para clientes que já tiveram um servidor contratado na GXhost.</Alert>
        ) : (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Seu depoimento</CardTitle>
                <CardDescription>Aparece com seu nome, se for aprovado e destacado por um administrador.</CardDescription>
              </div>
              {existing.data && <Badge tone={STATUS_LABEL[existing.data.status].tone}>{STATUS_LABEL[existing.data.status].label}</Badge>}
            </CardHeader>
            <CardBody className="space-y-5">
              {existing.isLoading ? (
                <LoadingRow />
              ) : (
                <>
                  <Field label="Sua nota">
                    <StarRating value={rating} onChange={setRating} />
                  </Field>
                  <Field label="Seu depoimento">
                    <Textarea rows={5} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Conte como foi montar e usar seu servidor na GXhost..." />
                  </Field>
                  {notice && <Alert tone="ok">{notice}</Alert>}
                  {error && <Alert>{error}</Alert>}
                  <Button variant="primary" onClick={handleSubmit} disabled={mutation.isPending}>
                    <Send className="h-4 w-4" /> {mutation.isPending ? 'Enviando…' : existing.data ? 'Atualizar depoimento' : 'Enviar depoimento'}
                  </Button>
                </>
              )}
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
