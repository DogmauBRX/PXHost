# Pagamentos — Mercado Pago

> Histórico: esta integração substituiu o Asaas em 2026-09-11, que por sua vez
> havia substituído uma integração anterior com o próprio Mercado Pago em
> 2026-09. Linhas de `orders`/`payments`/`payment_webhook_events` com
> `provider = 'asaas'` continuam no banco como histórico financeiro e **não
> devem ser apagadas** — nenhum código as lê para decidir comportamento.

## 1. Os dois produtos do Mercado Pago usados aqui

O Mercado Pago não tem um produto único que cubra Pix e cartão recorrente.
Por isso o meio de pagamento decide o produto:

| Meio | Produto | Recorrência | O cliente vê |
|---|---|---|---|
| **Pix** | `POST /v1/payments` | **Não existe.** Cada ciclo é uma cobrança nova, gerada por este sistema | QR Code renderizado na própria página |
| **Cartão** | `POST /preapproval` | Sim — o Mercado Pago agenda e cobra sozinho | Redirect para a página do Mercado Pago (`init_point`) |

**O Mercado Pago não tem Pix recorrente.** `/preapproval` é exclusivo de
cartão. Para Pix, quem agenda é o `BillingCycleProcessor` deste projeto:
todo dia ele procura assinaturas Pix cujo período está acabando e cria o
pedido + a cobrança do próximo ciclo
(`OrdersService.createPixRenewalCharge`). É exatamente o que
`Subscription.autoRenew = false` sempre significou aqui.

## 2. Credenciais

Painel do Mercado Pago → **Suas integrações** → (sua aplicação):

- **Credenciais** → `MERCADOPAGO_ACCESS_TOKEN`
  - `TEST-…` = sandbox · `APP_USR-…` = produção
  - **O token É o ambiente.** Não existe URL de sandbox separada, e por isso
    não existe `MERCADOPAGO_ENVIRONMENT` neste projeto — não há como apontar
    credencial de produção para um host de teste por engano.
- **Webhooks** → **Assinatura secreta** → `MERCADOPAGO_WEBHOOK_SECRET`
  - Valor **diferente** do access token. É o que assina as notificações.

Nada disso vai para o frontend. O painel não tem nenhuma variável `VITE_*`
de pagamento: o QR do Pix chega pronto do backend e o cartão é um redirect.

## 3. Variáveis de ambiente

```
MERCADOPAGO_ACCESS_TOKEN=      # TEST-... ou APP_USR-...
MERCADOPAGO_WEBHOOK_SECRET=    # assinatura secreta do webhook
MERCADOPAGO_NOTIFICATION_URL=  # opcional; default ${PUBLIC_SITE_URL}/api/webhooks/mercadopago
MERCADOPAGO_BASE_URL=          # opcional; só para mock em CI
BILLING_GRACE_DAYS=3           # dias entre vencer e suspender
CHECKOUT_ORDER_TTL_MINUTES=1440
```

Todas opcionais: sem elas a aplicação **sobe normalmente** e recusa (503)
só quando alguém tenta fazer checkout. Uma linha vazia (`MERCADOPAGO_ACCESS_TOKEN=`)
conta como não configurada.

Em desenvolvimento a API só é alcançável pelo túnel Cloudflare
(`https://api.gxhost.com.br` → `localhost:3000`), então
`MERCADOPAGO_NOTIFICATION_URL` precisa ser definida explicitamente.

## 4. Webhook

**URL a cadastrar:** `https://<seu-domínio>/api/webhooks/mercadopago`

**Tópicos a assinar:**

| Tópico | Significa | Recurso re-buscado |
|---|---|---|
| `payment` | Cobrança criada/atualizada | `GET /v1/payments/{id}` |
| `subscription_preapproval` | Assinatura de cartão autorizada/cancelada | `GET /preapproval/{id}` |
| `subscription_authorized_payment` | Cobrança recorrente de uma assinatura | `GET /authorized_payments/{id}` |

### Validação de assinatura (`x-signature`)

Toda notificação é verificada **antes de qualquer coisa do corpo ser
usada**. O Mercado Pago envia:

```
x-signature: ts=<timestamp>,v1=<hmac_sha256_hex>
x-request-id: <id>
```

O manifesto assinado é, literalmente:

```
id:<data.id>;request-id:<x-request-id>;ts:<ts>;
```

Duas regras fáceis de errar, ambas implementadas e cobertas por teste
(`mercadopago-signature.spec.ts`):

1. Se `data.id` vier com letras maiúsculas, ele é **minusculado** antes do
   HMAC.
2. Um segmento cujo valor não existe é **removido do manifesto**, não
   deixado vazio.

Comparação em tempo constante (`timingSafeEqual`). Sem
`MERCADOPAGO_WEBHOOK_SECRET` configurado, **toda** notificação é recusada —
uma notificação não verificável nunca é tratada como verdadeira.

### O corpo da notificação nunca é a fonte da verdade

O Mercado Pago só diz `payment.created`/`payment.updated` e manda um id. O
desfecho está no **recurso**, não no aviso. Por isso o serviço sempre
re-busca na API e classifica pelo `status` do recurso:

| Status do pagamento | Evento interno | Efeito |
|---|---|---|
| `approved` | `PaymentConfirmed` | Pedido → `paid`, assinatura ativa/renova, provisiona |
| `pending`, `in_process`, `authorized` | `PaymentPending` | Só registra a cobrança |
| `rejected` | `PaymentFailed` | Pedido → `failed`; se for **renovação**, assinatura → `past_due` |
| `cancelled` | `PaymentCanceled` | Pedido pendente → `cancelled` |
| `refunded` | `PaymentRefunded` | Pedido → `refunded`, assinatura suspensa |
| `charged_back`, `in_mediation` | `PaymentChargeback` | Igual ao reembolso |

| Status da preapproval | Evento interno | Efeito |
|---|---|---|
| `authorized`, `pending` | `SubscriptionSynced` | **Só sincroniza a próxima data.** Nunca marca nada como pago |
| `cancelled`, `paused` | `SubscriptionCanceled` | Assinatura → `cancelled` |

> **Autorizar ≠ pagar.** Uma preapproval `authorized` significa que o
> cliente autorizou cobranças futuras — não que o dinheiro entrou. Só um
> pagamento `approved` ativa assinatura e provisiona servidor.

## 5. Idempotência

Camadas que já existiam e continuam sendo as mesmas — nenhuma foi
duplicada para esta integração:

1. `payment_webhook_events.id` = id da notificação, como **chave primária**.
   A reentrega da mesma notificação bate em violação de unicidade e vira
   200 sem reprocessar.
2. `payments.id` = id do pagamento do Mercado Pago, como **chave primária**.
   `PaymentsService.recordFromGateway` faz `upsert`, então a mesma cobrança
   nunca vira duas linhas — é isso que torna idempotente até a reentrega com
   **id de notificação diferente**.
3. JobIds determinísticos no BullMQ: `webhook-<notificationId>`,
   `provision-<orderId>`.
4. `orders.server_id` é UNIQUE — um pedido nunca provisiona dois servidores.
5. Advisory lock por plano (`CapacityService.lockPlan`) em toda mudança de
   estado.
6. Guardas de estado em `applyPaymentOutcome` (pedido já `paid`/`refunded`
   não é reprocessado) e verificação de valor (`payment.amount_mismatch`
   audita e **não** ativa nada).
7. `X-Idempotency-Key` em todo POST ao Mercado Pago, derivado do
   `orderId` (`order-<id>`) — um checkout repetido não cria segunda cobrança
   do lado deles.

## 6. Fluxo completo

```
cliente escolhe plano
  └─ POST /api/client/checkout  (planId + paymentMethod)
       ├─ valida plano/vagas sob lock, cria Subscription(pending) + Order(pending)  [1 transação]
       └─ fora da transação, cria a cobrança:
            pix   → POST /v1/payments        → grava pixQrCode/pixQrCodeBase64 no pedido
            card  → POST /preapproval        → grava init_point em checkoutUrl
                                               e o preapproval id em externalSubscriptionId
cliente paga
  └─ Mercado Pago → POST /api/webhooks/mercadopago
       ├─ valida x-signature                       (401 antes de persistir qualquer coisa)
       ├─ insere payment_webhook_events (dedupe)   (P2002 = reentrega → 200)
       ├─ enfileira e responde 200                 (nada pesado no caminho HTTP)
       └─ worker: re-busca na API → classifica → aplica
            approved → pedido paid → assinatura active → enfileira provisionamento
                                                          └─ ServersService (setup_pending)
```

O retorno do navegador (`back_url`) é **só UX**. A página de pedido
consulta o status real, que só um webhook muda.

## 7. Inadimplência

1. **Cartão:** cobrança recorrente `rejected` → assinatura `past_due`.
2. **Pix:** a cobrança do ciclo expira sem pagamento → `billing-cycle`
   expira o pedido e move a assinatura para `past_due`. (Não existe evento
   de "vencido" do Mercado Pago para uma cobrança que ele nem agendou.)
3. Passados `BILLING_GRACE_DAYS` em `past_due`, o `billing-cycle` suspende
   a assinatura **e** o servidor, com `suspensionSource = 'billing'`.
4. Pagamento recuperado → assinatura volta a `active` e o servidor é
   reativado — mas **só** se a suspensão tiver sido de cobrança
   (`requireSource: 'billing'`), nunca uma suspensão administrativa por
   abuso.
5. Arquivos do servidor **nunca** são apagados por inadimplência.

## 8. Cancelamento e reembolso

- **Cliente cancela** (`POST /api/client/subscriptions/:id/cancel`):
  cancela primeiro no provedor (`PUT /preapproval/{id}` com
  `status: cancelled`), depois localmente. Um 404 do Mercado Pago conta
  como já cancelado. Uma assinatura Pix não tem preapproval para cancelar —
  basta este sistema parar de gerar a próxima cobrança.
- **Admin reembolsa** (`POST /api/admin/orders/:id/refund`): dispara
  `POST /v1/payments/{id}/refunds` (corpo vazio = total, `{amount}` =
  parcial) e **não** muda estado local. O `refunded` chega pelo mesmo
  webhook de sempre.

## 9. Testando em sandbox

1. `MERCADOPAGO_ACCESS_TOKEN=TEST-…` e o webhook secret da aplicação de teste.
2. Túnel ativo e `MERCADOPAGO_NOTIFICATION_URL` apontando para ele.
3. Cadastrar a URL do webhook e os três tópicos no painel.
4. Checkout Pix: o QR aparece na página; pagar pelo simulador de sandbox.
5. Conferir: pedido vira `paid` **só depois** do webhook; servidor entra em
   `setup_pending`; reenviar a mesma notificação não duplica nada.

## 10. Diagnóstico

| Sintoma | Causa provável |
|---|---|
| 503 no checkout | `MERCADOPAGO_ACCESS_TOKEN` ausente/vazio |
| 401 em toda notificação | `MERCADOPAGO_WEBHOOK_SECRET` errado, ou a URL cadastrada difere da que assina |
| Webhook nunca chega | `notification_url` inalcançável (túnel caído), ou tópico não assinado |
| Pedido fica `pending` para sempre | Webhook não chega — o retorno do navegador nunca muda status por desenho |
| `payment.amount_mismatch` na auditoria | Valor da cobrança ≠ valor do pedido; nada é ativado, de propósito |
