import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { RedisService } from '../src/core/redis/redis.service';
import { ProvisioningService } from '../src/modules/payments/provisioning.service';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider.interface';
import { FakePaymentProvider } from './fake-payment-provider';

/**
 * Payments plan step 6: turning a PAID order into a real server.
 * `ProvisioningService.provisionOrder` is called DIRECTLY (via Nest's DI
 * container, `app.get(ProvisioningService)`) rather than through the
 * real BullMQ queue+worker — this codebase has no e2e precedent for
 * driving a queue end-to-end (the worker is a separate process,
 * `src/worker.ts`, never started by these tests), and doing so would
 * only add polling/flakiness without exercising any different code path
 * than calling the service the worker itself calls.
 */
describe('Provisioning (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let provisioning: ProvisioningService;
  let adminToken: string;
  let customerToken: string;
  let customerId: string;
  let locationId: string;
  let groupId: string;
  let templateId: string;
  let nodeId: string;
  let fitPlanId: string;
  let hugePlanId: string;
  const suffix = Date.now();

  function asAdmin(fn: (tx: any) => Promise<any>): Promise<any> {
    return prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }

  function authedAdmin(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${adminToken}` }, ...opts });
  }

  async function checkout(planId: string): Promise<{ orderId: string; subscriptionId: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/checkout',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { planId, paymentMethod: 'pix' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    // Simulates what the webhook (payments plan step 5) already does on
    // an approved payment — this file isolates provisioning itself, not
    // webhook correctness (covered by payments-webhook.e2e-spec.ts).
    await asAdmin((tx) => tx.order.update({ where: { id: body.id }, data: { status: 'paid', paidAt: new Date() } }));
    return { orderId: body.id, subscriptionId: body.subscriptionId };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PAYMENT_PROVIDER)
      .useValue(new FakePaymentProvider())
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    provisioning = app.get(ProvisioningService);

    const staleRlKeys = await redis.client.keys('checkout_rl:*');
    if (staleRlKeys.length > 0) await redis.client.del(...staleRlKeys);

    const passwordHash = await argon2.hash('ProvisionPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    await prisma.user.create({
      data: { email: `provision-admin-${suffix}@gxhost.local`, username: `provision-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true },
    });
    const customer = await prisma.user.create({
      data: {
        email: `provision-customer-${suffix}@gxhost.local`,
        username: `provision-customer-${suffix}`,
        passwordHash,
        isActive: true,
        cpf: '25814736909',
        billingPostalCode: '01310100',
        billingAddressLine: 'Av. Paulista',
        billingAddressNumber: '1000',
        billingNeighborhood: 'Bela Vista',
        billingCity: 'São Paulo',
        billingState: 'SP',
      },
    });
    customerId = customer.id;

    const adminLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `provision-admin-${suffix}@gxhost.local`, password: 'ProvisionPass!234567' } });
    adminToken = JSON.parse(adminLogin.body).accessToken;
    const customerLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `provision-customer-${suffix}@gxhost.local`, password: 'ProvisionPass!234567' } });
    customerToken = JSON.parse(customerLogin.body).accessToken;

    const loc = await prisma.location.create({ data: { shortCode: `prov-e2e-${suffix}`, name: 'Provisioning E2E Location' } });
    locationId = loc.id;

    const node = await prisma.node.create({
      data: {
        locationId,
        name: `prov-e2e-node-${suffix}`,
        fqdn: `prov-e2e-node-${suffix}.test`,
        memoryTotalMb: 4096,
        memoryOverallocatePct: 0,
        diskTotalMb: 1_000_000,
        diskOverallocatePct: -1,
        isPublic: true,
      },
    });
    nodeId = node.id;
    await authedAdmin(`/api/admin/nodes/${nodeId}/allocations`, {
      method: 'POST',
      payload: { ip: '203.9.1.10', startPort: 27000, endPort: 27004 },
    });

    const group = await prisma.templateGroup.create({ data: { name: `prov-e2e-group-${suffix}` } });
    groupId = group.id;
    const template = await prisma.serverTemplate.create({
      data: {
        groupId,
        name: `prov-e2e-template-${suffix}`,
        author: 'test',
        dockerImages: { 'Java 21': 'ghcr.io/pxhost/yolks:java_21' },
        startupCommand: 'java -jar server.jar',
        installScript: '#!/bin/sh\n',
        isActive: true,
        isPublic: true,
      },
    });
    templateId = template.id;

    // Fits the node above (4096 MB) comfortably.
    const fitPlan = await prisma.plan.create({
      data: { name: `prov-e2e-plan-fit-${suffix}`, slug: `prov-e2e-plan-fit-${suffix}`, memoryMb: 512, diskMb: 1024, priceCents: 2990, isPublic: true },
    });
    fitPlanId = fitPlan.id;
    // Restricts automatic node selection to ONLY this file's own node —
    // same pattern scheduler.e2e-spec.ts/slots.e2e-spec.ts already use.
    // Without this, NodeSchedulerService picks from EVERY node in the
    // whole shared dev database, including ones OTHER e2e files created
    // moments ago in a parallel Jest worker — found live: a server
    // landed on a different spec file's node, and that file's own
    // afterAll then failed to delete it (servers_node_id_fkey), leaving
    // orphaned rows neither file's cleanup could ever reach.
    await authedAdmin(`/api/admin/plans/${fitPlanId}/nodes`, { method: 'PUT', payload: { nodes: [{ nodeId }] } });

    // No node anywhere could ever fit this — guarantees "no eligible
    // node" regardless of what other test files' nodes exist in the
    // shared dev database.
    const hugePlan = await prisma.plan.create({
      data: { name: `prov-e2e-plan-huge-${suffix}`, slug: `prov-e2e-plan-huge-${suffix}`, memoryMb: 999_999_999, diskMb: 999_999_999, priceCents: 990, isPublic: true },
    });
    hugePlanId = hugePlan.id;
  });

  afterAll(async () => {
    await asAdmin((tx) => tx.allocation.updateMany({ where: { node: { locationId } }, data: { isPrimary: false, serverId: null } }));
    await asAdmin((tx) => tx.server.deleteMany({ where: { ownerId: customerId } }));
    await asAdmin((tx) => tx.subscriptionEvent.deleteMany({ where: { subscription: { planId: { in: [fitPlanId, hugePlanId] } } } }));
    await asAdmin((tx) => tx.subscription.deleteMany({ where: { planId: { in: [fitPlanId, hugePlanId] } } }));
    // orders are DELETE-revoked by design (0022_payments) — left in
    // place, same convention every other payments e2e file follows.
    await prisma.plan.updateMany({ where: { id: { in: [fitPlanId, hugePlanId] } }, data: { deletedAt: new Date() } });
    await prisma.serverTemplate.deleteMany({ where: { id: templateId } });
    await prisma.templateGroup.deleteMany({ where: { id: groupId } });
    await prisma.node.deleteMany({ where: { locationId } });
    await prisma.location.deleteMany({ where: { id: locationId } });
    await prisma.user.updateMany({ where: { email: { contains: 'provision-' } }, data: { deletedAt: new Date() } });
    const rlKeys = await redis.client.keys('checkout_rl:*');
    if (rlKeys.length > 0) await redis.client.del(...rlKeys);
    await app.close();
  });

  it('provisions a paid order: creates a SETUP_PENDING server (no template/software chosen yet), attaches subscription.server_id AND order.server_id, with the PLAN\'s own resources reserved', async () => {
    const { orderId, subscriptionId } = await checkout(fitPlanId);

    await provisioning.provisionOrder(orderId);

    const order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order.provisioningStatus).toBe('done');
    expect(order.serverId).toBeTruthy();
    expect(order.provisioningError).toBeNull();

    const subscription = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(subscription.serverId).toBe(order.serverId);

    const server = await asAdmin((tx) => tx.server.findUnique({ where: { id: order.serverId } }));
    expect(server.ownerId).toBe(customerId);
    expect(server.nodeId).toBe(nodeId);
    // The post-purchase setup flow's whole point: no software chosen yet
    // at provisioning time — the row is reserved, not installing. See
    // the `servers_setup_consistency` CHECK for why all three columns
    // move together.
    expect(server.status).toBe('setup_pending');
    expect(server.templateId).toBeNull();
    expect(server.dockerImage).toBeNull();
    expect(server.startupCommand).toBeNull();
    // The PLAN's own numbers, snapshotted onto the row at reservation
    // time — this is what CapacityService.usageForNode already counts
    // even while the server is stopped and unconfigured.
    expect(server.memoryMb).toBe(512);
    expect(server.diskMb).toBe(1024);
  });

  it('re-provisioning an already-done order is an idempotent no-op — no second server', async () => {
    const { orderId } = await checkout(fitPlanId);
    await provisioning.provisionOrder(orderId);
    const firstOrder = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));

    await provisioning.provisionOrder(orderId); // called again, deliberately

    const secondOrder = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(secondOrder.serverId).toBe(firstOrder.serverId);
    expect(secondOrder.provisioningStatus).toBe('done');

    // Exactly one server row exists for this order's id — the second
    // call never created a duplicate.
    const serverCount = await asAdmin((tx) => tx.server.count({ where: { id: firstOrder.serverId } }));
    expect(serverCount).toBe(1);
  });

  it('a provisioning failure (no eligible node) leaves the order PAID, marks provisioning failed, and never touches the payment', async () => {
    const { orderId, subscriptionId } = await checkout(hugePlanId);

    await expect(provisioning.provisionOrder(orderId)).rejects.toThrow();

    const order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order.status).toBe('paid'); // untouched — a provisioning failure must never look like a payment failure
    expect(order.provisioningStatus).toBe('failed');
    expect(order.provisioningError).toBeTruthy();
    expect(order.serverId).toBeNull();
    expect(order.provisioningAttempts).toBe(1);

    const subscription = await asAdmin((tx) => tx.subscription.findUnique({ where: { id: subscriptionId } }));
    expect(subscription.serverId).toBeNull();
  });

  it('retrying a failed order is safe — fails the same way again, attempt count increments, still no partial server', async () => {
    const { orderId } = await checkout(hugePlanId);
    await expect(provisioning.provisionOrder(orderId)).rejects.toThrow();

    await expect(provisioning.provisionOrder(orderId)).rejects.toThrow(); // the retry

    const order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order.status).toBe('paid');
    expect(order.provisioningStatus).toBe('failed');
    expect(order.serverId).toBeNull();
    expect(order.provisioningAttempts).toBe(2);
  });

  it('refuses to provision an order that is not paid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/checkout',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { planId: fitPlanId, paymentMethod: 'pix' },
    });
    const orderId = JSON.parse(res.body).id;

    await expect(provisioning.provisionOrder(orderId)).rejects.toThrow();
    const order = await asAdmin((tx) => tx.order.findUnique({ where: { id: orderId } }));
    expect(order.serverId).toBeNull();
    expect(order.provisioningStatus).toBe('pending'); // never even attempted — refused before the 'running' transition
  });

  /**
   * `CreateCheckoutDto` no longer collects a template (see its own doc
   * comment) — every NEW order's `config` snapshot only ever has `plan`.
   * But `OrderConfigSnapshot.template` stays a legal, optional shape
   * specifically so an already-paid order placed BEFORE this change
   * keeps provisioning exactly as it always did, rather than losing the
   * software the customer already picked and paid for. This test
   * fabricates exactly that legacy shape directly (checkout itself can
   * no longer produce it) to prove `ProvisioningService`'s branch is
   * still live — see its own doc comment for the removal condition.
   */
  it('a legacy order whose config still carries a template provisions through the old already-installing path', async () => {
    const legacyOrder = await asAdmin((tx) =>
      tx.order.create({
        data: {
          externalReference: `ord_legacy_${suffix}_${Math.random().toString(36).slice(2)}`,
          userId: customerId,
          planId: fitPlanId,
          kind: 'plan_initial',
          amountCents: 2990,
          currency: 'BRL',
          status: 'paid',
          paidAt: new Date(),
          paymentMethod: 'pix',
          provisioningStatus: 'pending',
          config: {
            plan: { id: fitPlanId, name: 'legacy-plan-snapshot', memoryMb: 512, diskMb: 1024, cpuLimitPercent: 100 },
            serverName: 'legacy-servidor',
            template: { id: templateId, name: 'legacy-template-snapshot', groupId, groupName: 'legacy-group-snapshot' },
          },
        },
      }),
    );

    await provisioning.provisionOrder(legacyOrder.id);

    const order = await asAdmin((tx) => tx.order.findUnique({ where: { id: legacyOrder.id } }));
    expect(order.provisioningStatus).toBe('done');
    expect(order.serverId).toBeTruthy();

    const server = await asAdmin((tx) => tx.server.findUnique({ where: { id: order.serverId } }));
    expect(server.ownerId).toBe(customerId);
    expect(server.templateId).toBe(templateId); // the legacy path chooses software immediately, unlike setup_pending
    expect(server.name).toBe('legacy-servidor');
    expect(['installing', 'ready', 'install_failed']).toContain(server.status); // never 'setup_pending' — this path always dispatches
  });
});
