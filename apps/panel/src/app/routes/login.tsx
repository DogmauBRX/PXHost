import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { Moon, Sun } from 'lucide-react';
import { useAuthStore } from '@/shared/stores/auth.store';
import { useThemeStore } from '@/shared/theme/theme.store';
import { LoginForm } from '@/features/auth/LoginForm';
import { Logo } from '@/ui/brand/Logo';
import { Wordmark } from '@/ui/brand/Wordmark';

export const Route = createFileRoute('/login')({
  beforeLoad: () => {
    if (useAuthStore.getState().accessToken) {
      throw redirect({ to: '/' });
    }
  },
  component: LoginPage,
});

function LoginPage() {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);

  // No `bg-bg` on this div — it would paint solid over `body`'s wallpaper
  // (index.css) the instant React mounts. `body` already carries the same
  // base color underneath, so leaving this transparent is enough.
  // `login-hero` layers a slow-drifting aurora glow on top of that shared
  // wallpaper — the one page where the brand gets the full-bleed moment,
  // since every other screen is a working dashboard.
  return (
    <div className="login-hero relative flex h-screen items-center justify-center px-4">
      {/* A plain icon button (Topbar's own treatment) reads fine sitting on
          a flat `bg-surface` header, but here it floats directly over the
          aurora glow — no surface underneath to separate it from a
          background that shifts color under it. It needs its own opaque
          surface + border + shadow to stay legible at every point in the
          drift, not just on hover. */}
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
        title={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
        className="absolute top-4 right-4 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-surface text-text shadow-md transition-colors hover:border-accent/40 hover:text-accent-strong sm:top-6 sm:right-6"
      >
        {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
      </button>

      <div className="flex w-full max-w-sm flex-col items-center">
        <div className="mb-8 flex flex-col items-center gap-4">
          <Logo size={72} />
          <Wordmark className="text-5xl" />
        </div>
        <div className="w-full rounded-xl border border-border bg-surface p-8 shadow-lg">
          <h1 className="mb-6 text-lg font-semibold text-text">Entrar no painel</h1>
          <LoginForm />
          <Link to="/forgot-password" className="mt-4 block text-center text-sm text-text-muted transition-colors hover:text-text">
            Esqueci minha senha
          </Link>
        </div>
      </div>
    </div>
  );
}
