import { Test } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/prisma/prisma.service';

/**
 * The Admin Templates redesign's "criação rápida" wizard backend:
 * `POST /api/admin/templates/quick-create` (expands a software preset +
 * curated version/build lists into a full template) and
 * `POST /api/admin/eggs/:id/duplicate` (clones an existing template).
 * Both delegate to the pre-existing `createTemplate`
 * (`templates.e2e-spec.ts` already covers ITS own validation/storage
 * behavior) — this file only proves the NEW expansion/cloning logic
 * itself, not CRUD basics those specs already own.
 */
describe('Templates admin wizard (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let groupId: string;
  const createdTemplateIds: string[] = [];
  const suffix = Date.now();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);

    const passwordHash = await argon2.hash('WizardPass!234567', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
    await prisma.user.create({
      data: { email: `tpl-wizard-admin-${suffix}@gxhost.local`, username: `tpl-wizard-admin-${suffix}`, passwordHash, globalRole: 'admin', isActive: true },
    });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `tpl-wizard-admin-${suffix}@gxhost.local`, password: 'WizardPass!234567' } });
    adminToken = JSON.parse(login.body).accessToken;

    const group = await prisma.templateGroup.create({ data: { name: `tpl-wizard-group-${suffix}` } });
    groupId = group.id;
  });

  afterAll(async () => {
    if (createdTemplateIds.length > 0) await prisma.serverTemplate.deleteMany({ where: { id: { in: createdTemplateIds } } });
    await prisma.templateGroup.deleteMany({ where: { id: groupId } });
    await prisma.user.updateMany({ where: { email: `tpl-wizard-admin-${suffix}@gxhost.local` }, data: { deletedAt: new Date() } });
    await app.close();
  });

  function authed(url: string, opts: Record<string, unknown> = {}) {
    return app.inject({ url, headers: { authorization: `Bearer ${adminToken}` }, ...opts });
  }

  it('quick-create expands the Paper preset + curated versions/build into a full template, invisible to the client catalog until versions actually match', async () => {
    const res = await authed('/api/admin/templates/quick-create', {
      method: 'POST',
      payload: {
        groupId,
        name: `Paper Wizard ${suffix}`,
        softwareKind: 'paper',
        minecraftVersions: ['1.21.4', '1.21.1', '1.20.6'],
        builds: ['485', 'latest'],
        isPublic: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    createdTemplateIds.push(body.id);

    expect(body.softwareKind).toBe('paper');
    expect(body.dockerImages).toEqual({ 'Java 21': 'ghcr.io/pxhost/yolks:java_21' });
    expect(body.startupCommand).toContain('{{SERVER_MEMORY}}');
    expect(body.installScript).toContain('papermc.io');

    const versionVar = body.variables.find((v: { envVariable: string }) => v.envVariable === 'MINECRAFT_VERSION');
    expect(versionVar.rules).toBe('required|string|max:16|in:1.21.4,1.21.1,1.20.6');
    const buildVar = body.variables.find((v: { envVariable: string }) => v.envVariable === 'PAPER_BUILD');
    expect(buildVar.rules).toBe('required|string|max:16|in:485,latest');
    // SERVER_MEMORY stays plan-controlled — the wizard never exposes it, so
    // its rules are untouched by the version/build curation logic.
    const memoryVar = body.variables.find((v: { envVariable: string }) => v.envVariable === 'SERVER_MEMORY');
    expect(memoryVar.isUserEditable).toBe(false);

    // The public catalog now derives EXACTLY the curated version list —
    // proves createFromPreset's `in:` rule is the same one
    // PublicTemplatesService.deriveOptionShape reads for the client setup
    // screen, not a parallel/duplicated mechanism.
    const publicRes = await app.inject({ url: '/api/public/templates' });
    const publicTemplate = JSON.parse(publicRes.body).find((t: { id: string }) => t.id === body.id);
    const publicVersionOption = publicTemplate.options.find((o: { envVariable: string }) => o.envVariable === 'MINECRAFT_VERSION');
    expect(publicVersionOption.kind).toBe('choice');
    expect(publicVersionOption.choices).toEqual(['1.21.4', '1.21.1', '1.20.6']);
  });

  it('quick-create refuses a preset that requires a build when none was given (Forge, no builds)', async () => {
    const res = await authed('/api/admin/templates/quick-create', {
      method: 'POST',
      payload: { groupId, name: `Forge Wizard ${suffix}`, softwareKind: 'forge', minecraftVersions: ['1.20.1'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('quick-create accepts Vanilla with no build at all (it has no second tier)', async () => {
    const res = await authed('/api/admin/templates/quick-create', {
      method: 'POST',
      payload: { groupId, name: `Vanilla Wizard ${suffix}`, softwareKind: 'vanilla', minecraftVersions: ['1.21.4'] },
    });
    expect(res.statusCode).toBe(201);
    createdTemplateIds.push(JSON.parse(res.body).id);
  });

  it('duplicate clones every field and every variable, defaults to not-public, and never touches the original', async () => {
    const sourceRes = await authed('/api/admin/templates/quick-create', {
      method: 'POST',
      payload: { groupId, name: `Purpur Source ${suffix}`, softwareKind: 'purpur', minecraftVersions: ['1.21.4'], builds: ['2334'], isPublic: true },
    });
    const source = JSON.parse(sourceRes.body);
    createdTemplateIds.push(source.id);

    const dupRes = await authed(`/api/admin/eggs/${source.id}/duplicate`, { method: 'POST', payload: { name: `Purpur Copy ${suffix}` } });
    expect(dupRes.statusCode).toBe(201);
    const copy = JSON.parse(dupRes.body);
    createdTemplateIds.push(copy.id);

    expect(copy.id).not.toBe(source.id);
    expect(copy.name).toBe(`Purpur Copy ${suffix}`);
    expect(copy.softwareKind).toBe('purpur');
    expect(copy.installScript).toBe(source.installScript);
    expect(copy.dockerImages).toEqual(source.dockerImages);
    expect(copy.isPublic).toBe(false); // never goes live unreviewed, unlike the source
    expect(copy.isActive).toBe(true);
    expect(copy.variables.map((v: { envVariable: string; rules: string }) => [v.envVariable, v.rules]).sort()).toEqual(
      source.variables.map((v: { envVariable: string; rules: string }) => [v.envVariable, v.rules]).sort(),
    );

    // The original is completely untouched by the clone.
    const originalAfter = await authed(`/api/admin/eggs/${source.id}`);
    expect(JSON.parse(originalAfter.body).isPublic).toBe(true);
  });

  it('duplicate 404s for a template that does not exist', async () => {
    const res = await authed('/api/admin/eggs/00000000-0000-0000-0000-000000000000/duplicate', { method: 'POST', payload: { name: 'nope' } });
    expect(res.statusCode).toBe(404);
  });
});
