import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link } from '@tanstack/react-router';
import { resetPassword } from './auth.api';
import { ApiError } from '@/shared/api/client';
import { Alert, Button, Field, Input } from '@/ui/primitives';

const schema = z
  .object({
    newPassword: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres'),
    confirmPassword: z.string().min(1, 'Confirme a nova senha'),
  })
  .refine((v) => v.newPassword === v.confirmPassword, { message: 'As senhas não coincidem', path: ['confirmPassword'] });
type FormValues = z.infer<typeof schema>;

export function ResetPasswordForm({ token }: { token: string }) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormValues) {
    setServerError(null);
    try {
      await resetPassword(token, values.newPassword, values.confirmPassword);
      setDone(true);
    } catch (err) {
      // "Invalid or expired token" and "newPassword and confirmPassword
      // must match" are the two real error shapes from the API — both
      // come through as ApiError.message already in Portuguese-adjacent
      // plain text; no reason to remap them client-side.
      setServerError(err instanceof ApiError ? err.message : 'Não foi possível alterar a senha. Tente novamente.');
    }
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="ok">Senha alterada com sucesso.</Alert>
        <Link to="/login">
          <Button variant="primary" className="w-full">
            Entrar na conta
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="flex flex-col gap-4">
      <Field label="Nova senha" htmlFor="newPassword" error={errors.newPassword?.message}>
        <Input id="newPassword" type="password" autoComplete="new-password" invalid={!!errors.newPassword} {...register('newPassword')} />
      </Field>

      <Field label="Confirmar nova senha" htmlFor="confirmPassword" error={errors.confirmPassword?.message}>
        <Input id="confirmPassword" type="password" autoComplete="new-password" invalid={!!errors.confirmPassword} {...register('confirmPassword')} />
      </Field>

      {serverError && <Alert>{serverError}</Alert>}

      <Button type="submit" variant="primary" disabled={isSubmitting} className="mt-1 w-full">
        {isSubmitting ? 'Salvando…' : 'Definir nova senha'}
      </Button>
    </form>
  );
}
