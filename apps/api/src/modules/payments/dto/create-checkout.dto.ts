import { IsIn, IsObject, IsOptional, IsString, IsUUID, Length } from 'class-validator';

/**
 * Everything the customer actually chooses at checkout. Notably absent:
 * price, RAM, CPU, disk, or anything else the backend derives from
 * `planId`/`templateId` under lock (OrdersService.createCheckoutOrder)
 * — the checkout security rule this whole feature is built around.
 *
 * No card-token field since the Asaas migration ("checkout hospedado"
 * decision) — card data is entered on ASAAS'S OWN hosted checkout page
 * (`Order.checkoutUrl`), never tokenized in this platform's frontend at
 * all. `paymentMethod` alone is enough for the backend to create the
 * right kind of Asaas subscription.
 */
export class CreateCheckoutDto {
  @IsUUID()
  planId!: string;

  @IsUUID()
  templateId!: string;

  @IsString()
  @Length(1, 191)
  serverName!: string;

  // Only variables the template marks BOTH isUserViewable and
  // isUserEditable are ever accepted — OrdersService rejects anything
  // else outright (same posture ServerVariablesService.update already
  // takes for a customer editing an existing server's variables).
  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;

  @IsIn(['pix', 'card'])
  paymentMethod!: 'pix' | 'card';
}
