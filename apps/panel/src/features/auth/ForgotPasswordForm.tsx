import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { forgotPassword } from './auth.api';
import { ApiError } from '@/shared/api/client';
import { Alert, Button, Field, Input } from '@/ui/primitives';

const schema = z.object({
  email: z.string().email('Informe um e-mail válido'),
});
type FormValues = z.infer<typeof schema>;

// Deliberately no "email not found" case — the backend always returns the
// same generic message regardless of whether the address exists
// (anti-enumeration, see AuthService.requestPasswordReset's doc comment).
// A real error here only ever means the request itself failed (bad
// format caught by the resolver above, rate limit, network).
export function ForgotPasswordForm() {
  const [serverError, setServerError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormValues) {
    setServerError(null);
    try {
      const res = await forgotPassword(values.email);
      setSent(true);
      setMessage(res.message);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Não foi possível enviar a solicitação. Tente novamente.');
    }
  }

  if (sent) {
    return (
      <Alert tone="ok">
        {message ?? 'Se existir uma conta associada a este email, enviaremos instruções para recuperar seu acesso.'}
      </Alert>
    );
  }

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="flex flex-col gap-4">
      <Field label="E-mail" htmlFor="email" error={errors.email?.message}>
        <Input id="email" type="email" autoComplete="email" invalid={!!errors.email} {...register('email')} />
      </Field>

      {serverError && <Alert>{serverError}</Alert>}

      <Button type="submit" variant="primary" disabled={isSubmitting} className="mt-1 w-full">
        {isSubmitting ? 'Enviando…' : 'Enviar instruções'}
      </Button>
    </form>
  );
}
