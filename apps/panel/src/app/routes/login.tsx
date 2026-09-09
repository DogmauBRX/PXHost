import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { ArrowLeft, Moon, Sun } from 'lucide-react';
import { z } from 'zod';
import { useAuthStore } from '@/shared/stores/auth.store';
import { useThemeStore } from '@/shared/theme/theme.store';
import { LoginForm } from '@/features/auth/LoginForm';
import { Logo } from '@/ui/brand/Logo';
import { Wordmark } from '@/ui/brand/Wordmark';
import { HeroCircuitBackground } from '@/features/public/HeroCircuitBackground';

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

  // `login-hero` (index.css) paints an opaque circuit-board backdrop —
  // the one set of screens where the brand gets the full-bleed moment,
  // deliberately distinct from the dot-grid wallpaper `body` carries
  // once a visitor is actually inside the panel (see that rule's own
  // doc comment).
  return (
    <div className="login-hero relative flex h-screen items-center justify-center px-4">
      <HeroCircuitBackground className="login-hero__circuit pointer-events-none absolute inset-0 h-full w-full" />
      {/* Back to the public landing page (`/` — see that route's own doc
          comment: it's the logged-out home, not an auth-gated dispatcher)
          — a visitor who opened this page by mistake, or just wants to
          browse plans again, shouldn't have to hit the browser's own back
          button. Mirrors the theme toggle's exact circular-button treatment
          (opposite corner) for a symmetric header, same reasoning: it needs
          its own opaque surface to stay legible over the circuit backdrop. */}
      <Link
        to="/"
        aria-label="Voltar para a página inicial"
        title="Voltar para a página inicial"
        className="absolute top-4 left-4 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-surface text-text shadow-md transition-colors hover:border-accent/40 hover:text-accent-strong sm:top-6 sm:left-6"
      >
        <ArrowLeft className="h-5 w-5" />
      </Link>
      {/* A plain icon button (Topbar's own treatment) reads fine sitting on
          a flat `bg-surface` header, but here it floats directly over the
          circuit-board backdrop — no surface underneath to separate it
          from a background with its own texture. It needs its own opaque
          surface + border + shadow to stay legible on top of it. */}
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
        title={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
        className="absolute top-4 right-4 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-surface text-text shadow-md transition-colors hover:border-accent/40 hover:text-accent-strong sm:top-6 sm:right-6"
      >
        {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
      </button>

      {/* `relative` here is load-bearing, not decorative: `.login-hero__circuit`
          above is `position: absolute` with no z-index, which per the CSS
          stacking spec paints ABOVE any plain static (non-positioned)
          sibling regardless of DOM order — without this, the circuit's
          orange traces rendered on TOP of the login card's own opaque
          background instead of behind it, bleeding through visually. Any
          `position` value puts this wrapper in the same "positioned,
          z-index:auto" stacking layer as the circuit, where later-DOM-order
          wins — the same fix already applied to `.login-hero__logo-wrap`. */}
      <div className="relative flex w-full max-w-sm flex-col items-center">
        <div className="mb-8 flex flex-col items-center gap-4">
          <div className="login-hero__logo-wrap">
            <div className="login-hero__logo-glow" />
            <Logo size={72} className="relative" />
          </div>
          <Wordmark className="text-5xl" />
        </div>
        <div className="w-full rounded-xl border border-border-strong bg-surface p-8 shadow-lg">
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
