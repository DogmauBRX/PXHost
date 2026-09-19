import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentProviderRequestError } from './payment-provider.interface';

const DEFAULT_BASE_URL = 'https://api.mercadopago.com';
// Checkout is synchronous from the customer's point of view
// (OrdersService.createCheckoutOrder awaits every provider call before
// responding) — failing a touch faster than a browser tab will wait
// keeps a slow Mercado Pago response from stacking retries past that
// budget.
const TIMEOUT_MS = 8_000;
const MAX_RETRIES = 3;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

interface MercadoPagoErrorBody {
  message?: string;
  error?: string;
  status?: number;
  cause?: { code?: string | number; description?: string }[];
}

/**
 * The ONLY class in this codebase that speaks HTTP to Mercado Pago —
 * `MercadoPagoProvider` is its only caller. Plain `fetch`, no SDK: the
 * official Node SDK adds a dependency and its own abstractions for four
 * endpoints this platform calls, and the previous integration in this
 * module already established the plain-fetch pattern.
 *
 * Sandbox vs production is decided ENTIRELY by which access token is
 * configured (`TEST-…` vs `APP_USR-…`) — Mercado Pago serves both from
 * the same host, so there is deliberately no environment switch here,
 * unlike the provider this replaced.
 *
 * Retries are GET-only. Mercado Pago DOES document an idempotency key
 * for POST (`X-Idempotency-Key`, required on refunds), and every POST
 * this client makes carries one — but a retry is still the caller's
 * decision to make with a stable key, never something this layer does
 * silently behind a payment.
 */
@Injectable()
export class MercadoPagoClient {
  private readonly logger = new Logger(MercadoPagoClient.name);

  constructor(private readonly config: ConfigService) {}

  private baseUrl(): string {
    return this.config.get<string>('MERCADOPAGO_BASE_URL') ?? DEFAULT_BASE_URL;
  }

  private accessToken(): string {
    const token = this.config.get<string>('MERCADOPAGO_ACCESS_TOKEN');
    if (!token) {
      // Refuse at USE time, never at boot — every dev/test environment
      // must still start with no payment credentials configured.
      throw new ServiceUnavailableException('Mercado Pago não está configurado neste ambiente');
    }
    return token;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  /** `idempotencyKey` becomes `X-Idempotency-Key` — required by Mercado Pago on refunds, and used on every POST here so a retried checkout can never create a second charge. */
  async post<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
    return this.request<T>('POST', path, body, idempotencyKey);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  private async request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const url = `${this.baseUrl()}${path}`;
    const attempts = method === 'GET' ? MAX_RETRIES : 1;

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken()}`,
        };
        if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;

        const res = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.status === 204) return undefined as T;

        const text = await res.text();
        const data = text ? JSON.parse(text) : undefined;

        if (!res.ok) {
          if (RETRYABLE_STATUSES.has(res.status) && attempt < attempts) {
            await sleep(backoffMs(attempt));
            continue;
          }
          const err = data as MercadoPagoErrorBody | undefined;
          const code = err?.cause?.[0]?.code;
          // Never logs the access token (never in headers we log, and
          // Mercado Pago's error body carries no request echo).
          this.logger.error(`Mercado Pago ${method} ${path} failed: status=${res.status} body=${JSON.stringify(data)}`);
          throw new PaymentProviderRequestError(
            err?.message ?? err?.error ?? `Mercado Pago request failed (status ${res.status})`,
            res.status,
            code != null ? String(code) : null,
          );
        }

        return data as T;
      } catch (err) {
        clearTimeout(timeout);
        if (err instanceof PaymentProviderRequestError) throw err;
        if (err instanceof ServiceUnavailableException) throw err;
        lastError = err;
        if (attempt < attempts) {
          await sleep(backoffMs(attempt));
          continue;
        }
      }
    }

    this.logger.error(`Mercado Pago ${method} ${path} failed after ${attempts} attempt(s)`, lastError as Error);
    throw new PaymentProviderRequestError('Falha ao comunicar com o Mercado Pago', 0);
  }
}

function backoffMs(attempt: number): number {
  return 300 * 2 ** (attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
