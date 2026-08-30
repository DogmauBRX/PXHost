import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

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
 * Still a `{ children }` wrapper rather than a layout route, because it is
 * used by exactly three route files and converting would mean renaming all
 * 17 of them — regenerating every route id for no visual gain.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-bg">
      <Sidebar />
      <div className="lg:pl-64">
        <Topbar />
        <main className="mx-auto w-full max-w-[1680px] px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
