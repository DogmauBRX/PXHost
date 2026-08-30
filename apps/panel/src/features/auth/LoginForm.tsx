import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from '@tanstack/react-router';
import { login } from './auth.api';
import { useAuthStore } from '@/shared/stores/auth.store';
import { ApiError } from '@/shared/api/client';
import { Button } from '@/ui/primitives/Button';

const schema = z.object({
  email: z.string().email('Informe um e-mail válido'),
  password: z.string().min(1, 'Informe sua senha'),
});
type FormValues = z.infer<typeof schema>;

export function LoginForm() {
  const navigate = useNavigate();
  const setSession = useAuthStore((s) => s.setSession);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormValues) {
    setServerError(null);
    try {
      const res = await login(values.email, values.password);
      setSession(res.accessToken, { id: res.user.id, email: res.user.email, isAdmin: res.user.globalRole !== 'user' });
      void navigate({ to: '/' });
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Não foi possível entrar. Tente novamente.');
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-sm font-medium text-text-muted">
          E-mail
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent"
          {...register('email')}
        />
        {errors.email && <p className="text-xs text-fail">{errors.email.message}</p>}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-sm font-medium text-text-muted">
          Senha
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent"
          {...register('password')}
        />
        {errors.password && <p className="text-xs text-fail">{errors.password.message}</p>}
      </div>

      {serverError && <p className="rounded-md bg-fail-tint px-3 py-2 text-sm text-fail">{serverError}</p>}

      <Button type="submit" variant="primary" disabled={isSubmitting} className="mt-1 w-full">
        {isSubmitting ? 'Entrando…' : 'Entrar'}
      </Button>
    </form>
  );
}
