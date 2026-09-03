import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from '@tanstack/react-router';
import { register } from '@/features/auth/auth.api';
import { useAuthStore } from '@/shared/stores/auth.store';
import { ApiError } from '@/shared/api/client';
import { Alert, Button, Field, Input } from '@/ui/primitives';

const schema = z
  .object({
    name: z.string().min(1, 'Informe seu nome'),
    email: z.string().email('Informe um e-mail válido'),
    password: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres'),
    confirmPassword: z.string().min(1, 'Confirme sua senha'),
  })
  .refine((v) => v.password === v.confirmPassword, { message: 'As senhas não coincidem', path: ['confirmPassword'] });
type FormValues = z.infer<typeof schema>;

/**
 * Commercial site — public self-signup (§8: apenas nome/e-mail/senha/
 * confirmação). Mirrors LoginForm's shape exactly (same field primitives,
 * same error handling, same redirectTo behavior for the "assinar → login
 * ou cadastro → volta ao checkout" flow) so the two forms read as one
 * consistent auth experience rather than two different products.
 */
export function RegisterForm({ redirectTo }: { redirectTo?: string } = {}) {
  const navigate = useNavigate();
  const setSession = useAuthStore((s) => s.setSession);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register: registerField,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormValues) {
    setServerError(null);
    try {
      const res = await register(values);
      setSession(res.accessToken, {
        id: res.user.id,
        email: res.user.email,
        username: res.user.username,
        isAdmin: res.user.globalRole !== 'user', // always false — register always creates globalRole: 'user' — but read off the response anyway, never assumed client-side.
      });
      void navigate({ to: redirectTo ?? '/client' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setServerError('Já existe uma conta com este e-mail. Tente entrar em vez de criar uma nova conta.');
      } else if (err instanceof ApiError && err.status === 404) {
        // ALLOW_PUBLIC_REGISTRATION is off on this deployment — a visitor
        // has no actionable difference between this and any other
        // failure, so it reads the same as a generic error.
        setServerError('Não foi possível criar sua conta. Tente novamente mais tarde.');
      } else {
        setServerError(err instanceof ApiError ? err.message : 'Não foi possível criar sua conta. Tente novamente.');
      }
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="flex flex-col gap-4">
      <Field label="Nome" htmlFor="name" error={errors.name?.message}>
        <Input id="name" autoComplete="name" invalid={!!errors.name} {...registerField('name')} />
      </Field>

      <Field label="E-mail" htmlFor="email" error={errors.email?.message}>
        <Input id="email" type="email" autoComplete="email" invalid={!!errors.email} {...registerField('email')} />
      </Field>

      <Field label="Senha" htmlFor="password" error={errors.password?.message} hint={!errors.password ? 'Mínimo de 8 caracteres' : undefined}>
        <Input id="password" type="password" autoComplete="new-password" invalid={!!errors.password} {...registerField('password')} />
      </Field>

      <Field label="Confirmar senha" htmlFor="confirmPassword" error={errors.confirmPassword?.message}>
        <Input id="confirmPassword" type="password" autoComplete="new-password" invalid={!!errors.confirmPassword} {...registerField('confirmPassword')} />
      </Field>

      {serverError && <Alert>{serverError}</Alert>}

      <Button type="submit" variant="primary" disabled={isSubmitting} className="mt-1 w-full">
        {isSubmitting ? 'Criando conta…' : 'Criar conta'}
      </Button>
    </form>
  );
}
