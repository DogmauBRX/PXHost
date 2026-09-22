import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from '@tanstack/react-router';
import { Save } from 'lucide-react';
import { useAuthStore } from '@/shared/stores/auth.store';
import { getAccount, updateAccount, changePassword, type UpdateAccountInput } from './account.api';
import { ApiError } from '@/shared/api/client';
import type { ClientAccount } from '@/shared/api/types';
import { Alert, Avatar, Button, Card, CardBody, CardHeader, CardTitle, CardDescription, Field, Input, LoadingRow, PageHeader } from '@/ui/primitives';
import { BillingProfileFields, billingSchema, accountToBillingForm, type BillingFormValues } from '@/features/public/BillingProfileFields';

interface ProfileFormValues {
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  currentPassword: string;
}

function profileToForm(account: ClientAccount): ProfileFormValues {
  return { firstName: account.firstName ?? '', lastName: account.lastName ?? '', username: account.username, email: account.email, currentPassword: '' };
}

// The "Conta" card from before this feature, now editable. language/timezone
// exist on the User model but are deliberately NOT surfaced here — nothing
// in this app reads or reacts to them today, so exposing them as editable
// would be exactly the "field just to fill the screen" the request warned
// against. Same reasoning for phone: the column doesn't exist at all.
function ProfileCard() {
  const queryClient = useQueryClient();
  const { data: account, isLoading } = useQuery({ queryKey: ['account', 'me'], queryFn: getAccount });
  const [values, setValues] = useState<ProfileFormValues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (account) setValues(profileToForm(account));
  }, [account]);

  const mutation = useMutation({
    mutationFn: (input: UpdateAccountInput) => updateAccount(input),
    onSuccess: (updated) => {
      queryClient.setQueryData(['account', 'me'], updated);
      setValues(profileToForm(updated));
      setNotice('Dados atualizados.');
      setError(null);
    },
    onError: (err) => {
      setNotice(null);
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar as alterações.');
    },
  });

  function patch(p: Partial<ProfileFormValues>) {
    setValues((v) => (v ? { ...v, ...p } : v));
    setNotice(null);
  }

  function handleSave() {
    if (!values || !account) return;
    const input: UpdateAccountInput = {};
    if (values.firstName !== (account.firstName ?? '')) input.firstName = values.firstName.trim() || undefined;
    if (values.lastName !== (account.lastName ?? '')) input.lastName = values.lastName.trim() || undefined;
    if (values.username !== account.username) input.username = values.username.trim();
    if (values.email !== account.email) input.email = values.email.trim();

    if (Object.keys(input).length === 0) return;

    if (input.email !== undefined) {
      if (!values.currentPassword) {
        setError('Informe sua senha atual para alterar o e-mail.');
        return;
      }
      input.currentPassword = values.currentPassword;
    }

    setError(null);
    mutation.mutate(input);
  }

  const emailChanged = values && account && values.email !== account.email;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Dados da conta</CardTitle>
          <CardDescription>Suas informações de identificação no painel.</CardDescription>
        </div>
      </CardHeader>
      <CardBody>
        {isLoading || !values || !account ? (
          <LoadingRow />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-4">
              <Avatar name={account.username} email={account.email} size="lg" />
              <p className="text-xs text-text-faint">{account.globalRole === 'user' ? 'Cliente' : 'Administrador'}</p>
            </div>

            {notice && (
              <Alert tone="ok" onDismiss={() => setNotice(null)}>
                {notice}
              </Alert>
            )}
            {error && (
              <Alert onDismiss={() => setError(null)}>{error}</Alert>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Nome" htmlFor="profile-first-name">
                <Input id="profile-first-name" value={values.firstName} onChange={(e) => patch({ firstName: e.target.value })} />
              </Field>
              <Field label="Sobrenome" htmlFor="profile-last-name">
                <Input id="profile-last-name" value={values.lastName} onChange={(e) => patch({ lastName: e.target.value })} />
              </Field>
              <Field label="Nome de usuário" htmlFor="profile-username">
                <Input id="profile-username" value={values.username} onChange={(e) => patch({ username: e.target.value })} />
              </Field>
              <Field label="E-mail" htmlFor="profile-email">
                <Input id="profile-email" type="email" value={values.email} onChange={(e) => patch({ email: e.target.value })} />
              </Field>
            </div>

            {emailChanged && (
              <Field label="Senha atual" htmlFor="profile-current-password" hint="Necessária para confirmar a troca de e-mail.">
                <Input
                  id="profile-current-password"
                  type="password"
                  autoComplete="current-password"
                  value={values.currentPassword}
                  onChange={(e) => patch({ currentPassword: e.target.value })}
                />
              </Field>
            )}

            <div>
              <Button variant="primary" disabled={mutation.isPending} onClick={handleSave}>
                <Save className="h-4 w-4" aria-hidden="true" />
                {mutation.isPending ? 'Salvando…' : 'Salvar alterações'}
              </Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// Editable outside the checkout flow too (fixing a mistyped CPF shouldn't
// require subscribing again) — same load/edit/save shape as ProfileCard,
// same "Dados de cobrança" fields CheckoutPage.tsx collects, via the
// shared BillingProfileFields subform.
function BillingCard() {
  const queryClient = useQueryClient();
  const { data: account, isLoading } = useQuery({ queryKey: ['account', 'me'], queryFn: getAccount });
  const [notice, setNotice] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<BillingFormValues>({
    resolver: zodResolver(billingSchema),
    values: account ? accountToBillingForm(account) : undefined,
  });

  const mutation = useMutation({
    mutationFn: (input: UpdateAccountInput) => updateAccount(input),
    onSuccess: (updated) => {
      queryClient.setQueryData(['account', 'me'], updated);
      setNotice('Dados de cobrança atualizados.');
      setServerError(null);
    },
    onError: (err) => {
      setNotice(null);
      setServerError(err instanceof ApiError ? err.message : 'Não foi possível salvar os dados de cobrança.');
    },
  });

  async function onSubmit(values: BillingFormValues) {
    setNotice(null);
    await mutation.mutateAsync(values);
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Dados de cobrança</CardTitle>
          <CardDescription>CPF e endereço usados na hora de assinar um plano.</CardDescription>
        </div>
      </CardHeader>
      <CardBody>
        {isLoading ? (
          <LoadingRow />
        ) : (
          <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="flex max-w-md flex-col gap-4">
            {notice && (
              <Alert tone="ok" onDismiss={() => setNotice(null)}>
                {notice}
              </Alert>
            )}
            {serverError && <Alert onDismiss={() => setServerError(null)}>{serverError}</Alert>}

            <BillingProfileFields register={register} errors={errors} setValue={setValue} />

            <div>
              <Button type="submit" variant="primary" disabled={isSubmitting}>
                <Save className="h-4 w-4" aria-hidden="true" />
                {isSubmitting ? 'Salvando…' : 'Salvar dados de cobrança'}
              </Button>
            </div>
          </form>
        )}
      </CardBody>
    </Card>
  );
}

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Informe sua senha atual'),
    newPassword: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres'),
    confirmPassword: z.string().min(1, 'Confirme a nova senha'),
  })
  .refine((v) => v.newPassword === v.confirmPassword, { message: 'As senhas não coincidem', path: ['confirmPassword'] });
type ChangePasswordFormValues = z.infer<typeof changePasswordSchema>;

// Changing the password revokes every session the account has, INCLUDING
// the one making this call (SessionRevocationService.revokeAllForUser —
// see AccountService.changePassword's doc comment) — a successful
// response here means the caller is about to be logged out everywhere,
// by design. Rather than inventing a cross-page flash-message mechanism,
// the success state stays inline with a manual "Entrar novamente" button.
function ChangePasswordCard() {
  const navigate = useNavigate();
  const clear = useAuthStore((s) => s.clear);
  const [serverError, setServerError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordFormValues>({ resolver: zodResolver(changePasswordSchema) });

  async function onSubmit(values: ChangePasswordFormValues) {
    setServerError(null);
    try {
      await changePassword(values);
      setDone(true);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Não foi possível alterar a senha.');
    }
  }

  function handleReturnToLogin() {
    clear();
    void navigate({ to: '/login' });
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Alterar senha</CardTitle>
          <CardDescription>Você será desconectado de todas as sessões após a troca.</CardDescription>
        </div>
      </CardHeader>
      <CardBody>
        {done ? (
          <div className="flex flex-col gap-4">
            <Alert tone="ok">Senha alterada com sucesso. Você foi desconectado — entre novamente com a nova senha.</Alert>
            <Button variant="primary" onClick={handleReturnToLogin} className="w-fit">
              Entrar novamente
            </Button>
          </div>
        ) : (
          <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="flex max-w-md flex-col gap-4">
            <Field label="Senha atual" htmlFor="current-password" error={errors.currentPassword?.message}>
              <Input id="current-password" type="password" autoComplete="current-password" invalid={!!errors.currentPassword} {...register('currentPassword')} />
            </Field>
            <Field label="Nova senha" htmlFor="new-password" error={errors.newPassword?.message}>
              <Input id="new-password" type="password" autoComplete="new-password" invalid={!!errors.newPassword} {...register('newPassword')} />
            </Field>
            <Field label="Confirmar nova senha" htmlFor="confirm-password" error={errors.confirmPassword?.message}>
              <Input id="confirm-password" type="password" autoComplete="new-password" invalid={!!errors.confirmPassword} {...register('confirmPassword')} />
            </Field>

            {serverError && <Alert>{serverError}</Alert>}

            <div>
              <Button type="submit" variant="primary" disabled={isSubmitting}>
                {isSubmitting ? 'Salvando…' : 'Alterar senha'}
              </Button>
            </div>
          </form>
        )}
      </CardBody>
    </Card>
  );
}

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Configurações" subtitle="Preferências e dados da sua conta." />

      <div className="grid max-w-5xl gap-6">
        <ProfileCard />
        <BillingCard />
        <ChangePasswordCard />
      </div>
    </>
  );
}
