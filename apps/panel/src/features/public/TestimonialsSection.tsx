import { useQuery } from '@tanstack/react-query';
import { Quote } from 'lucide-react';
import { getPublicTestimonials } from './public.api';
import { StarRating } from '@/ui/primitives';

/**
 * Only admin-approved AND admin-featured depoimentos ever reach this
 * component (see TestimonialsService.listPublicFeatured) — nothing here
 * needs its own moderation-awareness, an empty list just means nothing has
 * been featured yet, which is a normal early state, not an error.
 */
export function TestimonialsSection() {
  const { data } = useQuery({ queryKey: ['public', 'testimonials'], queryFn: getPublicTestimonials, staleTime: 60_000 });

  if (!data || data.length === 0) return null;

  return (
    <section className="landing-section relative border-y border-white/8 px-4 py-24 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <span className="font-mono text-xs font-semibold tracking-[0.18em] text-accent uppercase">Quem já joga com a gente</span>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-text sm:text-4xl">Depoimentos de clientes reais.</h2>
          <p className="mt-4 text-text-muted">Selecionados entre quem já roda um servidor na GXhost.</p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((testimonial) => (
            <article key={testimonial.id} className="landing-benefit-card relative flex flex-col overflow-hidden rounded-2xl border border-white/10 p-6">
              <Quote className="mb-4 h-6 w-6 text-accent/40" aria-hidden="true" />
              <p className="flex-1 text-sm leading-6 text-text-muted">&ldquo;{testimonial.message}&rdquo;</p>
              <div className="mt-5 flex items-center justify-between border-t border-white/8 pt-4">
                <span className="text-sm font-semibold text-text">{testimonial.authorName}</span>
                <StarRating value={testimonial.rating} size="sm" />
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
