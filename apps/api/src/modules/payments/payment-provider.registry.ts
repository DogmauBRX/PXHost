import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PAYMENT_PROVIDER, type PaymentProvider, type PaymentProviderName } from './payment-provider.interface';
import { PagBankProvider } from './pagbank.provider';

@Injectable()
export class PaymentProviderRegistry {
  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly mercadoPago: PaymentProvider,
    private readonly pagBank: PagBankProvider,
  ) {}

  get(name: PaymentProviderName | string | null | undefined): PaymentProvider {
    if (!name || name === 'mercadopago') return this.mercadoPago;
    if (name === 'pagbank') return this.pagBank;
    throw new BadRequestException(`PAYMENT_PROVIDER_UNSUPPORTED: ${name}`);
  }

  available(): PaymentProviderName[] {
    const providers: Array<[PaymentProviderName, PaymentProvider]> = [
      ['mercadopago', this.mercadoPago],
      ['pagbank', this.pagBank],
    ];
    return providers.filter(([, provider]) => provider.isConfigured?.() !== false).map(([name]) => name);
  }
}
