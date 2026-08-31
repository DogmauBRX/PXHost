import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { ADMIN_NAV_SECTIONS, CLIENT_NAV_SECTIONS } from './nav.config';

/**
 * Fixed left rail + fluid content column.
 *
 * The important part is what is NOT here: no `h-screen`, and no
 * `overflow-auto` on `<main>`. The previous shell locked the app to the
 * viewport and made `<main>` its own scroll container, which meant every
 * page then had to fight for height with `h-full` + `flex-1` + another
 * `overflow-auto`. That chain is what collapsed the templates list to
 * `clientHeight: 0` while it held 2,498px of content. The document scrolls
 * now, and pages simply grow.
 *
 * Still a `{ children }` wrapper rather than a layout route, because
 * renaming route files to introduce one has already bitten this codebase
 * once (see `servers.$serverId.tsx`'s own header comment) — adding a new
 * layout route is fine, renaming existing ones for cosmetic reasons is not.
 *
 * `area` picks which of the two genuinely separate nav trees this shell
 * renders — admin and client are different products sharing one visual
 * system, not one product with some menu items hidden.
 */
export function AppShell({ children, area }: { children: ReactNode; area: 'admin' | 'client' }) {
  const sections = area === 'admin' ? ADMIN_NAV_SECTIONS : CLIENT_NAV_SECTIONS;
  const panelLabel = area === 'admin' ? 'ADMIN PANEL' : 'CLIENT PANEL';
  const settingsTo = area === 'admin' ? '/admin/settings' : '/client/settings';

  return (
    <div className="min-h-screen bg-bg">
      <Sidebar sections={sections} panelLabel={panelLabel} settingsTo={settingsTo} />
      <div className="lg:pl-64">
        <Topbar />
        <main className="mx-auto w-full max-w-[1680px] px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
