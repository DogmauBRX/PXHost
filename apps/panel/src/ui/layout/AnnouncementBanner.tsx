import { useQuery } from '@tanstack/react-query';
import { Megaphone } from 'lucide-react';
import { getPublicAnnouncement } from '@/features/public/public.api';

/**
 * The site-wide warning banner an admin toggles on/off from
 * `/admin/announcement` (`SiteAnnouncementPage.tsx`) — rendered by BOTH
 * `PublicShell` (a logged-out visitor) and `AppShell` (a logged-in
 * admin or client), since neither shell wraps the other and there is no
 * single shared root to put this in once. Same `getPublicAnnouncement()`
 * call in both places, same `@Public()` API route regardless of who's
 * logged in — this component owns no auth logic of its own.
 *
 * `null` (nothing active, or an empty message) renders nothing at all —
 * the whole contract, no separate "is it active" check anywhere else.
 * Polls every 60s rather than once on mount: an admin flipping this on
 * mid-incident should reach an already-open tab without a reload.
 */
export function AnnouncementBanner() {
  const { data } = useQuery({ queryKey: ['public', 'announcement'], queryFn: getPublicAnnouncement, refetchInterval: 60_000 });

  if (!data) return null;

  return (
    <div role="status" className="flex items-center justify-center gap-2 border-b border-warn/25 bg-warn-tint px-4 py-2.5 text-center text-sm text-warn">
      <Megaphone className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="font-medium">{data.message}</span>
    </div>
  );
}
