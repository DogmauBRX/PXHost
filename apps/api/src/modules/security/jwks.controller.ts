import { Controller, Get } from '@nestjs/common';
import { SigningKeysService } from './signing-keys.service';
import { Public } from '../auth/decorators/public.decorator';

/**
 * The public JWKS endpoint agents use for offline capability-token
 * verification (architecture doc 3.2/3.4, roadmap M13). Under
 * /api/remote/* for consistency with "what agents call," but genuinely
 * public — no NodeAuthGuard: a JWKS is public-key material by
 * definition, and requiring a node token here would be circular (the
 * agent needs this to verify tokens BEFORE it can safely trust anything
 * signed, including in principle a future token-carrying response from
 * this very endpoint).
 */
@Controller('api/remote/jwks')
@Public()
export class JwksController {
  constructor(private readonly signingKeys: SigningKeysService) {}

  @Get()
  async get() {
    const keys = await this.signingKeys.listPublic();
    return { keys: keys.map((k) => ({ kid: k.kid, publicKey: k.publicKey })) };
  }
}
