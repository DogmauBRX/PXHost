import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from '@tanstack/react-router';
import { login } from './auth.api';
import { useAuthStore } from '@/shared/stores/auth.store';
import { ApiError } from '@/shared/api/client';
import { Alert, Button, Field, Input } from '@/ui/primitives';

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
      setSession(res.accessToken, {
        id: res.user.id,
        email: res.user.email,
        username: res.user.username,
        isAdmin: res.user.globalRole !== 'user',
      });
      void navigate({ to: '/' });
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Não foi possível entrar. Tente novamente.');
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="flex flex-col gap-4">
      <Field label="E-mail" htmlFor="email" error={errors.email?.message}>
        <Input id="email" type="email" autoComplete="email" invalid={!!errors.email} {...register('email')} />
      </Field>

      <Field label="Senha" htmlFor="password" error={errors.password?.message}>
        <Input id="password" type="password" autoComplete="current-password" invalid={!!errors.password} {...register('password')} />
      </Field>

      {serverError && <Alert>{serverError}</Alert>}

      <Button type="submit" variant="primary" disabled={isSubmitting} className="mt-1 w-full">
        {isSubmitting ? 'Entrando…' : 'Entrar'}
      </Button>
    </form>
  );
}
