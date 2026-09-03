import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';

/**
 * Generic SMTP mail sender — no specific provider baked in (client account
 * management plan, Fase 1). `MAIL_HOST`/`MAIL_PORT`/`MAIL_USERNAME`/
 * `MAIL_PASSWORD`/`MAIL_FROM_ADDRESS`/`MAIL_FROM_NAME` are the exact env
 * var names the feature request specified; all optional, same posture as
 * `ASSISTANT_LLM_API_KEY` (env.schema.ts) — a customer-facing flow
 * degrading gracefully beats one that 500s because ops hasn't configured
 * SMTP yet. Deliberately NOT `BILLING_WEBHOOK_SECRET`'s "refuse at use
 * time" posture: the password-reset-request endpoint must always return
 * 200 regardless of mail outcome (anti-enumeration), so a hard refusal
 * here would have nowhere safe to surface.
 *
 * Without `MAIL_HOST` configured, `sendPasswordResetEmail` logs the
 * reset link instead of attempting to send — the same "the operator can
 * still see it happened" fallback the bootstrap-token flow uses (that one
 * shows the token in the admin UI instead of the console, but the
 * principle — a working dev/test path with zero external config — is the
 * same).
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('MAIL_HOST');
    if (host) {
      this.transporter = createTransport({
        host,
        port: this.config.get<number>('MAIL_PORT') ?? 587,
        secure: this.config.get<number>('MAIL_PORT') === 465,
        auth: this.config.get<string>('MAIL_USERNAME')
          ? { user: this.config.get<string>('MAIL_USERNAME'), pass: this.config.get<string>('MAIL_PASSWORD') }
          : undefined,
      });
    }
  }

  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
    const subject = 'Redefinição de senha';
    const text = `Recebemos uma solicitação para redefinir sua senha. Acesse o link abaixo para escolher uma nova senha (válido por 1 hora):\n\n${resetUrl}\n\nSe você não solicitou isso, pode ignorar este e-mail.`;
    const html = `<p>Recebemos uma solicitação para redefinir sua senha.</p><p><a href="${resetUrl}">Clique aqui para escolher uma nova senha</a> (válido por 1 hora).</p><p>Se você não solicitou isso, pode ignorar este e-mail.</p>`;

    if (!this.transporter) {
      this.logger.warn(`MAIL_HOST not configured — password reset link for ${to}: ${resetUrl}`);
      return;
    }

    try {
      await this.transporter.sendMail({
        to,
        from: this.mailFrom(),
        subject,
        text,
        html,
      });
    } catch (err) {
      // Never thrown to the caller: AuthService.requestPasswordReset fires
      // this without awaiting it (anti-enumeration — the HTTP response
      // must never wait on an SMTP round trip), so a delivery failure can
      // only ever be logged, never surfaced to the request that triggered
      // it.
      this.logger.error(`Failed to send password reset email to ${to}: ${(err as Error).message}`);
    }
  }

  private mailFrom(): string {
    const address = this.config.get<string>('MAIL_FROM_ADDRESS') ?? 'no-reply@localhost';
    const name = this.config.get<string>('MAIL_FROM_NAME');
    return name ? `"${name}" <${address}>` : address;
  }
}
