import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';

// Stable, machine-readable error envelope used across the whole API
// (architecture doc 3.2): { code, message, status, correlationId, details }.
// The panel keys its translated error messages off `code`, never off
// `message` — so `code` must stay a stable SCREAMING_SNAKE identifier.
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const correlationId = randomUUID();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message = typeof body === 'string' ? body : (body as any).message;
      const details = typeof body === 'object' ? (body as any) : undefined;

      reply.status(status).send({
        code: codeForStatus(status),
        message: Array.isArray(message) ? message.join('; ') : message,
        status,
        correlationId,
        details: details?.errors ?? undefined,
      });
      return;
    }

    this.logger.error(`unhandled exception [${correlationId}]`, exception as Error);
    reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      correlationId,
    });
  }
}

function codeForStatus(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'BAD_REQUEST';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'VALIDATION_ERROR';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    default:
      return 'ERROR';
  }
}
