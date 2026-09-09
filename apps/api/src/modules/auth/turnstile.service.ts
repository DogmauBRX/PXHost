import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 8_000;

interface TurnstileVerifyResponse {
  success?: boolean;
  'error-codes'?: string[];
}

/**
 * Cloudflare Turnstile verification for the three lowest-friction,
 * highest-abuse-value public endpoints (login, register, forgot-
 * password). `AuthService` calls `verify` as the FIRST thing each of
 * those methods does — before any rate-limit counter or DB lookup — so
 * a bot's request is rejected as cheaply as possible.
 *
 * Off by default (`TURNSTILE_SECRET_KEY` unset skips verification
 * entirely, see env.schema.ts's own comment) — the same "explicit
 * opt-in, no dev/test friction" posture `ALLOW_PUBLIC_REGISTRATION`
 * already uses, not `ASAAS_API_KEY`'s refuse-at-use-time: an
 * unconfigured deployment must behave exactly like it did before this
 * feature existed, not lock everyone out of login.
 */
@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);

  constructor(private readonly config: ConfigService) {}

  async verify(token: string | undefined, remoteIp: string | null | undefined): Promise<void> {
    const secret = this.config.get<string>('TURNSTILE_SECRET_KEY');
    if (!secret) return; // feature disabled — see class doc comment

    // e2e specs run the real AuthModule against a real Postgres, but have
    // no browser to solve a Cloudflare challenge in — hitting Cloudflare's
    // API from the test run would also make the suite depend on network
    // access. Jest sets NODE_ENV=test itself (see package.json's test:e2e,
    // and env.schema.ts's own NODE_ENV enum already recognizes it); nothing
    // reachable outside a test run can produce that value.
    if (this.config.get<string>('NODE_ENV') === 'test') return;

    if (!token) {
      throw new BadRequestException('Confirmação de segurança ausente. Recarregue a página e tente novamente.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    let ok: boolean;
    try {
      const body = new URLSearchParams({ secret, response: token });
      if (remoteIp) body.set('remoteip', remoteIp);

      const res = await fetch(VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
      const data = (await res.json()) as TurnstileVerifyResponse;
      ok = res.ok && data.success === true;
      if (!ok) this.logger.warn(`Turnstile verification failed: ${JSON.stringify(data['error-codes'] ?? [])}`);
    } catch (err) {
      // Fails CLOSED — Cloudflare being unreachable is never a reason to
      // let an unverified request through, the same "never accept what
      // can't be verified" rule AsaasProvider.parseWebhook follows for a
      // missing/invalid webhook token.
      this.logger.error(`Turnstile verification request failed: ${(err as Error).message}`);
      ok = false;
    } finally {
      clearTimeout(timeout);
    }

    if (!ok) {
      throw new BadRequestException('Não foi possível confirmar que você não é um robô. Tente novamente.');
    }
  }
}
