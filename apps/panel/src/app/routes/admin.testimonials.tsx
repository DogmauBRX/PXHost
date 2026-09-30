import { createFileRoute } from '@tanstack/react-router';
import { TestimonialsPage } from '@/features/admin/TestimonialsPage';

export const Route = createFileRoute('/admin/testimonials')({
  component: TestimonialsPage,
});
