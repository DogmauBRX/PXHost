import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Lock, Mail, MapPin, ShieldCheck, User, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { getPublicPlan } from './public.api';
import { listPublicTemplates } from './templates.api';
import { createCheckoutOrder, getOrder } from '@/shared/api/orders.api';
import { OrderStatusView } from '@/shared/orders/OrderStatusView';
import { register as registerAccount } from '@/features/auth/auth.api';
import { Turnstile, TURNSTILE_SITE_KEY } from '@/features/auth/Turnstile';
import { getAccount, updateAccount } from '@/features/settings/account.api';
import { useAuthStore } from '@/shared/stores/auth.store';
import { Seo } from './Seo';
import { ApiError } from '@/shared/api/client';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, EmptyState, Field, Input, Select, Skeleton } from '@/ui/primitives';
import { formatBillingPeriod, formatPrice } from '@/shared/format/plan';
import { BillingProfileFields, billingSchema, accountToBillingForm, isBillingProfileComplete, type BillingFormValues } from './BillingProfileFields';
import type { Order, PublicTemplate } from '@/shared/api/types';

const accountSchema = z
  .object({
    name: z.string().min(1, 'Informe seu nome'),
    email: z.string().email('Informe um e-mail válido'),
    password: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres'),
    confirmPassword: z.string().min(1, 'Confirme sua senha'),
  })
  .merge(billingSchema)
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

/** A labeled divider between the checkout form's stages (personal info → billing address → account security) — breaks up one long field list into scannable groups. */
function SectionHeading({ icon: Icon, children }: { icon: LucideIcon; children: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 border-t border-border pt-4 first:mt-0 first:border-t-0 first:pt-0">
      <Icon className="h-4 w-4 text-accent-strong" aria-hidden="true" />
      <h2 className="text-sm font-semibold text-text">{children}</h2>
    </div>
  );
}

/**
 * Commercial plan §10's "Escolher plano → Login/Cadastro → Resumo →
 * Checkout" — collapsed into ONE page rather than four screens. A
 * visitor browses the catalog with no account at all, and only enters
 * credentials right here, at the exact moment they commit to a plan.
 * Once account + billing profile are in place, the SAME page shows the
 * "configurar servidor + forma de pagamento" step: the customer picks a
 * template, names the server, and chooses Pix or Cartão.
 *
 * Asaas migration ("checkout hospedado" decision): Pix stays entirely
 * in-page (a QR shown right here, no redirect); card redirects to
 * Asaas's OWN hosted checkout page (`order.checkoutUrl`) to enter card
 * details — this platform's JS never sees a card number/CVV/expiry, and
 * never tokenizes anything itself. Both methods otherwise go through
 * the exact same `createCheckoutOrder` call — `paymentMethod` alone
 * tells the backend which kind of Asaas subscription to create.
 *
 * The plan itself is always fetched fresh from the server (never
 * carried through router state from the plans grid) — price/limits
 * always come from the backend, the same "never trust the frontend for
 * price" doctrine `OrdersService.createCheckoutOrder` enforces
 * server-side (it re-reads the plan under lock regardless of anything
 * this page sends).
 */
export function CheckoutPage({ planSlug }: { planSlug: string }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const setSession = useAuthStore((s) => s.setSession);
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  // This page's own account-creation form hits the same POST /api/auth/
  // register as RegisterForm.tsx, so it needs the same Turnstile token —
  // the button that submits it lives in a SEPARATE card (Block 1, see
  // the `form="checkout-data-form"` comment below), which is why this is
  // lifted to component state instead of living inside the form itself.
  const [captchaToken, setCaptchaToken] = useState('');
  // Safety-net only: the confirm button is already hidden whenever
  // isBillingProfileComplete(account) is false, so this only flips true
  // if the backend rejects a request the frontend thought was complete
  // (e.g. profile edited in another tab in between).
  const [forceBillingForm, setForceBillingForm] = useState(false);

  const [templateId, setTemplateId] = useState('');
  const [serverName, setServerName] = useState('');
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [paymentMethod, setPaymentMethod] = useState<'pix' | 'card'>('pix');
  const [submittingCheckout, setSubmittingCheckout] = useState(false);

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

  const { data: accountData, isLoading: accountLoading } = useQuery({
    queryKey: ['account', 'me'],
    queryFn: getAccount,
    enabled: !!accessToken,
  });

  const { data: templates, isLoading: templatesLoading } = useQuery({
    queryKey: ['public-templates'],
    queryFn: listPublicTemplates,
  });

  const selectedTemplate = templates?.find((t) => t.id === templateId) ?? null;

  // Auto-selects the first template once the catalog loads — most
  // deployments publish just one or a handful, and the customer can
  // still change it; there's no reason to force an extra click when
  // there's an obvious default.
  useEffect(() => {
    if (!templateId && templates && templates.length > 0) {
      setTemplateId(templates[0].id);
    }
  }, [templates, templateId]);

  useEffect(() => {
    if (selectedTemplate) {
      setVariables((prev) => {
        const next: Record<string, string> = {};
        for (const opt of selectedTemplate.options) next[opt.envVariable] = prev[opt.envVariable] ?? opt.defaultValue;
        return next;
      });
    }
  }, [selectedTemplate]);

  // Once an order exists, poll it — the ORDER's own status is the only
  // truth (never the fact that this page rendered a QR code or a
  // checkout-URL button): a webhook, arriving asynchronously, is what
  // actually moves `pending` to `paid`/activates the subscription.
  const { data: polledOrder } = useQuery({
    queryKey: ['order', order?.id],
    queryFn: () => getOrder(order!.id),
    enabled: !!order,
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 3000 : false),
  });
  const currentOrder = polledOrder ?? order;

  const notFound = error instanceof ApiError && error.status === 404;
  const billingComplete = accountData ? isBillingProfileComplete(accountData) : false;

  const {
    register: registerBillingField,
    handleSubmit: handleBillingSubmit,
    formState: { errors: billingErrors, isSubmitting: billingSubmitting },
  } = useForm<BillingFormValues>({ resolver: zodResolver(billingSchema), values: accountData ? accountToBillingForm(accountData) : undefined });

  async function submitBilling(values: BillingFormValues) {
    setSubmitError(null);
    try {
      const updated = await updateAccount(values);
      queryClient.setQueryData(['account', 'me'], updated);
      setForceBillingForm(false);
    } catch (err) {
      setSubmitError(subscribeErrorMessage(err));
    }
  }

  async function createAccountAndContinue(values: AccountFormValues) {
    setSubmitError(null);
    try {
      const res = await registerAccount({
        name: values.name,
        email: values.email,
        password: values.password,
        confirmPassword: values.confirmPassword,
        captchaToken: captchaToken || undefined,
      });
      setSession(res.accessToken, {
        id: res.user.id,
        email: res.user.email,
        username: res.user.username,
        isAdmin: res.user.globalRole !== 'user', // always false — register always creates globalRole: 'user'
      });
      // The account now exists and IS logged in even if what follows
      // fails (billing save, or the plan selling out in the seconds
      // since this page loaded) — never roll that back. The visitor
      // keeps their new account and can retry from the configure step.
      const updated = await updateAccount({
        cpf: values.cpf,
        billingPostalCode: values.billingPostalCode,
        billingAddressLine: values.billingAddressLine,
        billingAddressNumber: values.billingAddressNumber,
        billingAddressComplement: values.billingAddressComplement,
        billingNeighborhood: values.billingNeighborhood,
        billingCity: values.billingCity,
        billingState: values.billingState,
      });
      queryClient.setQueryData(['account', 'me'], updated);
    } catch (err) {
      setSubmitError(subscribeErrorMessage(err));
    }
  }

  function validateConfigure(): string | null {
    if (!templateId) return 'Escolha um software para o servidor.';
    if (!serverName.trim()) return 'Escolha um nome para o servidor.';
    return null;
  }

  // Pix and card go through the exact same call — the only difference
  // is which button the customer clicked. A card checkout comes back
  // with `checkoutUrl` (Asaas's own hosted page) instead of a QR code;
  // `OrderStatusView` is what actually branches on that.
  async function submitCheckout() {
    if (!plan) return;
    const problem = validateConfigure();
    if (problem) {
      setSubmitError(problem);
      return;
    }
    setSubmitError(null);
    setSubmittingCheckout(true);
    try {
      const created = await createCheckoutOrder({ planId: plan.id, templateId, serverName: serverName.trim(), variables, paymentMethod });
      setOrder(created);
    } catch (err) {
      if (err instanceof ApiError && err.message.includes('BILLING_PROFILE_REQUIRED')) {
        setForceBillingForm(true);
      } else {
        setSubmitError(subscribeErrorMessage(err));
      }
    } finally {
      setSubmittingCheckout(false);
    }
  }

  if (currentOrder) {
    return (
      <>
        {currentOrder.status === 'pending' && <Seo title="Confirmando pagamento" description="Acompanhe o status do seu pagamento." />}
        <OrderStatusView order={currentOrder} onRetry={() => setOrder(null)} />
      </>
    );
  }

  const needsBillingForm = accessToken && (!billingComplete || forceBillingForm);
  const readyToConfigure = accessToken && billingComplete && !forceBillingForm;

  return (
    <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6">
      <Seo title="Finalizar assinatura" description="Confirme os dados do seu plano e finalize sua assinatura GXhost." />
      <h1 className="text-xl font-semibold text-text">Resumo da contratação</h1>
      <p className="mt-1 mb-6 text-sm text-text-muted">Confira o plano escolhido e informe seus dados para continuar.</p>

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
        // Side by side from `lg` up (the data card is much taller than the
        // plan card, so a fixed 360px sidebar + `lg:sticky` keeps the
        // plan/price/button in view while scrolling the longer form next
        // to it); stacked on narrower screens, where two columns would
        // squeeze either card too thin to read. The payment block sits on
        // the RIGHT (`lg:order-2` on a first-in-DOM element, `lg:order-1`
        // on the data card right after it) — `order` rather than swapping
        // the JSX around, since the data card's markup is a long
        // per-branch conditional it'd be easy to break moving verbatim.
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px] lg:items-start">
          {/* Block 1 — the plan itself: what's being bought, the price
              that's about to be charged, and (when there's a data form
              next to it) the button that submits it. That form lives in a
              SEPARATE card (Block 2) — the button reaches it via the
              plain HTML `form="checkout-data-form"` attribute rather than
              DOM nesting, which is exactly what lets these be two
              genuinely separate blocks instead of one card split in two
              visually. */}
          <Card className="lg:sticky lg:top-20 lg:order-2">
            <CardHeader>
              <CardTitle className="text-xl">Plano {plan.name}</CardTitle>
            </CardHeader>
            <CardBody className="space-y-4">
              {/* "Detalhes do pagamento" — a highlighted total bar rather than
                  plain text, so the price that's about to be charged reads as
                  the one number on this page that matters most. */}
              <div className="flex items-center justify-between rounded-lg bg-ok-tint px-4 py-3">
                <span className="flex items-center gap-2 text-sm font-medium text-text">
                  <Wallet className="h-4 w-4" aria-hidden="true" />
                  Total {formatBillingPeriod(plan.billingPeriod) === 'mês' ? 'mensal' : `a cada ${formatBillingPeriod(plan.billingPeriod)}`}
                </span>
                <span className="text-xl font-bold text-ok">{formatPrice(plan.priceCents, plan.currency)}</span>
              </div>

              {plan.availability.status === 'sold_out' ? (
                <Alert tone="warn">Esse plano está esgotado no momento. Escolha outro plano na página de planos.</Alert>
              ) : accountLoading ? null : needsBillingForm || !accessToken ? (
                <>
                  {submitError && <Alert>{submitError}</Alert>}
                  <Button
                    type="submit"
                    form="checkout-data-form"
                    variant="primary"
                    disabled={needsBillingForm ? billingSubmitting : isSubmitting || (!!TURNSTILE_SITE_KEY && !captchaToken)}
                    className="w-full"
                  >
                    {needsBillingForm ? (billingSubmitting ? 'Salvando…' : 'Continuar') : isSubmitting ? 'Criando conta…' : 'Continuar'}
                  </Button>
                </>
              ) : null}
            </CardBody>
          </Card>

          {/* Block 2 — the data this step needs, in its own card, on the left. */}
          <div className="lg:order-1">
          {accountLoading ? (
            <Card>
              <CardBody>
                <Skeleton className="mb-3 h-5 w-1/2" />
                <Skeleton className="h-10 w-full" />
              </CardBody>
            </Card>
          ) : plan.availability.status === 'sold_out' ? null : accessToken ? (
            needsBillingForm ? (
              <Card>
                <CardHeader>
                  <CardTitle>Endereço de cobrança</CardTitle>
                </CardHeader>
                <CardBody>
                  <p className="mb-4 text-sm text-text-muted">Complete seus dados de cobrança para assinar.</p>
                  <form id="checkout-data-form" onSubmit={(e) => void handleBillingSubmit(submitBilling)(e)}>
                    <BillingProfileFields register={registerBillingField} errors={billingErrors} />
                  </form>
                </CardBody>
              </Card>
            ) : readyToConfigure ? (
              <Card>
                <CardHeader>
                  <CardTitle>Configurar servidor e pagamento</CardTitle>
                </CardHeader>
                <CardBody>
                  <ConfigureStep
                    templates={templates}
                    templatesLoading={templatesLoading}
                    templateId={templateId}
                    onTemplateChange={setTemplateId}
                    selectedTemplate={selectedTemplate}
                    serverName={serverName}
                    onServerNameChange={setServerName}
                    variables={variables}
                    onVariableChange={(key, value) => setVariables((prev) => ({ ...prev, [key]: value }))}
                    paymentMethod={paymentMethod}
                    onPaymentMethodChange={setPaymentMethod}
                    submitError={submitError}
                    submitting={submittingCheckout}
                    onSubmit={() => void submitCheckout()}
                  />
                </CardBody>
              </Card>
            ) : null
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Seus dados</CardTitle>
              </CardHeader>
              <CardBody>
                <form id="checkout-data-form" onSubmit={(e) => void handleSubmit(createAccountAndContinue)(e)} className="flex flex-col gap-4">
                  <SectionHeading icon={User}>Informação pessoal</SectionHeading>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Nome" htmlFor="checkout-name" error={errors.name?.message}>
                      <Input id="checkout-name" icon={User} autoComplete="name" invalid={!!errors.name} {...registerField('name')} />
                    </Field>
                    <Field label="E-mail" htmlFor="checkout-email" error={errors.email?.message}>
                      <Input id="checkout-email" icon={Mail} type="email" autoComplete="email" invalid={!!errors.email} {...registerField('email')} />
                    </Field>
                  </div>

                  <SectionHeading icon={MapPin}>Endereço de cobrança</SectionHeading>
                  <BillingProfileFields register={registerField} errors={errors} />

                  <SectionHeading icon={ShieldCheck}>Segurança da conta</SectionHeading>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Senha" htmlFor="checkout-password" error={errors.password?.message} hint={!errors.password ? 'Mínimo de 8 caracteres' : undefined}>
                      <Input id="checkout-password" icon={Lock} type="password" autoComplete="new-password" invalid={!!errors.password} {...registerField('password')} />
                    </Field>
                    <Field label="Confirmar senha" htmlFor="checkout-confirm-password" error={errors.confirmPassword?.message}>
                      <Input id="checkout-confirm-password" icon={Lock} type="password" autoComplete="new-password" invalid={!!errors.confirmPassword} {...registerField('confirmPassword')} />
                    </Field>
                  </div>

                  <Turnstile onVerify={setCaptchaToken} />
                </form>
                <Link
                  to="/login"
                  search={{ redirect: `/checkout/${planSlug}` }}
                  className="mt-4 block text-center text-sm text-text-muted transition-colors hover:text-text"
                >
                  Já tem uma conta? <span className="font-medium text-accent-strong">Entrar</span>
                </Link>
              </CardBody>
            </Card>
          )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The last step: server config + payment method. Both Pix and Cartão
 * submit through the SAME button/handler — a card checkout doesn't
 * collect anything here at all; it just creates the order and the next
 * screen (`OrderStatusView`) sends the customer to Asaas's own hosted
 * checkout page to actually enter card details.
 */
function ConfigureStep({
  templates,
  templatesLoading,
  templateId,
  onTemplateChange,
  selectedTemplate,
  serverName,
  onServerNameChange,
  variables,
  onVariableChange,
  paymentMethod,
  onPaymentMethodChange,
  submitError,
  submitting,
  onSubmit,
}: {
  templates: PublicTemplate[] | undefined;
  templatesLoading: boolean;
  templateId: string;
  onTemplateChange: (id: string) => void;
  selectedTemplate: PublicTemplate | null;
  serverName: string;
  onServerNameChange: (v: string) => void;
  variables: Record<string, string>;
  onVariableChange: (key: string, value: string) => void;
  paymentMethod: 'pix' | 'card';
  onPaymentMethodChange: (m: 'pix' | 'card') => void;
  submitError: string | null;
  submitting: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className="space-y-4 border-t border-border pt-4">
      <p className="text-sm font-medium text-text">Configure seu servidor</p>

      {templatesLoading ? (
        <Skeleton className="h-10 w-full" />
      ) : (
        <Field label="Software" htmlFor="checkout-template">
          <Select id="checkout-template" value={templateId} onChange={(e) => onTemplateChange(e.target.value)}>
            {(templates ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.group.name} — {t.name}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <Field label="Nome do servidor" htmlFor="checkout-server-name">
        <Input id="checkout-server-name" value={serverName} onChange={(e) => onServerNameChange(e.target.value)} placeholder="Meu servidor" />
      </Field>

      {selectedTemplate?.options.map((opt) => (
        <Field key={opt.envVariable} label={opt.name} htmlFor={`checkout-var-${opt.envVariable}`} hint={opt.description ?? undefined}>
          {opt.kind === 'choice' ? (
            <Select
              id={`checkout-var-${opt.envVariable}`}
              value={variables[opt.envVariable] ?? ''}
              onChange={(e) => onVariableChange(opt.envVariable, e.target.value)}
            >
              {(opt.choices ?? []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          ) : opt.kind === 'boolean' ? (
            <Select
              id={`checkout-var-${opt.envVariable}`}
              value={variables[opt.envVariable] ?? ''}
              onChange={(e) => onVariableChange(opt.envVariable, e.target.value)}
            >
              <option value="true">Sim</option>
              <option value="false">Não</option>
            </Select>
          ) : (
            <Input
              id={`checkout-var-${opt.envVariable}`}
              type={opt.kind === 'integer' ? 'number' : 'text'}
              min={opt.min}
              max={opt.max}
              value={variables[opt.envVariable] ?? ''}
              onChange={(e) => onVariableChange(opt.envVariable, e.target.value)}
            />
          )}
        </Field>
      ))}

      <div className="border-t border-border pt-4">
        <p className="mb-2 text-sm font-medium text-text">Forma de pagamento</p>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => onPaymentMethodChange('pix')}
            className={`rounded-lg border px-4 py-3 text-sm font-medium transition-colors ${
              paymentMethod === 'pix' ? 'border-accent-strong bg-accent-tint text-accent-strong' : 'border-border text-text-muted hover:text-text'
            }`}
          >
            Pix
          </button>
          <button
            type="button"
            onClick={() => onPaymentMethodChange('card')}
            className={`rounded-lg border px-4 py-3 text-sm font-medium transition-colors ${
              paymentMethod === 'card' ? 'border-accent-strong bg-accent-tint text-accent-strong' : 'border-border text-text-muted hover:text-text'
            }`}
          >
            Cartão
          </button>
        </div>
        <p className="mt-2 text-xs text-text-faint">
          {paymentMethod === 'card'
            ? 'No cartão, a renovação é automática a cada período — o Asaas cobra sozinho, sem precisar escolher de novo. Os dados do cartão são inseridos na página segura do Asaas, nunca aqui.'
            : 'No Pix, você recebe um novo QR Code para pagar a cada período.'}
        </p>
      </div>

      {submitError && <Alert>{submitError}</Alert>}

      <Button type="button" variant="primary" disabled={submitting} onClick={onSubmit} className="w-full">
        {submitting ? 'Gerando cobrança…' : paymentMethod === 'pix' ? 'Gerar Pix' : 'Continuar para pagamento'}
      </Button>
    </div>
  );
}
