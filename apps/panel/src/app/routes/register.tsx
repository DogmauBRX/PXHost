import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { z } from 'zod';
import { useAuthStore } from '@/shared/stores/auth.store';
import { RegisterForm } from '@/features/public/RegisterForm';
import { Seo } from '@/features/public/Seo';
import { Logo } from '@/ui/brand/Logo';
import { Wordmark } from '@/ui/brand/Wordmark';
import { HeroCircuitBackground } from '@/features/public/HeroCircuitBackground';

// Same `redirect` contract as /login (see that route's own doc comment)
// — the commercial checkout flow sends a not-yet-authenticated visitor
// here (or to /login) with its own URL, and this lands them back there
// instead of the generic client dashboard once the account exists.
const searchSchema = z.object({
  redirect: z.string().optional(),
});

export const Route = createFileRoute('/register')({
  validateSearch: searchSchema,
  beforeLoad: ({ search }) => {
    if (useAuthStore.getState().accessToken) {
      throw redirect({ to: search.redirect ?? '/' });
    }
  },
  component: RegisterPage,
});

function RegisterPage() {
  const { redirect: redirectTo } = Route.useSearch();

  return (
    <div className="login-hero relative flex min-h-screen items-center justify-center px-4 py-12">
      <HeroCircuitBackground className="login-hero__circuit pointer-events-none absolute inset-0 h-full w-full" />
      <Seo title="Criar conta" description="Crie sua conta GXhost para assinar um plano e gerenciar seu servidor de jogos." path="/register" />
      <div className="relative flex w-full max-w-sm flex-col items-center">
        <Link to="/" className="mb-8 flex flex-col items-center gap-4">
          <div className="login-hero__logo-wrap">
            <div className="login-hero__logo-glow" />
            <Logo size={72} className="relative" />
          </div>
          <Wordmark className="text-5xl" />
        </Link>
        <div className="w-full rounded-xl border border-border-strong bg-surface p-8 shadow-lg">
          <h1 className="mb-6 text-lg font-semibold text-text">Criar conta</h1>
          <RegisterForm redirectTo={redirectTo} />
          <Link
            to="/login"
            search={{ redirect: redirectTo }}
            className="mt-4 block text-center text-sm text-text-muted transition-colors hover:text-text"
          >
            Já tem uma conta? <span className="font-medium text-accent-strong">Entrar</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
