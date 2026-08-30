import { createFileRoute } from '@tanstack/react-router';
import { TemplatesPage } from '@/features/admin/TemplatesPage';

export const Route = createFileRoute('/admin/templates')({
  component: TemplatesPage,
});
