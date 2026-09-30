import { createFileRoute } from '@tanstack/react-router';
import { TestimonialPage } from '@/features/testimonials/TestimonialPage';

export const Route = createFileRoute('/client/testimonial')({
  component: TestimonialPage,
});
