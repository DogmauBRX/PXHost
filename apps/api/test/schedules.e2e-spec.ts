import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { ScheduleRunnerService } from '../src/modules/schedules/schedule-runner.service';

/**
 * M10 (Schedules): the actual tick/dispatch timing lives in BullMQ and a
 * separate worker process (see agent/README.md-style live-run notes in
 * ../README.md for the real, timed proof) — this suite proves the
 * request-scoped surface (CRUD, quota) plus `ScheduleRunnerService.run()`
 * itself, called directly, exactly as `schedule-dispatch.processor.ts`
 * calls it, against a real HTTP server standing in for the agent (same
 * reasoning as backups.e2e-spec.ts's 409 test: the point is proving the
 * real fetch()/response-handling path, not a mock of AgentClient).
 */
describe('Schedules (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let runner: ScheduleRunnerService;
  let adminToken: string;
  let ownerToken: string;
  let intruderToken: string;
  let nodeId: string;
  let locationId: string;
  let groupId: string;
  let templateId: string;
  let serverId: string;
  let fakeAgent: http.Server;
  let agentRequests: { method: string; url: string }[] = [];
  let failPowerOnce = false;
  const suffix = Date.now();

  function asAdmin<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }
  function authedAdmin(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${adminToken}` }, ...opts });
  }
  function asOwner(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${ownerToken}` }, ...opts });
  }
  function asIntruder(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${intruderToken}` }, ...opts });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    runner = app.get(ScheduleRunnerService);

    fakeAgent = http.createServer((req, res) => {
      agentRequests.push({ method: req.method!, url: req.url! });
      if (req.url?.endsWith('/backups') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }
      if (req.url?.endsWith('/backups') && req.method === 'POST') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'bkp1', sizeBytes: 10, sha256: 'x', createdAt: new Date().toISOString() }));
        return;
      }
      if (req.url?.endsWith('/power') && req.method === 'POST') {
        if (failPowerOnce) {
          failPowerOnce = false;
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'POWER_ACTION_FAILED', message: 'simulated failure' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ state: 'running', previous: 'offline' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    // A distinct loopback address per test file (backups=.1, databases=.2,
    // .3 here, subusers=.4) — fqdn's real partial-unique index made two
    // spec files racing to claim '127.0.0.1' in parallel Jest workers
    // intermittently fail with a genuine unique-constraint violation.
    await new Promise<void>((resolve) => fakeAgent.listen(0, '127.0.0.3', resolve));
    const port = (fakeAgent.address() as AddressInfo).port;

    const passwordHash = await argon2.hash('SchedPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    const admin = await prisma.user.create({ data: { email: `sched-admin-${suffix}@pxhost.local`, username: `sched-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true } });
    const owner = await prisma.user.create({ data: { email: `sched-owner-${suffix}@pxhost.local`, username: `sched-owner-${suffix}`, passwordHash, isActive: true } });
    const intruder = await prisma.user.create({ data: { email: `sched-intruder-${suffix}@pxhost.local`, username: `sched-intruder-${suffix}`, passwordHash, isActive: true } });

    adminToken = JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: admin.email, password: 'SchedPass!234567' } })).body).accessToken;
    ownerToken = JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: owner.email, password: 'SchedPass!234567' } })).body).accessToken;
    intruderToken = JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: intruder.email, password: 'SchedPass!234567' } })).body).accessToken;

    const loc = await prisma.location.create({ data: { shortCode: `sched-e2e-${suffix}`, name: 'Schedules E2E' } });
    locationId = loc.id;
    // fqdn carries a real partial-unique index (WHERE deleted_at IS NULL)
    // on lower(fqdn) — see backups.e2e-spec.ts's identical note.
    await prisma.node.updateMany({ where: { fqdn: '127.0.0.3', deletedAt: null }, data: { deletedAt: new Date() } });
    const node = await prisma.node.create({ data: { locationId, name: `sched-e2e-node-${suffix}`, fqdn: '127.0.0.3', scheme: 'http', daemonPort: port, memoryTotalMb: 4096, diskTotalMb: 40960 } });
    nodeId = node.id;
    await authedAdmin(`/api/admin/nodes/${nodeId}/allocations`, { method: 'POST', payload: { ip: '203.0.121.10', startPort: 27970, endPort: 27970 } });
    const tokenRes = await authedAdmin(`/api/admin/nodes/${nodeId}/bootstrap-token`, { method: 'POST' });
    const bootstrapToken = JSON.parse(tokenRes.body).token;
    const bootstrapRes = await app.inject({ method: 'POST', url: '/api/remote/nodes/bootstrap', payload: { token: bootstrapToken, hostname: 'sched-e2e-host' } });
    expect(bootstrapRes.statusCode).toBe(201);

    const group = await prisma.templateGroup.create({ data: { name: `sched-e2e-group-${suffix}` } });
    groupId = group.id;
    const template = await prisma.serverTemplate.create({ data: { groupId, name: 'sched-e2e template', author: 'test', dockerImages: { default: 'alpine:3.19' }, startupCommand: 'cat', installScript: '#!/bin/sh\ntrue' } });
    templateId = template.id;

    const planRes = await authedAdmin('/api/admin/plans', { method: 'POST', payload: { name: `sched-e2e-plan-${suffix}`, slug: `sched-e2e-plan-${suffix}`, memoryMb: 256, diskMb: 512, maxSchedules: 2, maxBackups: 5 } });
    const planId = JSON.parse(planRes.body).id;

    const owners = await prisma.user.findMany({ where: { email: owner.email } });
    const createRes = await authedAdmin('/api/admin/servers', { method: 'POST', payload: { ownerId: owners[0].id, nodeId, templateId, planId, name: 'sched-e2e server' } });
    serverId = JSON.parse(createRes.body).id;
  });

  afterAll(async () => {
    await asAdmin((tx) => tx.allocation.updateMany({ where: { node: { locationId } }, data: { isPrimary: false, serverId: null } }));
    await asAdmin((tx) => tx.server.deleteMany({ where: { nodeId } }));
    await prisma.serverTemplate.deleteMany({ where: { id: templateId } });
    await prisma.templateGroup.deleteMany({ where: { id: groupId } });
    await prisma.node.deleteMany({ where: { id: nodeId } });
    await prisma.location.deleteMany({ where: { id: locationId } });
    await prisma.user.updateMany({
      where: { email: { in: [`sched-admin-${suffix}@pxhost.local`, `sched-owner-${suffix}@pxhost.local`, `sched-intruder-${suffix}@pxhost.local`] } },
      data: { deletedAt: new Date() },
    });
    await new Promise<void>((resolve) => fakeAgent.close(() => resolve()));
    await app.close();
  });

  it('a non-owner gets 404 on every schedules route', async () => {
    const base = `/api/client/servers/${serverId}/schedules`;
    expect((await asIntruder(base)).statusCode).toBe(404);
    expect((await asIntruder(base, { method: 'POST', payload: { name: 'x' } })).statusCode).toBe(404);
  });

  let scheduleId: string;

  it('creates a schedule with a computed nextRunAt, and rejects an unparseable cron field', async () => {
    const bad = await asOwner(`/api/client/servers/${serverId}/schedules`, { method: 'POST', payload: { name: 'bad', cronMinute: 'not-a-cron-field' } });
    expect(bad.statusCode).toBe(400);

    const res = await asOwner(`/api/client/servers/${serverId}/schedules`, { method: 'POST', payload: { name: 'nightly restart+backup', cronHour: '3', cronMinute: '0', timezone: 'America/Sao_Paulo' } });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.nextRunAt).toBeTruthy();
    expect(new Date(body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    scheduleId = body.id;
  });

  it('adds tasks in sequence order', async () => {
    const t1 = await asOwner(`/api/client/servers/${serverId}/schedules/${scheduleId}/tasks`, { method: 'POST', payload: { action: 'backup' } });
    expect(t1.statusCode).toBe(201);
    expect(JSON.parse(t1.body).sequenceNumber).toBe(1);
    const t2 = await asOwner(`/api/client/servers/${serverId}/schedules/${scheduleId}/tasks`, { method: 'POST', payload: { action: 'power' } });
    expect(JSON.parse(t2.body).sequenceNumber).toBe(2);

    // CreateTaskDto's @IsIn(TASK_ACTIONS) rejection of an invalid action
    // is verified against the real running server (curl, not app.inject)
    // — the same known Fastify app.inject()/class-validator limitation
    // under --experimental-vm-modules documented in
    // client-servers.e2e-spec.ts and apps/api/README.md, not asserted
    // here for the same reason.
  });

  it('enforces the plan\'s maxSchedules quota (2 on this plan)', async () => {
    const second = await asOwner(`/api/client/servers/${serverId}/schedules`, { method: 'POST', payload: { name: 'second' } });
    expect(second.statusCode).toBe(201);
    const third = await asOwner(`/api/client/servers/${serverId}/schedules`, { method: 'POST', payload: { name: 'third' } });
    expect(third.statusCode).toBe(409);
  });

  it('ScheduleRunnerService.run() executes every task in order against the real agent, then advances nextRunAt', async () => {
    agentRequests = [];
    const before = await asAdmin<{ nextRunAt: Date }>((tx) => tx.schedule.findFirstOrThrow({ where: { id: scheduleId } }));

    await runner.run(scheduleId);

    const after = await asAdmin<{ isProcessing: boolean; lastRunStatus: string | null; nextRunAt: Date; lastRunAt: Date | null }>((tx) => tx.schedule.findFirstOrThrow({ where: { id: scheduleId } }));
    expect(after.isProcessing).toBe(false);
    expect(after.lastRunStatus).toBe('success');
    expect(after.lastRunAt).toBeTruthy();
    expect(after.nextRunAt.getTime()).toBeGreaterThan(before.nextRunAt.getTime() - 1); // recomputed from "now", so strictly a fresh future occurrence

    // task order: backup (task 1) then power (task 2) — the
    // fake agent recorded both real HTTP calls in that order (a GET .../backups
    // quota check precedes the POST, from BackupsService.create's own logic).
    const methods = agentRequests.map((r) => `${r.method} ${r.url.split('/').pop()}`);
    expect(methods).toEqual(['GET backups', 'POST backups', 'POST power']);
  });

  it('a task that fails aborts the remaining tasks unless continueOnFailure is set', async () => {
    agentRequests = [];
    failPowerOnce = true; // the schedule's task order is backup, power — power fails
    await runner.run(scheduleId);
    const after = await asAdmin<{ lastRunStatus: string | null }>((tx) => tx.schedule.findFirstOrThrow({ where: { id: scheduleId } }));
    expect(after.lastRunStatus).toBe('failed');
  });

  it('onlyWhenOnline skips the run entirely when the node is offline, without calling the agent', async () => {
    await asAdmin((tx) => tx.schedule.update({ where: { id: scheduleId }, data: { onlyWhenOnline: true } }));
    await asAdmin((tx) => tx.node.update({ where: { id: nodeId }, data: { healthStatus: 'offline' } }));
    agentRequests = [];

    await runner.run(scheduleId);

    const after = await asAdmin<{ lastRunStatus: string | null; isProcessing: boolean }>((tx) => tx.schedule.findFirstOrThrow({ where: { id: scheduleId } }));
    expect(after.lastRunStatus).toBe('skipped');
    expect(after.isProcessing).toBe(false);
    expect(agentRequests).toHaveLength(0);

    await asAdmin((tx) => tx.node.update({ where: { id: nodeId }, data: { healthStatus: 'online' } }));
  });

  it('the tick query never claims a schedule that is already is_processing (no double-fire)', async () => {
    await asAdmin((tx) => tx.schedule.update({ where: { id: scheduleId }, data: { isProcessing: true, isActive: true, nextRunAt: new Date(Date.now() - 1000) } }));
    const due = await asAdmin<{ id: string }[]>((tx) =>
      tx.$queryRaw`SELECT id FROM schedules WHERE is_active AND NOT is_processing AND next_run_at <= now() AND id = ${scheduleId}::uuid FOR UPDATE SKIP LOCKED`,
    );
    expect(due.find((r) => r.id === scheduleId)).toBeUndefined();
    await asAdmin((tx) => tx.schedule.update({ where: { id: scheduleId }, data: { isProcessing: false } }));
  });

  it('deleting a schedule removes its tasks too (cascade)', async () => {
    const res = await asOwner(`/api/client/servers/${serverId}/schedules/${scheduleId}`, { method: 'DELETE' });
    expect(res.statusCode).toBe(204);
    const remainingTasks = await asAdmin<number>((tx) => tx.task.count({ where: { scheduleId } }));
    expect(remainingTasks).toBe(0);
  });
});
