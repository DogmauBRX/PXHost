import { createFileRoute } from '@tanstack/react-router';
import { SiteAnnouncementPage } from '@/features/admin/SiteAnnouncementPage';

export const Route = createFileRoute('/admin/announcement')({
  component: SiteAnnouncementPage,
});
