import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentProviderRequestError } from './payment-provider.interface';

const TIMEOUT_MS = 10_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

@Injectable()
export class PagBankClient {
  private readonly logger = new Logger(PagBankClient.name);

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('PAGBANK_TOKEN'));
  }

  async get<T>(path: string, subscriptions = false): Promise<T> {
    return this.request<T>('GET', path, undefined, undefined, subscriptions);
  }

  async getText(pathOrUrl: string): Promise<string> {
    return this.request<string>('GET', pathOrUrl, undefined, undefined, false, true);
  }

  async post<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
    return this.request<T>('POST', path, body, idempotencyKey);
  }

  async postSubscription<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
    return this.request<T>('POST', path, body, idempotencyKey, true);
  }

  async putSubscription<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>('PUT', path, body, undefined, true);
  }

  private token(): string {
    const token = this.config.get<string>('PAGBANK_TOKEN');
    if (!token) throw new ServiceUnavailableException('PagBank não está configurado neste ambiente');
    return token;
  }

  private baseUrl(subscriptions: boolean): string {
    const explicit = this.config.get<string>(subscriptions ? 'PAGBANK_SUBSCRIPTIONS_BASE_URL' : 'PAGBANK_API_BASE_URL');
    if (explicit) return explicit.replace(/\/$/, '');
    const sandbox = this.config.get<string>('PAGBANK_ENV') === 'sandbox';
    if (subscriptions) return sandbox ? 'https://sandbox.api.assinaturas.pagseguro.com' : 'https://api.assinaturas.pagseguro.com';
    return sandbox ? 'https://sandbox.api.pagseguro.com' : 'https://api.pagseguro.com';
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    pathOrUrl: string,
    body?: unknown,
    idempotencyKey?: string,
    subscriptions = false,
    textResponse = false,
  ): Promise<T> {
    const url = /^https:\/\//i.test(pathOrUrl) ? pathOrUrl : `${this.baseUrl(subscriptions)}${pathOrUrl}`;
    const attempts = method === 'GET' ? 3 : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const headers: Record<string, string> = {
          Accept: textResponse ? 'text/plain' : 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token()}`,
        };
        if (idempotencyKey) headers['x-idempotency-key'] = idempotencyKey.replace(/[^A-Za-z0-9]/g, '');
        const response = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const raw = await response.text();
        const data = textResponse ? raw : raw ? JSON.parse(raw) : undefined;
        if (!response.ok) {
          if (RETRYABLE_STATUSES.has(response.status) && attempt < attempts) {
            await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** (attempt - 1)));
            continue;
          }
          const error = data as { error_messages?: Array<{ error?: string; description?: string }>; message?: string } | undefined;
          const first = error?.error_messages?.[0];
          this.logger.error(`PagBank ${method} ${new URL(url).pathname} failed: status=${response.status} body=${raw.slice(0, 1000)}`);
          throw new PaymentProviderRequestError(first?.description ?? error?.message ?? `PagBank request failed (status ${response.status})`, response.status, first?.error ?? null);
        }
        return data as T;
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof PaymentProviderRequestError || error instanceof ServiceUnavailableException) throw error;
        lastError = error;
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** (attempt - 1)));
          continue;
        }
      }
    }

    this.logger.error('PagBank request failed after retries', lastError as Error);
    throw new PaymentProviderRequestError('Falha ao comunicar com o PagBank', 0);
  }
}
