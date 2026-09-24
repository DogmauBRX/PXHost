import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { PaymentProviderRegistry } from './payment-provider.registry';

@Controller('api/public/payment-providers')
@Public()
export class PaymentProvidersController {
  constructor(private readonly providers: PaymentProviderRegistry) {}

  @Get()
  list() {
    return this.providers.available();
  }

  @Get('capabilities')
  capabilities() {
    return this.providers.availableWithCapabilities();
  }
}
