import { HttpException, HttpStatus } from '@nestjs/common';

export class ModpackProviderError extends HttpException {
  constructor(
    public readonly source: string,
    public readonly reason: 'rate_limited' | 'unavailable' | 'not_found' | 'invalid_response',
    message: string,
    status: HttpStatus = HttpStatus.BAD_GATEWAY,
  ) {
    super({ code: `MODPACK_PROVIDER_${reason.toUpperCase()}`, message, source }, status);
  }
}
