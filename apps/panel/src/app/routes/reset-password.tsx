import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { z } from 'zod';
import { useAuthStore } from '@/shared/stores/auth.store';
import { ResetPasswordForm } from '@/features/auth/ResetPasswordForm';
import { Alert } from '@/ui/primitives';
import { Logo } from '@/ui/brand/Logo';
import { Wordmark } from '@/ui/brand/Wordmark';
import { HeroCircuitBackground } from '@/features/public/HeroCircuitBackground';

const searchSchema = z.object({
  token: z.string().optional(),
});

// Public route, same beforeLoad shape as login.tsx/forgot-password.tsx.
export const Route = createFileRoute('/reset-password')({
  validateSearch: searchSchema,
  beforeLoad: () => {
    if (useAuthStore.getState().accessToken) {
      throw redirect({ to: '/' });
    }
  },
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { token } = Route.useSearch();

  return (
    <div className="login-hero relative flex h-screen items-center justify-center px-4">
      <HeroCircuitBackground className="login-hero__circuit pointer-events-none absolute inset-0 h-full w-full" />
      <div className="relative flex w-full max-w-sm flex-col items-center">
        <div className="mb-8 flex flex-col items-center gap-4">
          <div className="login-hero__logo-wrap">
            <div className="login-hero__logo-glow" />
            <Logo size={72} className="relative" />
          </div>
          <Wordmark className="text-5xl" />
        </div>
        <div className="w-full rounded-xl border border-border-strong bg-surface p-8 shadow-lg">
          <h1 className="mb-2 text-lg font-semibold text-text">Definir nova senha</h1>
          {!token ? (
            <>
              <Alert className="mb-4">Link inválido — falta o token de redefinição.</Alert>
              <Link to="/forgot-password" className="block text-center text-sm text-text-muted transition-colors hover:text-text">
                Solicitar um novo link
              </Link>
            </>
          ) : (
            <ResetPasswordForm token={token} />
          )}
        </div>
      </div>
    </div>
  );
}
