import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './core/filters/http-exception.filter';

async function bootstrap(): Promise<void> {
  // bodyParser: false — Nest would otherwise register its OWN default
  // application/json parser during app.init(), which collides with the
  // custom one just below ("Content type parser 'application/json'
  // already present", found live writing this milestone's own e2e test
  // before it ever reached main.ts). Registering ours in Nest's place
  // captures the exact raw request bytes onto req.rawBody alongside the
  // normal JSON parsing — needed by BillingController (architecture doc
  // roadmap M14), which must verify an HMAC signature against what the
  // payment provider actually signed, not a re-serialized copy
  // (re-serializing can silently reorder keys/whitespace and invalidate
  // an otherwise-valid signature). Every OTHER route ignores req.rawBody
  // entirely, so this has no effect on them beyond holding one extra
  // Buffer per request.
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { bodyParser: false });
  app.getHttpAdapter().getInstance().addContentTypeParser('application/json', { parseAs: 'string' }, (req: any, body: string, done: (err: Error | null, body?: unknown) => void) => {
    req.rawBody = Buffer.from(body, 'utf8');
    try {
      done(null, body.length ? JSON.parse(body) : {});
    } catch (err) {
      done(err as Error);
    }
  });

  const config = app.get(ConfigService);

  await app.register(fastifyCookie as any);
  await app.register(fastifyHelmet as any, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  });

  // Exact-origin CORS allowlist with credentials — never a wildcard, per
  // architecture doc 3.6. CORS_ORIGIN may be a comma-separated list.
  //
  // methods is explicit: found live (a real browser, not curl — same
  // class of gap as the M6 refresh-cookie bug) that omitting it left
  // @fastify/cors defaulting to just GET,HEAD,POST — the CORS spec's
  // "simple methods" that never need a preflight at all — silently
  // dropping PUT/PATCH/DELETE from Access-Control-Allow-Methods. Every
  // GET-only route worked fine through every prior milestone's testing
  // for exactly that reason; the file manager's PUT (write) was the
  // first cross-origin call that ever needed a real preflight to succeed.
  const origins = config.get<string>('CORS_ORIGIN')!.split(',').map((o) => o.trim());
  app.enableCors({ origin: origins, credentials: true, maxAge: 600, methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] });

  // whitelist + forbidNonWhitelisted: DTOs are explicit allowlists, an
  // unexpected field is a 422, not silently dropped or silently accepted
  // (architecture doc 3.6).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  const port = config.get<number>('PORT')!;
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`PXHost API listening on :${port}`);
}

bootstrap();
