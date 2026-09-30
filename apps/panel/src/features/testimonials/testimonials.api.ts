import { apiFetch } from '@/shared/api/client';
import type { Testimonial } from '@/shared/api/types';

export const getMyTestimonial = () => apiFetch<Testimonial | null>('/api/client/testimonials/mine');
export const getTestimonialEligibility = () => apiFetch<{ eligible: boolean }>('/api/client/testimonials/eligibility');

export interface SubmitTestimonialInput {
  rating: number;
  message: string;
}

export const submitTestimonial = (input: SubmitTestimonialInput) =>
  apiFetch<Testimonial>('/api/client/testimonials', { method: 'POST', body: JSON.stringify(input) });
