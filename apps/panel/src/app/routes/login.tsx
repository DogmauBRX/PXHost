import { createFileRoute, redirect } from '@tanstack/react-router';
import { useAuthStore } from '@/shared/stores/auth.store';
import { LoginForm } from '@/features/auth/LoginForm';

export const Route = createFileRoute('/login')({
  beforeLoad: () => {
    if (useAuthStore.getState().accessToken) {
      throw redirect({ to: '/' });
    }
  },
  component: LoginPage,
});

function LoginPage() {
  return (
    <div className="flex h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-8 shadow-lg">
        <p className="mb-1 font-mono text-sm font-medium tracking-wide text-accent-strong">PXHost</p>
        <h1 className="mb-6 text-lg font-semibold text-text">Entrar no painel</h1>
        <LoginForm />
      </div>
    </div>
  );
}
