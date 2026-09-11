import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, Copy, ExternalLink } from 'lucide-react';
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

  if (order.status === 'paid') {
    return (
      <div className="mx-auto max-w-md px-4 py-20 text-center sm:px-6">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-ok-tint">
          <CheckCircle2 className="h-7 w-7 text-ok" />
        </div>
        <h1 className="text-xl font-semibold text-text">Pagamento confirmado!</h1>
        <p className="mt-2 text-sm text-text-muted">Seu servidor está sendo preparado. Isso costuma levar só alguns instantes.</p>
        <Link to="/client/subscription" className="mt-6 block">
          <Button variant="primary" className="w-full">
            Ver minha assinatura
          </Button>
        </Link>
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
    <div className="mx-auto max-w-md px-4 py-14 sm:px-6 text-center">
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
      ) : order.checkoutUrl ? (
        <Card>
          <CardHeader>
            <CardTitle>Finalize seu pagamento</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            <p className="text-sm text-text-muted">
              Você será redirecionado para a página segura do Mercado Pago para autorizar a cobrança no cartão — os dados do cartão nunca passam pelo nosso site.
            </p>
            <Button
              type="button"
              variant="primary"
              onClick={() => window.location.assign(order.checkoutUrl!)}
              className="w-full gap-2"
            >
              <ExternalLink className="h-4 w-4" />
              Ir para o pagamento
            </Button>
            <p className="text-sm text-text-muted">Depois de pagar, você pode voltar para esta página — ela atualiza sozinha assim que a confirmação chegar.</p>
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
