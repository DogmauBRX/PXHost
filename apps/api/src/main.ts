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
  // trustProxy: true — deploy plan (VPS behind Caddy + Cloudflare).
  // apps/api is never published to the host in docker-compose.prod.yml
  // (only Caddy is), so the actual TCP peer of every request IS the
  // reverse proxy; trusting its X-Forwarded-For/X-Forwarded-Proto is
  // safe and is what makes `request.ip` (audit log actorIp, the
  // password-reset flow's per-IP rate limit) reflect the real client
  // instead of the proxy's own address. Harmless in dev/test: with no
  // proxy in front, there's no X-Forwarded-* header to trust in the
  // first place, so `request.ip` falls back to the raw socket peer
  // exactly as it always has.
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: true }));

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
  console.log(`GXhost API listening on :${port}`);
}

bootstrap();
