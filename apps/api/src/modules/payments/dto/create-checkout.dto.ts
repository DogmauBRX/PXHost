import { IsEmail, IsIn, IsOptional, IsUUID } from 'class-validator';

/**
 * Everything the customer actually chooses at checkout. Notably absent:
 * price, RAM, CPU, disk, or anything else the backend derives from
 * `planId` under lock (OrdersService.createCheckoutOrder) — the
 * checkout security rule this whole feature is built around.
 *
 * Also notably absent as of the post-purchase setup flow: `templateId`,
 * `serverName`, `variables` — the customer no longer picks software at
 * checkout at all. Every paid order provisions a bare, 'setup_pending'
 * server (ServersService.createSetupPending); the customer chooses
 * name/software/version afterward, in the panel, via
 * ServerSetupService.complete. See OrderConfigSnapshot's own doc comment
 * for why those fields still exist there (optional) even though nothing
 * here collects them anymore.
 *
 * No card-token field: card data is entered on MERCADO PAGO'S OWN hosted
 * page (`Order.checkoutUrl`, their `init_point`), never tokenized in
 * this platform's frontend at all. `paymentMethod` alone is enough for
 * the backend to pick the right Mercado Pago product — a one-off pix
 * charge (`POST /v1/payments`) or a recurring card preapproval
 * (`POST /preapproval`).
 */
export class CreateCheckoutDto {
  @IsUUID()
  planId!: string;

  @IsIn(['pix', 'boleto', 'card'])
  paymentMethod!: 'pix' | 'boleto' | 'card';

  @IsOptional()
  @IsIn(['mercadopago', 'pagbank'])
  provider?: 'mercadopago' | 'pagbank';

  // Deliberately distinct from the GXHost account e-mail. This is sent
  // only to Mercado Pago as the payer for this checkout; ownership is
  // always derived from the authenticated user on the server.
  @IsOptional()
  @IsEmail()
  payerEmail?: string;
}
