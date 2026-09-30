import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, MessageSquareQuote, X } from 'lucide-react';
import { listAdminTestimonials, moderateTestimonial } from './admin.api';
import { ApiError } from '@/shared/api/client';
import type { Testimonial, TestimonialStatus } from '@/shared/api/types';
import { formatDateTimeShort } from '@/shared/format/datetime';
import { Alert, Badge, Button, EmptyState, Input, LoadingRow, PageHeader, Select, StarRating } from '@/ui/primitives';

const STATUS_LABEL: Record<TestimonialStatus, string> = { pending: 'Pendente', approved: 'Aprovado', rejected: 'Rejeitado' };
const STATUS_TONE: Record<TestimonialStatus, 'ok' | 'warn' | 'fail'> = { pending: 'warn', approved: 'ok', rejected: 'fail' };

export function TestimonialsPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<TestimonialStatus | ''>('pending');

  const { data: testimonials, isPending, error } = useQuery({
    queryKey: ['admin', 'testimonials', status],
    queryFn: () => listAdminTestimonials(status || undefined),
  });

  const mutation = useMutation({
    mutationFn: ({ id, ...input }: { id: string; status?: TestimonialStatus; featured?: boolean; featuredOrder?: number }) => moderateTestimonial(id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'testimonials'] }),
  });

  return (
    <>
      <PageHeader title="Depoimentos" subtitle="Analise os depoimentos enviados por clientes e escolha quais aparecem na página inicial." />
      {mutation.error && <Alert tone="fail" className="mb-4">{mutation.error instanceof ApiError ? mutation.error.message : 'Não foi possível concluir a ação.'}</Alert>}

      <div className="mb-4 max-w-xs">
        <Select aria-label="Filtrar por status" value={status} onChange={(event) => setStatus(event.target.value as TestimonialStatus | '')}>
          <option value="">Todos os status</option>
          <option value="pending">Pendentes</option>
          <option value="approved">Aprovados</option>
          <option value="rejected">Rejeitados</option>
        </Select>
      </div>

      {isPending ? (
        <LoadingRow />
      ) : error ? (
        <Alert tone="fail">Não foi possível carregar os depoimentos.</Alert>
      ) : !testimonials?.length ? (
        <EmptyState icon={MessageSquareQuote} title="Nenhum depoimento encontrado" description="Não há depoimentos para os filtros selecionados." />
      ) : (
        <div className="space-y-3">
          {testimonials.map((testimonial) => (
            <TestimonialRow
              key={testimonial.id}
              testimonial={testimonial}
              onModerate={(input) => mutation.mutate({ id: testimonial.id, ...input })}
              pending={mutation.isPending && mutation.variables?.id === testimonial.id}
            />
          ))}
        </div>
      )}
    </>
  );
}

function TestimonialRow({ testimonial, onModerate, pending }: {
  testimonial: Testimonial;
  onModerate: (input: { status?: TestimonialStatus; featured?: boolean; featuredOrder?: number }) => void;
  pending: boolean;
}) {
  const [order, setOrder] = useState(testimonial.featuredOrder ?? 0);

  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-text">{testimonial.authorName}</span>
            <Badge tone={STATUS_TONE[testimonial.status]}>{STATUS_LABEL[testimonial.status]}</Badge>
            {testimonial.featured && <Badge tone="ok">Destacado</Badge>}
          </div>
          <div className="mt-1"><StarRating value={testimonial.rating} size="sm" /></div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-text-muted">{testimonial.message}</p>
          <p className="mt-2 text-xs text-text-faint">Enviado em {formatDateTimeShort(testimonial.createdAt)}</p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          {testimonial.status === 'pending' && (
            <div className="flex gap-2">
              <Button size="sm" variant="primary" disabled={pending} onClick={() => onModerate({ status: 'approved' })}><Check className="h-4 w-4" /> Aprovar</Button>
              <Button size="sm" variant="danger" disabled={pending} onClick={() => onModerate({ status: 'rejected' })}><X className="h-4 w-4" /> Rejeitar</Button>
            </div>
          )}
          {testimonial.status === 'approved' && (
            <div className="flex items-center gap-2">
              <Input
                aria-label="Ordem de exibição"
                type="number"
                min={0}
                className="w-20"
                value={order}
                onChange={(event) => setOrder(Number(event.target.value))}
                disabled={!testimonial.featured}
              />
              <Button
                size="sm"
                variant={testimonial.featured ? 'secondary' : 'primary'}
                disabled={pending}
                onClick={() => onModerate({ featured: !testimonial.featured, featuredOrder: order })}
              >
                {testimonial.featured ? 'Remover destaque' : 'Destacar'}
              </Button>
            </div>
          )}
          {testimonial.status === 'rejected' && (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => onModerate({ status: 'approved' })}>Aprovar mesmo assim</Button>
          )}
        </div>
      </div>
    </div>
  );
}
