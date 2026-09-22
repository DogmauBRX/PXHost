import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Lock, Mail, MapPin, ShieldCheck, User, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { getPublicPlan } from './public.api';
import { createCheckoutOrder, getOrder } from '@/shared/api/orders.api';
import { OrderStatusView } from '@/shared/orders/OrderStatusView';
import { register as registerAccount } from '@/features/auth/auth.api';
import { Turnstile, TURNSTILE_SITE_KEY } from '@/features/auth/Turnstile';
import { getAccount, updateAccount } from '@/features/settings/account.api';
import { useAuthStore } from '@/shared/stores/auth.store';
import { Seo } from './Seo';
import { ApiError } from '@/shared/api/client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, CardTitle, EmptyState, Field, Input, Skeleton } from '@/ui/primitives';
import { formatBillingPeriod, formatMemory, formatPrice, formatRange, formatVcpu } from '@/shared/format/plan';
import { BillingProfileFields, billingSchema, accountToBillingForm, isBillingProfileComplete, type BillingFormValues } from './BillingProfileFields';
import type { Order, PublicPlan } from '@/shared/api/types';

// Nominal cycle names for the "① Plano e cobrança" switcher — distinct
// from `formatBillingPeriod`'s "/mês" suffix form, same closed
// vocabulary as `plans_billing_period_check` on the API side.
const CYCLE_NAMES: Record<string, string> = {
  monthly: 'Mensal',
  quarterly: 'Trimestral',
  semiannual: 'Semestral',
  annual: 'Anual',
};

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
 * "forma de pagamento" step — that's the checkout's entire remaining
 * job. Software/version/server name are deliberately NOT collected here
 * (post-purchase setup flow): every paid order provisions a bare,
 * 'setup_pending' server, and the customer configures it afterward in
 * the panel (features/servers/ServerSetupPage.tsx) — see
 * CreateCheckoutDto's own doc comment for why.
 *
 * Mercado Pago, one flow per method: Pix stays entirely in-page (the QR
 * comes back from the backend with the order, no redirect); card
 * redirects to Mercado Pago's OWN hosted page (`order.checkoutUrl`,
 * their `init_point`) to authorize the recurring charge — this
 * platform's JS never sees a card number/CVV/expiry, and never
 * tokenizes anything itself. Both methods otherwise go through the
 * exact same `createCheckoutOrder` call; `paymentMethod` alone tells
 * the backend which Mercado Pago product to use.
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

  const [paymentMethod, setPaymentMethod] = useState<'pix' | 'card'>('pix');
  const [payerEmail, setPayerEmail] = useState('');
  const [submittingCheckout, setSubmittingCheckout] = useState(false);
  // Checkout redesign (WHMCS-style) — which billing-cycle SIBLING of the
  // route's plan is actually selected. Switching cycles never navigates
  // (a typed server name must survive it), so this lives here, not in
  // the URL. '' means "not decided yet" (still loading, or the route's
  // planSlug just changed) — the effect below picks a default the moment
  // `plan` is available.
  const [selectedPlanId, setSelectedPlanId] = useState('');

  const {
    register: registerField,
    handleSubmit,
    setValue: setAccountValue,
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

  // Checkout redesign — every public cycle of the route's plan family
  // (itself included), backend-computed and backend-ordered
  // (PublicPlansService.getBySlug). No family/siblings still means an
  // array of one: the switcher always has something to render.
  const familyCycles: PublicPlan[] = plan?.familyCycles ?? (plan ? [plan] : []);
  const selectedPlan = familyCycles.find((p) => p.id === selectedPlanId) ?? plan;
  // Gates on the WHOLE family, not just the route's own slug — a visitor
  // landing on a sold-out quarterly cycle must still be able to switch to
  // an available monthly sibling instead of hitting a dead end.
  const allCyclesSoldOut = familyCycles.length > 0 && familyCycles.every((p) => p.availability.status === 'sold_out');

  // planSlug changing (a fresh `/checkout/:slug` navigation) invalidates
  // any previously chosen cycle — it belongs to the OLD family.
  useEffect(() => {
    setSelectedPlanId('');
  }, [planSlug]);

  // Defaults to the route's own plan, unless IT is sold out and a
  // sibling cycle isn't — never auto-select a cycle the customer
  // couldn't actually check out with.
  useEffect(() => {
    if (!plan || selectedPlanId) return;
    const preferred = familyCycles.find((p) => p.id === plan.id) ?? familyCycles[0];
    const fallback = familyCycles.find((p) => p.availability.status !== 'sold_out');
    setSelectedPlanId((preferred?.availability.status !== 'sold_out' ? preferred : fallback ?? preferred)?.id ?? plan.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, selectedPlanId]);

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

  // The Mercado Pago payer is a checkout-specific identity. Prefill it
  // from the GXHost login only as a convenience; the customer may replace
  // it with the account that will actually authorize/pay the charge.
  useEffect(() => {
    if (accountData?.email) setPayerEmail((current) => current || accountData.email);
  }, [accountData?.email]);

  const {
    register: registerBillingField,
    handleSubmit: handleBillingSubmit,
    setValue: setBillingValue,
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

  // Pix and card go through the exact same call — the only difference
  // is which button the customer clicked. A card checkout comes back
  // with `checkoutUrl` (Mercado Pago's own hosted page) instead of a QR code;
  // `OrderStatusView` is what actually branches on that.
  async function submitCheckout() {
    if (!plan) return;
    setSubmitError(null);
    setSubmittingCheckout(true);
    try {
      // The SELECTED cycle's id, never the route's — this is the one
      // place a bug here would turn into wrong billing (a customer
      // switches to Trimestral in section ①, the order must be created
      // against THAT plan, not `basico`'s own id from the URL).
      const normalizedPayerEmail = payerEmail.trim();
      if (!normalizedPayerEmail) {
        setSubmitError('Informe o e-mail da conta que fará o pagamento no Mercado Pago.');
        return;
      }
      const created = await createCheckoutOrder({ planId: (selectedPlan ?? plan).id, paymentMethod, payerEmail: normalizedPayerEmail });
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
          <div className="space-y-4 lg:sticky lg:top-20 lg:order-2">
            {readyToConfigure && selectedPlan && !allCyclesSoldOut && (
              // Read-only plan specs, moved out of Block 2's numbered
              // sequence and into their own card here — right above the
              // order summary, so the customer sees what they're getting
              // right next to what they're paying, instead of scrolling
              // back up through the longer configuration form for it.
              <Card>
                <CardHeader>
                  <CardTitle>Recursos do plano</CardTitle>
                </CardHeader>
                <CardBody>
                  <PlanSpecCards plan={selectedPlan} />
                </CardBody>
              </Card>
            )}

            <Card>
              {readyToConfigure && selectedPlan && !allCyclesSoldOut ? (
                // Once the customer reaches "configurar servidor", this card
                // stops being a plain total bar and becomes the itemized
                // resumo (checkout redesign) — everything chosen in Block 2
                // reflected line by line, with the submit button at its own
                // footer (moved from ConfigureStep, same handler/state).
                <CardBody>
                  <OrderSummary
                    plan={selectedPlan}
                    paymentMethod={paymentMethod}
                    submitError={submitError}
                    submitting={submittingCheckout}
                    onSubmit={() => void submitCheckout()}
                  />
                </CardBody>
              ) : (
                <>
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

                    {allCyclesSoldOut ? (
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
                </>
              )}
            </Card>
          </div>

          {/* Block 2 — the data this step needs, in its own card, on the left. */}
          <div className="lg:order-1">
          {accountLoading ? (
            <Card>
              <CardBody>
                <Skeleton className="mb-3 h-5 w-1/2" />
                <Skeleton className="h-10 w-full" />
              </CardBody>
            </Card>
          ) : allCyclesSoldOut ? null : accessToken ? (
            needsBillingForm ? (
              <Card>
                <CardHeader>
                  <CardTitle>Endereço de cobrança</CardTitle>
                </CardHeader>
                <CardBody>
                  <p className="mb-4 text-sm text-text-muted">Complete seus dados de cobrança para assinar.</p>
                  <form id="checkout-data-form" onSubmit={(e) => void handleBillingSubmit(submitBilling)(e)}>
                    <BillingProfileFields register={registerBillingField} errors={billingErrors} setValue={setBillingValue} />
                  </form>
                </CardBody>
              </Card>
            ) : readyToConfigure ? (
              <Card>
                <CardHeader>
                  <CardTitle>Plano e pagamento</CardTitle>
                </CardHeader>
                <CardBody>
                  {selectedPlan && (
                    <ConfigureStep
                      familyCycles={familyCycles}
                      selectedPlanId={selectedPlanId}
                      onPlanChange={setSelectedPlanId}
                      paymentMethod={paymentMethod}
                      onPaymentMethodChange={setPaymentMethod}
                      payerEmail={payerEmail}
                      onPayerEmailChange={setPayerEmail}
                    />
                  )}
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
                  <BillingProfileFields register={registerField} errors={errors} setValue={setAccountValue} />

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

/** A numbered section header — same visual language as `SectionHeading` above (icon + border-top divider), but with the mockup's circled step number instead of an icon, since `ConfigureStep`'s three blocks are meant to read as an ordered sequence. */
function NumberedSection({ step, children }: { step: number; children: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 border-t border-border pt-4 first:mt-0 first:border-t-0 first:pt-0">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-tint text-xs font-bold text-accent-strong">{step}</span>
      <h2 className="text-sm font-semibold text-text">{children}</h2>
    </div>
  );
}

/** One billing-cycle card in "① Plano e cobrança". Disabled + badged when THAT cycle is sold out — never removed from the grid, so the customer always sees every cycle this product is sold in. */
function CycleOption({ plan, selected, onSelect }: { plan: PublicPlan; selected: boolean; onSelect: () => void }) {
  const soldOut = plan.availability.status === 'sold_out';
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={soldOut}
      className={`rounded-lg border px-4 py-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        selected ? 'border-accent-strong bg-accent-tint text-accent-strong' : 'border-border text-text-muted hover:text-text'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{CYCLE_NAMES[plan.billingPeriod] ?? plan.billingPeriod}</span>
        {soldOut && <Badge tone="fail">Esgotado</Badge>}
      </div>
      <p className="mt-0.5 text-xs">
        {formatPrice(plan.priceCents, plan.currency)} /{formatBillingPeriod(plan.billingPeriod)}
      </p>
    </button>
  );
}

/** Read-only spec cards for "③ Recursos do plano" — every field this plan actually publishes; never renders a row for a null recommendation (Plan's own "no fake 0-0" rule, see `formatRange`). */
function PlanSpecCards({ plan }: { plan: PublicPlan }) {
  const players = formatRange(plan.recommendedPlayersMin, plan.recommendedPlayersMax);

  const specs: { label: string; value: string }[] = [
    { label: 'Memória RAM', value: formatMemory(plan.memoryMb) },
    { label: 'Armazenamento', value: formatMemory(plan.diskMb) },
    { label: 'CPU', value: formatVcpu(plan.cpuLimitPercent) },
  ];
  if (plan.maxBackups > 0) specs.push({ label: 'Backups', value: `até ${plan.maxBackups}` });
  if (plan.maxDatabases > 0) specs.push({ label: 'Bancos de dados', value: `até ${plan.maxDatabases}` });
  if (players) specs.push({ label: 'Jogadores recomendados', value: players });

  return (
    // Fixed at 2 columns regardless of viewport — this renders inside the
    // ~360px sidebar card now (moved there from the wide main column), so
    // `sm:grid-cols-3` (a VIEWPORT breakpoint, not a container one) used
    // to force 3 columns into that narrow card and crush labels like
    // "Jogadores recomendados" into a 2-3 word wrap that read as text
    // spilling out of the box.
    <div className="grid grid-cols-2 gap-3">
      {specs.map((s) => (
        <div key={s.label} className="rounded-lg bg-ok-tint px-3 py-2">
          <p className="text-xs leading-snug text-text-muted">{s.label}</p>
          <p className="text-sm font-semibold text-text">{s.value}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * The last step: billing cycle + payment method. Software/version/
 * server name are no longer collected at checkout at all (post-purchase
 * setup flow — see CheckoutPage's own doc comment); this component's
 * only remaining job is the two things that actually ARE purchase
 * decisions. The actual submit button lives in the sidebar
 * (`OrderSummary`, CheckoutPage's Block 1) — this component only
 * collects input.
 */
function ConfigureStep({
  familyCycles,
  selectedPlanId,
  onPlanChange,
  paymentMethod,
  onPaymentMethodChange,
  payerEmail,
  onPayerEmailChange,
}: {
  familyCycles: PublicPlan[];
  selectedPlanId: string;
  onPlanChange: (id: string) => void;
  paymentMethod: 'pix' | 'card';
  onPaymentMethodChange: (m: 'pix' | 'card') => void;
  payerEmail: string;
  onPayerEmailChange: (email: string) => void;
}) {
  return (
    <div className="space-y-4">
      <NumberedSection step={1}>Plano e cobrança</NumberedSection>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {familyCycles.map((p) => (
          <CycleOption key={p.id} plan={p} selected={p.id === selectedPlanId} onSelect={() => onPlanChange(p.id)} />
        ))}
      </div>

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
            ? 'No cartão, a renovação é automática a cada período — o Mercado Pago cobra sozinho, sem precisar fazer nada. Os dados do cartão são inseridos na página segura do Mercado Pago, nunca aqui.'
            : 'No Pix não existe cobrança automática: a cada período geramos um novo QR Code e avisamos você para pagar.'}
        </p>
      </div>

      <div className="border-t border-border pt-4">
        <Field
          label="E-mail do pagador no Mercado Pago"
          htmlFor="checkout-payer-email"
          hint="Pode ser diferente do e-mail da sua conta GXHost"
        >
          <Input
            id="checkout-payer-email"
            type="email"
            autoComplete="email"
            value={payerEmail}
            onChange={(event) => onPayerEmailChange(event.target.value)}
            icon={Mail}
            placeholder="pagador@exemplo.com"
          />
        </Field>
      </div>
    </div>
  );
}

/**
 * The sidebar's itemized "RESUMO DO PEDIDO" (checkout redesign) —
 * CheckoutPage's Block 1 once `readyToConfigure`. Everything here is
 * derived from state `ConfigureStep` already owns (no new API call);
 * the submit button is the SAME handler `ConfigureStep`'s old Pix/
 * Cartão button used to call, just relocated to this card's footer.
 */
function OrderSummary({
  plan,
  paymentMethod,
  submitError,
  submitting,
  onSubmit,
}: {
  plan: PublicPlan;
  paymentMethod: 'pix' | 'card';
  submitError: string | null;
  submitting: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-semibold tracking-wide text-text-faint uppercase">Resumo do pedido</p>
        <p className="mt-1 text-sm font-medium text-text">Plano {plan.name}</p>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-text-muted">Subtotal</span>
        <span className="font-medium text-text">{formatPrice(plan.priceCents, plan.currency)}</span>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-3 text-sm">
        <span className="text-text-muted">por {formatBillingPeriod(plan.billingPeriod)}</span>
        <span className="font-semibold text-text">{formatPrice(plan.priceCents, plan.currency)}</span>
      </div>

      <div className="flex items-center justify-between rounded-lg bg-ok-tint px-4 py-3">
        <span className="text-sm font-medium text-text">Pagamento hoje</span>
        <span className="text-xl font-bold text-ok">{formatPrice(plan.priceCents, plan.currency)}</span>
      </div>

      {submitError && <Alert>{submitError}</Alert>}

      <Button type="button" variant="primary" disabled={submitting} onClick={onSubmit} className="w-full">
        {submitting ? 'Gerando cobrança…' : paymentMethod === 'pix' ? 'Gerar Pix' : 'Continuar para pagamento'}
      </Button>
    </div>
  );
}
