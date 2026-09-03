import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2 } from 'lucide-react';
import { getPublicPlan } from './public.api';
import { createSubscription } from '@/features/client/subscriptions.api';
import { register as registerAccount } from '@/features/auth/auth.api';
import { useAuthStore } from '@/shared/stores/auth.store';
import { Seo } from './Seo';
import { ApiError } from '@/shared/api/client';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, EmptyState, Field, Input, Skeleton } from '@/ui/primitives';
import { formatBillingPeriod, formatMemory, formatPrice } from '@/shared/format/plan';

const accountSchema = z
  .object({
    name: z.string().min(1, 'Informe seu nome'),
    email: z.string().email('Informe um e-mail válido'),
    password: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres'),
    confirmPassword: z.string().min(1, 'Confirme sua senha'),
  })
  .refine((v) => v.password === v.confirmPassword, { message: 'As senhas não coincidem', path: ['confirmPassword'] });
type AccountFormValues = z.infer<typeof accountSchema>;

function subscribeErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.message.includes('NO_SLOTS')) {
    return 'Esse plano acabou de esgotar. Escolha outro plano ou tente novamente mais tarde.';
  }
  if (err instanceof ApiError && err.message.includes('PLAN_NOT_SUBSCRIBABLE')) {
    return 'Esse plano não está disponível para contratação no momento.';
  }
  if (err instanceof ApiError && err.status === 404) {
    return 'Esse plano não está mais disponível.';
  }
  return err instanceof ApiError ? err.message : 'Não foi possível concluir sua assinatura. Tente novamente.';
}

/**
 * Commercial plan §10's "Escolher plano → Login/Cadastro → Resumo →
 * Checkout" — collapsed into ONE step rather than four screens. A
 * visitor browses the catalog with no account at all (§3/§4 already
 * guarantee that), and only enters credentials right here, at the exact
 * moment they commit to a plan — never as a gate they have to clear
 * first. An already-authenticated visitor (or one who used the "Já tem
 * conta? Entrar" link below) skips straight to the plain confirm step.
 *
 * The plan itself is always fetched fresh from the server (never
 * carried through router state from the plans grid) — price/limits
 * always come from the backend, the same "never trust the frontend for
 * price" doctrine `SubscriptionsService.createForUser` enforces
 * server-side (it re-reads the plan under lock regardless of anything
 * this page sends). The subscribe call's body is just `{ planId }`.
 */
export function CheckoutPage({ planSlug }: { planSlug: string }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const setSession = useAuthStore((s) => s.setSession);
  const [confirming, setConfirming] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);

  const {
    register: registerField,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<AccountFormValues>({ resolver: zodResolver(accountSchema) });

  const {
    data: plan,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({ queryKey: ['public-plan', planSlug], queryFn: () => getPublicPlan(planSlug) });

  const notFound = error instanceof ApiError && error.status === 404;

  async function confirmForExistingAccount() {
    if (!plan) return;
    setConfirming(true);
    setSubmitError(null);
    try {
      await createSubscription(plan.id);
      setCreated(true);
    } catch (err) {
      setSubmitError(subscribeErrorMessage(err));
    } finally {
      setConfirming(false);
    }
  }

  async function createAccountAndSubscribe(values: AccountFormValues) {
    if (!plan) return;
    setSubmitError(null);
    try {
      const res = await registerAccount(values);
      setSession(res.accessToken, {
        id: res.user.id,
        email: res.user.email,
        username: res.user.username,
        isAdmin: res.user.globalRole !== 'user', // always false — register always creates globalRole: 'user'
      });
      // The account now exists and IS logged in even if the subscribe
      // call below fails (e.g. the plan sold out in the seconds since
      // this page loaded) — never roll that back. The visitor keeps
      // their new account and can pick another plan.
      await createSubscription(plan.id);
      setCreated(true);
    } catch (err) {
      setSubmitError(subscribeErrorMessage(err));
    }
  }

  if (created) {
    return (
      <div className="mx-auto max-w-md px-4 py-20 text-center sm:px-6">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-ok-tint">
          <CheckCircle2 className="h-7 w-7 text-ok" />
        </div>
        <h1 className="text-xl font-semibold text-text">Assinatura criada!</h1>
        <p className="mt-2 text-sm text-text-muted">
          Sua assinatura está <strong>pendente</strong> de confirmação. Assim que for aprovada, seu servidor será preparado pela nossa equipe.
        </p>
        <Link to="/client/subscription" className="mt-6 block">
          <Button variant="primary" className="w-full">
            Ver minha assinatura
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-4 py-14 sm:px-6">
      <Seo title="Finalizar assinatura" description="Confirme os dados do seu plano e finalize sua assinatura PXHost." />
      <h1 className="mb-6 text-xl font-semibold text-text">Resumo da contratação</h1>

      {isLoading ? (
        <Card>
          <CardBody>
            <Skeleton className="mb-3 h-5 w-1/2" />
            <Skeleton className="mb-2 h-4 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardBody>
        </Card>
      ) : notFound ? (
        <EmptyState title="Plano não encontrado" description="Esse plano pode ter sido removido. Volte à página de planos para escolher outro." />
      ) : isError ? (
        <Alert tone="fail" title="Não foi possível carregar este plano">
          <button type="button" onClick={() => void refetch()} className="mt-1 font-medium underline underline-offset-2">
            Tentar novamente
          </button>
        </Alert>
      ) : plan ? (
        <Card>
          <CardHeader>
            <CardTitle>{plan.name}</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            <p>
              <span className="text-2xl font-bold text-text">{formatPrice(plan.priceCents, plan.currency)}</span>
              <span className="text-sm text-text-faint"> /{formatBillingPeriod(plan.billingPeriod)}</span>
            </p>
            <ul className="space-y-1 text-sm text-text-muted">
              <li>{formatMemory(plan.memoryMb)} de RAM</li>
              <li>{plan.cpuLimitPercent}% de CPU</li>
              <li>{formatMemory(plan.diskMb)} de armazenamento</li>
            </ul>

            {plan.availability.status === 'sold_out' ? (
              <Alert tone="warn">Esse plano está esgotado no momento. Escolha outro plano na página de planos.</Alert>
            ) : accessToken ? (
              <>
                {submitError && <Alert>{submitError}</Alert>}
                <Button variant="primary" disabled={confirming} onClick={() => void confirmForExistingAccount()} className="w-full">
                  {confirming ? 'Confirmando…' : 'Confirmar assinatura'}
                </Button>
                <p className="text-xs text-text-faint">
                  Sua assinatura ficará pendente até a confirmação do pagamento. Nenhuma cobrança é feita nesta etapa.
                </p>
              </>
            ) : (
              <div className="space-y-4 border-t border-border pt-4">
                <p className="text-sm font-medium text-text">Crie sua conta para assinar</p>
                <form onSubmit={(e) => void handleSubmit(createAccountAndSubscribe)(e)} className="flex flex-col gap-4">
                  <Field label="Nome" htmlFor="checkout-name" error={errors.name?.message}>
                    <Input id="checkout-name" autoComplete="name" invalid={!!errors.name} {...registerField('name')} />
                  </Field>
                  <Field label="E-mail" htmlFor="checkout-email" error={errors.email?.message}>
                    <Input id="checkout-email" type="email" autoComplete="email" invalid={!!errors.email} {...registerField('email')} />
                  </Field>
                  <Field label="Senha" htmlFor="checkout-password" error={errors.password?.message} hint={!errors.password ? 'Mínimo de 8 caracteres' : undefined}>
                    <Input id="checkout-password" type="password" autoComplete="new-password" invalid={!!errors.password} {...registerField('password')} />
                  </Field>
                  <Field label="Confirmar senha" htmlFor="checkout-confirm-password" error={errors.confirmPassword?.message}>
                    <Input id="checkout-confirm-password" type="password" autoComplete="new-password" invalid={!!errors.confirmPassword} {...registerField('confirmPassword')} />
                  </Field>

                  {submitError && <Alert>{submitError}</Alert>}

                  <Button type="submit" variant="primary" disabled={isSubmitting} className="w-full">
                    {isSubmitting ? 'Criando conta e assinando…' : 'Criar conta e assinar'}
                  </Button>
                  <p className="text-xs text-text-faint">
                    Sua assinatura ficará pendente até a confirmação do pagamento. Nenhuma cobrança é feita nesta etapa.
                  </p>
                </form>
                <Link
                  to="/login"
                  search={{ redirect: `/checkout/${planSlug}` }}
                  className="block text-center text-sm text-text-muted transition-colors hover:text-text"
                >
                  Já tem uma conta? <span className="font-medium text-accent-strong">Entrar</span>
                </Link>
              </div>
            )}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
