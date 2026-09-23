# Pagamentos — PagBank

O PagBank é um segundo provedor selecionável no checkout. O Mercado Pago
continua disponível; cada `Order` e `Subscription` guarda o provedor escolhido,
e todo o ciclo posterior usa esse mesmo valor.

## Configuração

```env
PAGBANK_TOKEN=
PAGBANK_ENV=production # ou sandbox
PAGBANK_NOTIFICATION_URL=https://api.exemplo.com/api/webhooks/pagbank
```

`PAGBANK_API_BASE_URL` e `PAGBANK_SUBSCRIPTIONS_BASE_URL` só existem para
mocks/CI. Sem `PAGBANK_TOKEN`, a API inicia normalmente e o PagBank não aparece
em `GET /api/public/payment-providers` nem no checkout.

No painel PagBank, cadastre `/api/webhooks/pagbank` também nas preferências de
notificação da API de Pagamentos Recorrentes. A criação do checkout já envia a
mesma URL em `notification_urls` e `payment_notification_urls`.

## Produtos usados

| Método | API PagBank | Renovação |
| --- | --- | --- |
| Pix | `POST /orders`, com `charges.payment_method.type = PIX` | Um novo pedido e QR por ciclo, criado pelo `BillingCycleProcessor` |
| Cartão | `POST /checkouts`, com `recurrence_plan` | O PagBank cria e cobra a assinatura recorrente |

O cartão é sempre preenchido no checkout hospedado do PagBank. Nenhum número,
CVV ou validade passa pela GXHost.

## Webhook e segurança

`POST /api/webhooks/pagbank` preserva o corpo bruto e valida
`x-payload-signature` com ECDSA/SHA-256. A chave pública é consultada em
`GET /public-keys?type=webhook` e mantida em cache por uma hora. Uma notificação
sem assinatura válida é recusada antes de qualquer escrita no banco.

Depois da validação, o controller grava `PaymentWebhookEvent`, enfileira o
evento e responde. O worker consulta novamente a cobrança/assinatura no
PagBank; o corpo do webhook nunca é usado como prova de pagamento.

Eventos de `Order` apontam para a `charge` (`CHAR_...`). Em cartão recorrente,
`subscription.recurrence` consulta a última fatura e seu pagamento (`PAYM_...`)
antes de renovar o período. O primeiro pagamento confirmado ativa a assinatura
e dispara o mesmo provisionamento automático já usado pelo Mercado Pago.

## Cancelamento, estorno e conciliação

- Checkout ainda não concluído (`CHEC_...`): é inativado no PagBank.
- Assinatura recorrente (`SUBS_...`): `PUT /subscriptions/{id}/cancel`.
- Cobrança de Order (`CHAR_...`): `POST /charges/{id}/cancel`.
- Pagamento recorrente (`PAYM_...`): `POST /payments/{id}/refunds`.
- A conciliação diária escolhe o provedor salvo na assinatura e compara o
  estado remoto sem corrigir divergências silenciosamente.

O PagBank exige conta elegível e liberação do produto de recorrência em
produção. Enquanto essas credenciais não estiverem configuradas, apenas os
provedores efetivamente disponíveis são exibidos ao cliente.
