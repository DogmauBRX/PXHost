import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { Moon, Sun } from 'lucide-react';
import { z } from 'zod';
import { useAuthStore } from '@/shared/stores/auth.store';
import { useThemeStore } from '@/shared/theme/theme.store';
import { LoginForm } from '@/features/auth/LoginForm';
import { Logo } from '@/ui/brand/Logo';
import { Wordmark } from '@/ui/brand/Wordmark';

// `redirect` — where to send the visitor after a successful login,
// commercial plan §10's "Login/Cadastro → Resumo → Checkout" flow: the
// checkout route sends an unauthenticated visitor here with its own URL
// as `redirect` (see app/routes/checkout.$planSlug.tsx), and login lands
// them back exactly where they started instead of the panel dashboard.
// Absent for every OTHER entry point (the sidebar's own session-expiry
// redirect, a bookmark, etc.), which is why it's optional and falls back
// to the role-based dashboard exactly like before this field existed.
const searchSchema = z.object({
  redirect: z.string().optional(),
});

export const Route = createFileRoute('/login')({
  validateSearch: searchSchema,
  beforeLoad: ({ search }) => {
    if (useAuthStore.getState().accessToken) {
      throw redirect({ to: search.redirect ?? '/' });
    }
  },
  component: LoginPage,
});

function LoginPage() {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const { redirect: redirectTo } = Route.useSearch();

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
          <h1 className="mb-6 text-lg font-semibold text-text">Entrar</h1>
          <LoginForm redirectTo={redirectTo} />
          <div className="mt-4 flex flex-col items-center gap-2 text-sm">
            <Link to="/forgot-password" className="text-text-muted transition-colors hover:text-text">
              Esqueci minha senha
            </Link>
            <Link to="/register" search={{ redirect: redirectTo }} className="text-text-muted transition-colors hover:text-text">
              Não tem uma conta? <span className="font-medium text-accent-strong">Criar conta</span>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
