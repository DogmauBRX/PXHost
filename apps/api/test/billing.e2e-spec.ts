import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';

/**
 * M14 (Billing hooks) DoD: "external payment event idempotently
 * suspends/restores a server." Exercises the real HMAC-signed webhook
 * endpoint end to end against real Postgres — signature verification,
 * the suspend/restore mapping, the status gate it feeds
 * (ServerAccessService.can()), and the idempotency guarantee itself (the
 * literal point of the DoD's own wording): delivering the SAME event id
 * twice must never double-process it.
 */
describe('Billing webhook (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let ownerToken: string;
  let nodeId: string;
  let locationId: string;
  let groupId: string;
  let templateId: string;
  let serverId: string;
  let planId: string;
  let fakeAgent: http.Server;
  let suspendCalls: unknown[] = [];
  const suffix = Date.now();
  const secret = 'dev-only-billing-webhook-secret-change-me'; // matches .env — see BILLING_WEBHOOK_SECRET

  function asAdmin<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }
  function authedAdmin(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${adminToken}` }, ...opts });
  }
  function authedOwner(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${ownerToken}` }, ...opts });
  }
  function sign(body: string): string {
    return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  }
  function postWebhook(payload: unknown, signatureOverride?: string) {
    const body = JSON.stringify(payload);
    return app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'content-type': 'application/json', 'x-signature': signatureOverride ?? sign(body) },
      payload: body,
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // bodyParser: false — see main.ts's matching comment: Nest's own
    // default JSON parser collides with the custom one just below.
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { bodyParser: false });
    await app.register(fastifyCookie as any);
    // Mirrors main.ts's own raw-body-capturing content-type parser —
    // BillingController needs req.rawBody to verify a real HMAC
    // signature against the exact bytes sent, not a re-serialized copy.
    app.getHttpAdapter().getInstance().addContentTypeParser('application/json', { parseAs: 'string' }, (req: any, body: string, done: (err: Error | null, body?: unknown) => void) => {
      req.rawBody = Buffer.from(body, 'utf8');
      try {
        done(null, body.length ? JSON.parse(body) : {});
      } catch (err) {
        done(err as Error);
      }
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);

    fakeAgent = http.createServer((req, res) => {
      if (req.method === 'PATCH' && req.url?.endsWith('/suspend')) {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          suspendCalls.push(JSON.parse(body));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ suspended: JSON.parse(body).suspended, state: 'offline' }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    // A distinct loopback address — see plans-apply.e2e-spec.ts's own
    // comment on why (a real partial-unique-index race across parallel
    // Jest workers otherwise). .1-.5 already claimed by earlier specs.
    await new Promise<void>((resolve) => fakeAgent.listen(0, '127.0.0.6', resolve));
    const port = (fakeAgent.address() as AddressInfo).port;

    const passwordHash = await argon2.hash('BillingE2EPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    const admin = await prisma.user.create({
      data: { email: `billing-admin-${suffix}@pxhost.local`, username: `billing-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true },
    });
    adminToken = JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: admin.email, password: 'BillingE2EPass!234567' } })).body).accessToken;

    const owner = await prisma.user.create({ data: { email: `billing-owner-${suffix}@pxhost.local`, username: `billing-owner-${suffix}`, passwordHash, isActive: true } });
    ownerToken = JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: owner.email, password: 'BillingE2EPass!234567' } })).body).accessToken;

    const loc = await prisma.location.create({ data: { shortCode: `billing-e2e-${suffix}`, name: 'Billing E2E' } });
    locationId = loc.id;
    await prisma.node.updateMany({ where: { fqdn: '127.0.0.6', deletedAt: null }, data: { deletedAt: new Date() } });
    const node = await prisma.node.create({ data: { locationId, name: `billing-e2e-node-${suffix}`, fqdn: '127.0.0.6', scheme: 'http', daemonPort: port, memoryTotalMb: 8192, diskTotalMb: 81920 } });
    nodeId = node.id;
    await authedAdmin(`/api/admin/nodes/${nodeId}/allocations`, { method: 'POST', payload: { ip: '203.0.124.10', startPort: 27995, endPort: 27995 } });
    const tokenRes = await authedAdmin(`/api/admin/nodes/${nodeId}/bootstrap-token`, { method: 'POST' });
    const bootstrapToken = JSON.parse(tokenRes.body).token;
    await app.inject({ method: 'POST', url: '/api/remote/nodes/bootstrap', payload: { token: bootstrapToken, hostname: 'billing-e2e-host' } });

    const group = await prisma.templateGroup.create({ data: { name: `billing-e2e-group-${suffix}` } });
    groupId = group.id;
    const template = await prisma.serverTemplate.create({ data: { groupId, name: 'billing-e2e template', author: 'test', dockerImages: { default: 'alpine:3.19' }, startupCommand: 'cat', installScript: '#!/bin/sh\ntrue' } });
    templateId = template.id;

    const planRes = await authedAdmin('/api/admin/plans', { method: 'POST', payload: { name: `billing-e2e-plan-${suffix}`, slug: `billing-e2e-plan-${suffix}`, memoryMb: 512, diskMb: 1024 } });
    planId = JSON.parse(planRes.body).id;

    const createRes = await authedAdmin('/api/admin/servers', { method: 'POST', payload: { ownerId: owner.id, nodeId, templateId, planId, name: 'billing-e2e server' } });
    serverId = JSON.parse(createRes.body).id;
    await asAdmin((tx) => tx.server.update({ where: { id: serverId }, data: { status: 'ready' } }));
  });

  afterAll(async () => {
    await asAdmin((tx) => tx.billingEvent.deleteMany({ where: { serverId } }));
    await asAdmin((tx) => tx.allocation.updateMany({ where: { node: { locationId } }, data: { isPrimary: false, serverId: null } }));
    await asAdmin((tx) => tx.server.deleteMany({ where: { nodeId } }));
    await prisma.serverTemplate.deleteMany({ where: { id: templateId } });
    await prisma.templateGroup.deleteMany({ where: { id: groupId } });
    await prisma.node.deleteMany({ where: { id: nodeId } });
    await prisma.location.deleteMany({ where: { id: locationId } });
    await prisma.plan.deleteMany({ where: { id: planId } });
    await prisma.user.updateMany({
      where: { email: { in: [`billing-admin-${suffix}@pxhost.local`, `billing-owner-${suffix}@pxhost.local`] } },
      data: { deletedAt: new Date() },
    });
    await new Promise<void>((resolve) => fakeAgent.close(() => resolve()));
    await app.close();
  });

  it('rejects a request with no signature header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: 'evt_x', type: 'invoice.payment_failed', data: { serverId } }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a request with a WRONG signature — same payload, tampered signature', async () => {
    const res = await postWebhook({ id: `evt_wrongsig_${suffix}`, type: 'invoice.payment_failed', data: { serverId } }, 'sha256=' + 'a'.repeat(64));
    expect(res.statusCode).toBe(401);

    const server = await asAdmin<{ status: string; suspensionReason: string | null }>((tx) => tx.server.findFirstOrThrow({ where: { id: serverId } }));
    expect(server.status).toBe('ready'); // untouched — a bad signature must never reach suspend logic
  });

  it('a real signed payment_failed event suspends the server for real — DB status AND a real agent push', async () => {
    suspendCalls = [];
    const res = await postWebhook({ id: `evt_fail_${suffix}`, type: 'invoice.payment_failed', data: { serverId } });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ processed: true, action: 'suspend' });

    const server = await asAdmin<{ status: string; suspensionReason: string | null }>((tx) => tx.server.findFirstOrThrow({ where: { id: serverId } }));
    expect(server.status).toBe('suspended');
    expect(server.suspensionReason).toContain('invoice.payment_failed');
    expect(suspendCalls).toEqual([{ suspended: true }]);
  });

  it('the status gate this feeds actually blocks a control action while suspended', async () => {
    const res = await authedOwner(`/api/client/servers/${serverId}/power`, { method: 'POST', payload: { action: 'start' } });
    expect(res.statusCode).toBe(403);
  });

  it('redelivering the SAME event id is an idempotent no-op — the whole point of the DoD wording', async () => {
    suspendCalls = [];
    const res = await postWebhook({ id: `evt_fail_${suffix}`, type: 'invoice.payment_failed', data: { serverId } });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ processed: false, action: 'suspend' });
    expect(suspendCalls).toEqual([]); // no second agent push for a duplicate delivery

    const count = await asAdmin((tx) => tx.billingEvent.count({ where: { id: `evt_fail_${suffix}` } }));
    expect(count).toBe(1); // not 2 — the primary key IS the dedup
  });

  it('a real signed payment_succeeded event restores the server', async () => {
    suspendCalls = [];
    const res = await postWebhook({ id: `evt_succeed_${suffix}`, type: 'invoice.payment_succeeded', data: { serverId } });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ processed: true, action: 'restore' });

    const server = await asAdmin<{ status: string; suspensionReason: string | null }>((tx) => tx.server.findFirstOrThrow({ where: { id: serverId } }));
    expect(server.status).toBe('ready');
    expect(server.suspensionReason).toBeNull();
    expect(suspendCalls).toEqual([{ suspended: false }]);
  });

  it('an event type this deployment does not act on is a successful no-op, not an error', async () => {
    const res = await postWebhook({ id: `evt_unmapped_${suffix}`, type: 'customer.updated', data: { serverId } });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ processed: false, action: null });
  });
});
