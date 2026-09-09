import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const SANDBOX_BASE_URL = 'https://api-sandbox.asaas.com';
const PRODUCTION_BASE_URL = 'https://api.asaas.com';
const API_PREFIX = '/v3';
// Checkout is synchronous from the customer's point of view
// (OrdersService.createCheckoutOrder awaits every provider call before
// responding) — failing a touch faster than a browser tab will wait
// keeps a slow Asaas response from stacking retries past that budget.
const TIMEOUT_MS = 8_000;
const MAX_RETRIES = 3;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export class AsaasApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly asaasErrors: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'AsaasApiError';
  }
}

/**
 * The ONLY class in this codebase that speaks HTTP to Asaas —
 * `AsaasProvider` is the only caller. Plain `fetch`, no SDK (Asaas
 * publishes no official Node SDK as of this integration).
 *
 * Retries are deliberately GET-only: Asaas's API documents no
 * idempotency-key mechanism for POST, so retrying a POST after a
 * network failure could duplicate a charge or a subscription — the
 * platform's own idempotency (checkout's `pending` order/subscription
 * guard, `externalReference` uniqueness) is the real protection there,
 * not a client-level retry.
 */
@Injectable()
export class AsaasClient {
  private readonly logger = new Logger(AsaasClient.name);

  constructor(private readonly config: ConfigService) {}

  private baseUrl(): string {
    const override = this.config.get<string>('ASAAS_BASE_URL');
    if (override) return override;
    const environment = this.config.get<string>('ASAAS_ENVIRONMENT') ?? 'sandbox';
    return environment === 'production' ? PRODUCTION_BASE_URL : SANDBOX_BASE_URL;
  }

  private apiKey(): string {
    const key = this.config.get<string>('ASAAS_API_KEY');
    if (!key) {
      throw new ServiceUnavailableException('Asaas não está configurado neste ambiente');
    }
    return key;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl()}${API_PREFIX}${path}`;
    const attempts = method === 'GET' ? MAX_RETRIES : 1;

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            // Asaas's own header name — deliberately NOT `Authorization:
            // Bearer` (confirmed against their docs, not assumed).
            access_token: this.apiKey(),
          },
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
          // Never logs the API key (never in headers we log, never in
          // `data` — Asaas's own error body carries no request echo).
          this.logger.error(`Asaas ${method} ${path} failed: status=${res.status} body=${JSON.stringify(data)}`);
          throw new AsaasApiError(res.status, data?.errors, `Asaas request failed (status ${res.status})`);
        }

        return data as T;
      } catch (err) {
        clearTimeout(timeout);
        if (err instanceof AsaasApiError) throw err;
        lastError = err;
        if (attempt < attempts) {
          await sleep(backoffMs(attempt));
          continue;
        }
      }
    }

    this.logger.error(`Asaas ${method} ${path} failed after ${attempts} attempt(s)`, lastError as Error);
    throw new AsaasApiError(0, null, 'Falha ao comunicar com o Asaas');
  }
}

function backoffMs(attempt: number): number {
  return 300 * 2 ** (attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
