import type { ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '@/shared/stores/auth.store';
import { logout } from '@/features/auth/auth.api';
import { Button } from '@/ui/primitives/Button';

export function AppShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const clear = useAuthStore((s) => s.clear);
  const navigate = useNavigate();

  async function handleLogout() {
    try {
      await logout();
    } finally {
      clear();
      void navigate({ to: '/login' });
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-medium tracking-wide text-accent-strong">PXHost</span>
        </div>
        <div className="flex items-center gap-3">
          {user?.isAdmin && (
            <Link to="/admin" className="text-sm text-text-muted hover:text-text">
              Admin
            </Link>
          )}
          <span className="text-sm text-text-muted">{user?.email}</span>
          <Button variant="ghost" onClick={() => void handleLogout()}>
            Sair
          </Button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto p-6">{children}</main>
    </div>
  );
}
