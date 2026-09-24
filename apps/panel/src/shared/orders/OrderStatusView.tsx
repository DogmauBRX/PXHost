import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Barcode, CheckCircle2, Copy, ExternalLink, ShieldCheck } from 'lucide-react';
import type { Order } from '@/shared/api/types';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle } from '@/ui/primitives';

/**
 * What the customer sees for a given Order — polled from
 * `GET /api/client/orders/:id` (never assumes payment succeeded just
 * because this rendered; only the order's own `status`, set by the
 * webhook, decides). Pix shows the QR code synchronously returned at
 * creation, in-page; card shows a link out to Mercado Pago's OWN hosted
 * checkout (`order.checkoutUrl`, "checkout hospedado" decision — card
 * data is entered THERE, never on this platform), and keeps polling in
 * the background so this page updates on its own whether the customer
 * pays in a new tab or comes back to this one.
 *
 * Shared between the checkout flow (`CheckoutPage`, right after an
 * order is created) and `OrderPage` (the client area's "get back to a
 * payment I left mid-flow" route) — both just poll the same order and
 * render whatever state it's in. Deliberately renders no `<Seo>`: the
 * public checkout call site owns that (authenticated panel routes never
 * set page SEO — see `Seo.tsx`'s own doc comment), so it's added at
 * that call site instead of baked in here.
 */
export function OrderStatusView({ order, onRetry }: { order: Order; onRetry: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copyPixCode() {
    if (!order.pixQrCode) return;
    try {
      await navigator.clipboard.writeText(order.pixQrCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail (permissions, insecure context) — the
      // code is still visible on screen for a manual copy either way.
    }
  }

  async function copyBoletoCode() {
    if (!order.boletoDigitableLine) return;
    try {
      await navigator.clipboard.writeText(order.boletoDigitableLine);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The line remains visible for manual copying.
    }
  }

  if (order.status === 'paid') {
    return (
      <div className="mx-auto max-w-md px-4 py-20 text-center sm:px-6">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-ok-tint">
          <CheckCircle2 className="h-7 w-7 text-ok" />
        </div>
        <h1 className="text-xl font-semibold text-text">Pagamento confirmado!</h1>
        <p className="mt-2 text-sm text-text-muted">
          {order.serverId ? 'Seu servidor já está reservado — falta só escolher o software e a versão.' : 'Seu servidor está sendo preparado. Isso costuma levar só alguns instantes.'}
        </p>
        {/* `order.serverId` is set the instant provisioning finishes
            (ProvisioningService.provisionOrder) — almost always true by
            the time a customer's polling actually lands here, since
            reservation has no agent round-trip to wait on (see
            ServersService.createSetupPending's own doc comment). Two
            separate <Link> elements, not one computed `to`/`params` pair
            — the router's route-param typing is tied to the literal `to`
            string at the call site, not to a value assembled at runtime. */}
        {order.serverId ? (
          <Link to="/client/servers/$serverId" params={{ serverId: order.serverId }} className="mt-6 block">
            <Button variant="primary" className="w-full">
              Configurar servidor
            </Button>
          </Link>
        ) : (
          <Link to="/client/subscription" className="mt-6 block">
            <Button variant="primary" className="w-full">
              Ver minha assinatura
            </Button>
          </Link>
        )}
      </div>
    );
  }

  if (order.status === 'failed' || order.status === 'cancelled' || order.status === 'expired') {
    return (
      <div className="mx-auto max-w-md px-4 py-20 sm:px-6">
        <Alert tone="fail" title="Não foi possível confirmar o pagamento">
          {order.status === 'expired'
            ? 'O prazo para pagar este pedido expirou.'
            : order.paymentMethod === 'card'
              ? 'O cartão foi recusado pela operadora. Tente novamente com outro cartão.'
              : 'O pagamento não foi confirmado.'}
        </Alert>
        <Button type="button" variant="secondary" onClick={onRetry} className="mt-6 w-full">
          Tentar novamente
        </Button>
      </div>
    );
  }

  // 'pending' — the only branch where a customer still has something to
  // DO (pay the Pix) or wait for (the card's authorization webhook).
  return (
    <div className="mx-auto max-w-xl px-4 py-14 text-center sm:px-6">
      {order.paymentMethod === 'pix' && order.pixQrCodeBase64 ? (
        <Card>
          <CardHeader>
            <CardTitle>Pague com Pix</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            <img
              src={`data:image/png;base64,${order.pixQrCodeBase64}`}
              alt="QR Code Pix"
              className="mx-auto h-56 w-56 rounded-lg border border-border"
            />
            {order.pixQrCode && (
              <Button type="button" variant="secondary" onClick={() => void copyPixCode()} className="w-full gap-2">
                <Copy className="h-4 w-4" />
                {copied ? 'Código copiado!' : 'Copiar código Pix'}
              </Button>
            )}
            <p className="text-sm text-text-muted">Estamos aguardando a confirmação do seu banco. Esta página atualiza automaticamente.</p>
          </CardBody>
        </Card>
      ) : order.paymentMethod === 'boleto' && order.boletoUrl ? (
        <Card>
          <CardHeader>
            <CardTitle>Pague com boleto</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-2xl border border-accent/20 bg-accent-tint">
              <Barcode className="h-10 w-10 text-accent-strong" aria-hidden="true" />
            </div>
            {order.boletoDigitableLine && (
              <>
                <p className="break-all rounded-xl border border-border bg-surface-2 px-3 py-3 font-mono text-xs text-text">
                  {order.boletoDigitableLine}
                </p>
                <Button type="button" variant="secondary" onClick={() => void copyBoletoCode()} className="w-full gap-2">
                  <Copy className="h-4 w-4" />
                  {copied ? 'Linha copiada!' : 'Copiar linha digitável'}
                </Button>
              </>
            )}
            <Button type="button" variant="primary" onClick={() => window.location.assign(order.boletoUrl!)} className="w-full gap-2">
              <ExternalLink className="h-4 w-4" />
              Abrir boleto
            </Button>
            <p className="text-sm text-text-muted">
              O pagamento será confirmado após a compensação bancária. Esta página atualiza automaticamente.
            </p>
          </CardBody>
        </Card>
      ) : order.checkoutUrl ? (
        <Card className="overflow-hidden border-accent/35 bg-gradient-to-b from-surface to-surface-2/45 text-left shadow-[0_24px_70px_-38px_var(--color-accent)]">
          <div className="h-1 bg-gradient-to-r from-accent/35 via-accent to-accent/35" />
          <CardHeader className="justify-start gap-4 bg-accent/[0.055] px-6 py-5 sm:px-7">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-accent/25 bg-accent-tint text-accent-strong shadow-sm">
              <ShieldCheck className="h-6 w-6" aria-hidden="true" />
            </div>
            <div>
              <p className="text-xs font-semibold tracking-[0.14em] text-accent-strong uppercase">Ambiente seguro</p>
              <CardTitle className="mt-1 text-xl sm:text-2xl">Finalize seu pagamento</CardTitle>
            </div>
          </CardHeader>
          <CardBody className="space-y-5 px-6 py-6 sm:px-7 sm:py-7">
            <p className="text-base leading-7 text-text sm:text-lg sm:leading-8">
              Você será redirecionado para a página segura do{' '}
              <strong className="font-semibold text-accent-strong">{order.provider === 'pagbank' ? 'PagBank' : 'Mercado Pago'}</strong>{' '}
              para autorizar a cobrança no cartão.
            </p>
            <div className="flex items-start gap-3 rounded-xl border border-ok/20 bg-ok/[0.075] px-4 py-3.5">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-ok" aria-hidden="true" />
              <p className="text-sm leading-6 text-text-muted">
                Seus dados do cartão são preenchidos diretamente no provedor e nunca passam pelo site da GXHost.
              </p>
            </div>
            <Button
              type="button"
              variant="primary"
              onClick={() => window.location.assign(order.checkoutUrl!)}
              className="h-12 w-full rounded-xl text-base shadow-[0_14px_28px_-16px_var(--color-accent)]"
            >
              <ExternalLink className="h-4 w-4" />
              Ir para o pagamento
            </Button>
            <p className="rounded-xl border border-border bg-surface-2/70 px-4 py-3 text-center text-sm leading-6 text-text-muted">
              Depois de pagar, volte para esta página. A confirmação aparecerá automaticamente assim que o provedor processar o pagamento.
            </p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Confirmando pagamento…</CardTitle>
          </CardHeader>
          <CardBody>
            <p className="text-sm text-text-muted">Estamos aguardando a confirmação do seu pagamento. Isso costuma levar só alguns instantes.</p>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
