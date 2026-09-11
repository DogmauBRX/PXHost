import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { ServerAccessService } from '../authorization/server-access.service';
import type { AccessActor } from '../authorization/server-access.service';
import { PublicTemplatesService } from '../public/public-templates.service';
import { AuditService } from '../audit/audit.service';
import { DEFAULT_INSTALL_ENTRYPOINT, DEFAULT_INSTALL_IMAGE, ServersService } from './servers.service';
import { resolveDeclaredVariables } from './variable-resolution';
import { CompleteServerSetupDto } from './dto/server-setup.dto';

export interface SetupSoftwareOption {
  id: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  softwareKind: string | null;
  group: { id: string; name: string; iconUrl: string | null };
  versions: string[];
  defaultVersion: string | null;
  versionsCurated: boolean;
}

export interface SetupInfo {
  status: string;
  name: string;
  plan: { memoryMb: number; diskMb: number; cpuLimitPercent: number };
  software: SetupSoftwareOption[];
}

/**
 * The post-purchase setup flow's only write path — the thing that turns a
 * capacity-reserved-but-unconfigured `setup_pending` (or a previously
 * failed `install_failed`) server row into an `installing` one, choosing
 * the customer's software/version and dispatching to the agent for the
 * first time. Nothing here ever creates a server, allocation, or
 * subscription attach — those are `ServersService.createSetupPending`'s
 * job alone, already done at payment-confirmation time (see
 * `ProvisioningService.provisionOrder`). This service only ever narrows
 * an EXISTING row: `complete`'s CAS predicate (`status IN
 * ('setup_pending', 'install_failed')`) is the entire mechanism that lets
 * `POST /setup` double as both "first-time setup" and "retry after a
 * failed install."
 *
 * **Why retry here is safe** (the precondition the user's own retry
 * requirement demanded before allowing it): the agent's `Register` call
 * (agent/internal/srv/manager.go) is keyed on this row's OWN, never-
 * changing `id` — the same UUID for the server's entire life — under an
 * in-memory mutex checked before any Docker call, backstopped by Docker's
 * own deterministic container name (`gxhost-<uuid>`) for the one case the
 * in-memory guard can't see (an agent restart with an orphaned
 * container). A retried `POST /setup` reuses the identical server row:
 * same `id`, same `uid`, same `allocations` (never re-picked — `complete`
 * never touches `Allocation`), same subscription attach (never touches
 * `Subscription` either). It can only ever REPLACE which template/
 * variables this one row installs, never spawn a second server,
 * allocation, or reservation — see `ServersService.dispatchToAgent`'s own
 * doc comment for how a lost-in-flight dispatch (409 `SERVER_EXISTS`) is
 * absorbed as success rather than misreported as a failure that would
 * invite an unnecessary, actually-redundant retry.
 */
@Injectable()
export class ServerSetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ServerAccessService,
    private readonly publicTemplates: PublicTemplatesService,
    private readonly servers: ServersService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Built on `PublicTemplatesService.list()` — the exact same cached,
   * `isPublic && isActive`-filtered catalog the (removed) checkout step
   * used to read from — so this never duplicates template curation logic.
   * Only ever surfaces the `MINECRAFT_VERSION` option (by `envVariable`);
   * every other declared variable (`SERVER_JARFILE`, `PAPER_BUILD`,
   * `FABRIC_LOADER_VERSION`, …) stays invisible here on purpose — the
   * customer picks software + version, nothing else, and `complete` fills
   * every other variable with its template default (see
   * `resolveDeclaredVariables`).
   */
  async getSetupInfo(actor: AccessActor, serverId: string): Promise<SetupInfo> {
    const { server, can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    if (!can('server.read')) throw new ForbiddenException('Missing permission: server.read');

    const templates = await this.publicTemplates.list();
    const software: SetupSoftwareOption[] = templates.map((t) => {
      const versionOption = t.options.find((o) => o.envVariable === 'MINECRAFT_VERSION');
      const versionsCurated = versionOption?.kind === 'choice';
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        iconUrl: t.iconUrl,
        softwareKind: t.softwareKind,
        group: t.group,
        versions: versionsCurated ? (versionOption!.choices ?? []) : versionOption ? [versionOption.defaultValue] : [],
        defaultVersion: versionOption?.defaultValue ?? null,
        versionsCurated,
      };
    });

    return {
      status: server.status,
      name: server.name,
      // The server's OWN snapshotted columns, not `server.plan.*` — these
      // are the actual promised/reserved resources (set once at
      // `createOnNode` time from the plan that was current then, per
      // Fase 2) and stay correct even if the plan is later edited or
      // hard-deleted (`Server.plan` is nullable for exactly that reason —
      // see its own schema doc comment). Same fields
      // `ServersService.dispatchToAgent`'s `limits` payload uses below.
      plan: { memoryMb: server.memoryMb, diskMb: server.diskMb, cpuLimitPercent: server.cpuLimitPercent },
      software,
    };
  }

  /**
   * The CAS transition (setup plan Fase 6): `updateMany`'s `WHERE ...
   * AND status IN (...)` takes the row lock and re-evaluates the
   * predicate at UPDATE time, so of two concurrent submits (a genuine
   * double-click, or the client's own retry racing a still-in-flight
   * first attempt) exactly one gets `count === 1` — the loser sees
   * `INVALID_TRANSITION:` instead of silently double-dispatching to the
   * agent. No advisory lock needed here, unlike `createOnNode`'s: every
   * capacity-relevant field (memory/disk/CPU/slot/allocation/uid) was
   * already fixed at reservation time and nothing below touches any of
   * them.
   *
   * `can('server.read')` — not `can('startup.update')` — is deliberate:
   * `allowedForStatus`'s pre-ready branch (Fase 7) denies every
   * non-`.read` permission for `setup_pending`/`installing`/
   * `install_failed`, `startup.update` included, by design (that gate
   * exists to stop a customer editing startup variables through the
   * NORMAL variables endpoint before there's even a template). This
   * method IS the one sanctioned exception the gate's own doc comment
   * calls out — it reaches the row directly, and the CAS predicate above
   * is what actually enforces "only from setup_pending/install_failed,"
   * not a permission string.
   */
  async complete(actor: AccessActor, serverId: string, dto: CompleteServerSetupDto) {
    const { server, can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    if (!can('server.read')) throw new ForbiddenException('Missing permission: server.read');

    // Re-checked here, never trusted from the id alone — mirrors
    // ServersService.create's own template resolution exactly (isActive
    // gate) plus the public-catalog filter (isPublic) GET .../setup's own
    // response was built from, since a template an admin unpublished
    // between GET and POST must not become installable anyway.
    const template = await this.prisma.serverTemplate.findFirst({
      where: { id: dto.templateId, deletedAt: null, isPublic: true, isActive: true },
    });
    if (!template) throw new NotFoundException('Template not found');

    const images = template.dockerImages as Record<string, string>;
    const [, dockerImage] = Object.entries(images)[0] ?? [undefined, undefined];
    if (!dockerImage) throw new ConflictException('Template has no docker images configured');

    const templateVars = await this.prisma.templateVariable.findMany({ where: { templateId: template.id } });
    // Unknown/non-editable/rule-violating keys throw here — the strict
    // sibling of createOnNode's own quiet-ignore loop (see
    // resolveDeclaredVariables's doc comment for why direct customer
    // input gets the strict behavior and admin/internal calls don't).
    // Crucially, this is also what keeps SERVER_MEMORY and every other
    // isUserEditable:false field out of the client's reach: they're
    // never in `templateVars`'s editable set, so a client "typing the
    // variable name it saw in devtools" gets a 403, not a resource bump.
    const resolvedValues = resolveDeclaredVariables(templateVars, dto.variables ?? {});

    // Both the CAS transition AND the ServerVariable writes happen inside
    // ONE `withRLS` transaction — `server_variables` carries the same RLS
    // policy `servers` does (PrismaService's own doc comment: "even one
    // already authorized by a guard MUST go through this"), so a bare
    // `this.prisma.serverVariable.upsert(...)` outside this callback would
    // run with no `app.user_id`/`app.is_admin` set and get rejected by
    // Postgres itself (42501) — found live, the exact bug class that
    // doc comment warns has shipped twice before. Using `tx` (not
    // `this.prisma`) for the upserts is what fixes it, and doing them in
    // the SAME transaction as the CAS is also strictly better than two
    // separate ones: a crash between them could otherwise leave a server
    // 'installing' with stale/missing variables.
    const count = await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const result = await tx.server.updateMany({
        where: { id: serverId, status: { in: ['setup_pending', 'install_failed'] } },
        data: { status: 'installing', templateId: template.id, dockerImage, startupCommand: template.startupCommand, name: dto.name },
      });
      if (result.count === 0) return 0;

      await Promise.all(
        templateVars.map((tv) =>
          tx.serverVariable.upsert({
            where: { serverId_variableId: { serverId, variableId: tv.id } },
            create: { serverId, variableId: tv.id, value: resolvedValues[tv.envVariable] },
            // `upsert`, not `create`: a retry after `install_failed` may be
            // re-running this for a row that already has ServerVariable
            // rows from the attempt that failed — a plain `create` would
            // hit the `[serverId, variableId]` unique constraint instead of
            // just overwriting the (possibly now-different) chosen values.
            update: { value: resolvedValues[tv.envVariable] },
          }),
        ),
      );
      return result.count;
    });
    if (count === 0) throw new ConflictException('INVALID_TRANSITION: server is not awaiting setup');

    await this.audit.record({
      action: 'server.setup.complete',
      targetType: 'server',
      targetId: serverId,
      actorId: actor.id,
      metadata: { templateId: template.id, retry: server.status === 'install_failed' },
    });

    // `rethrow: true` — unlike createOnNode's own dispatch, a setup/retry
    // failure must reach the client as a real error (the mid-turn retry
    // requirement: "o cliente deve poder tentar novamente... o retry deve
    // reutilizar obrigatoriamente... nunca criar um novo servidor"). The
    // row itself is still left at `install_failed` by dispatchToAgent on
    // a genuine failure — exactly the state this same CAS accepts as a
    // retry target — so the client's "Tentar novamente" is just another
    // `POST /setup`, nothing bespoke.
    await this.servers.dispatchToAgent(
      serverId,
      server.nodeId,
      {
        uuid: serverId,
        // `uid` is nullable on the column only for rows created BEFORE
        // capacity Fase 1 (see Server.uid's own schema doc comment) —
        // every row `createOnNode` writes since then, `setup_pending`
        // included, gets a real value from `CapacityService.nextUid`
        // under the node lock. A `setup_pending`/`install_failed` row
        // reaching this method is by construction one of those newer
        // rows, so this is provably non-null, not just conveniently
        // asserted.
        uid: server.uid!,
        image: dockerImage,
        startupTemplate: template.startupCommand,
        stopSignal: undefined,
        declaredVariables: templateVars.map((tv) => tv.envVariable),
        variables: resolvedValues,
        limits: {
          cpuPercent: server.cpuLimitPercent,
          memoryMb: server.memoryMb,
          swapMb: server.swapMb,
          diskMb: server.diskMb,
          ioWeight: server.ioWeight,
        },
        allocations: server.allocations.map((a) => ({ ip: a.ip, port: a.port, primary: a.isPrimary })),
        installImage: template.installImage || DEFAULT_INSTALL_IMAGE,
        installEntrypoint: template.installEntrypoint || DEFAULT_INSTALL_ENTRYPOINT,
        installScript: template.installScript,
      },
      { rethrow: true },
    );

    return { id: serverId, status: 'installing' as const };
  }
}
