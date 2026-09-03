import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { useAuthStore } from '@/shared/stores/auth.store';
import { ForgotPasswordForm } from '@/features/auth/ForgotPasswordForm';
import { Logo } from '@/ui/brand/Logo';
import { Wordmark } from '@/ui/brand/Wordmark';

// Public route, same shape as login.tsx's own beforeLoad — redirect AWAY
// if already logged in, never require auth (this page exists specifically
// for someone who can't log in).
export const Route = createFileRoute('/forgot-password')({
  beforeLoad: () => {
    if (useAuthStore.getState().accessToken) {
      throw redirect({ to: '/' });
    }
  },
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  return (
    <div className="login-hero relative flex h-screen items-center justify-center px-4">
      <div className="flex w-full max-w-sm flex-col items-center">
        <div className="mb-8 flex flex-col items-center gap-4">
          <Logo size={72} />
          <Wordmark className="text-5xl" />
        </div>
        <div className="w-full rounded-xl border border-border bg-surface p-8 shadow-lg">
          <h1 className="mb-2 text-lg font-semibold text-text">Esqueci minha senha</h1>
          <p className="mb-6 text-sm text-text-muted">Informe o e-mail da sua conta e enviaremos instruções para redefinir sua senha.</p>
          <ForgotPasswordForm />
          <Link to="/login" className="mt-4 block text-center text-sm text-text-muted transition-colors hover:text-text">
            Voltar para o login
          </Link>
        </div>
      </div>
    </div>
  );
}
