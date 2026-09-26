import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { ServerAccessService } from '../authorization/server-access.service';
import type { AccessActor } from '../authorization/server-access.service';
import { PublicTemplatesService } from '../public/public-templates.service';
import { AuditService } from '../audit/audit.service';
import { DEFAULT_INSTALL_ENTRYPOINT, DEFAULT_INSTALL_IMAGE, ServersService } from './servers.service';
import { pickDockerImage } from '../templates/software-presets';
import { applyPlanManagedVariables, resolveDeclaredVariables } from './variable-resolution';
import { CompleteServerSetupDto } from './dto/server-setup.dto';
import { ChangeServerVersionDto } from './dto/change-version.dto';
import { SoftwareDiscoveryService } from '../templates/software-discovery.service';
import { KNOWN_MINECRAFT_VERSIONS, PRESET_KINDS, type PresetKind } from '../templates/software-presets';

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
    private readonly discovery: SoftwareDiscoveryService,
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
   *
   * A freshly-created preset template (software-presets.ts) has NO
   * curated `in:` list yet — `MINECRAFT_VERSION` starts as free-text
   * ("latest", narrowed only if an admin later runs "Atualizar versões")
   * — which used to mean the customer saw a bare text input instead of a
   * dropdown. Falling back to `SoftwareDiscoveryService` here (same live
   * APIs, same 10min Redis cache the admin wizard already reads from)
   * means the dropdown always reflects the CHOSEN software, curated or
   * not, without depending on an admin remembering to click that button
   * first. Safe against the template's own `rules` at `complete()` time:
   * an uncurated template's `MINECRAFT_VERSION` rule has no `in:`
   * restriction (just `required|string|max:16`), so any live-fetched
   * value still validates.
   */
  async getSetupInfo(actor: AccessActor, serverId: string): Promise<SetupInfo> {
    const { server, can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    if (!can('server.read')) throw new ForbiddenException('Missing permission: server.read');

    const templates = await this.publicTemplates.list();
    const software: SetupSoftwareOption[] = await Promise.all(
      templates.map(async (t) => {
        const versionOption = t.options.find((o) => o.envVariable === 'MINECRAFT_VERSION');
        let versionsCurated = versionOption?.kind === 'choice';
        let choices = versionsCurated ? (versionOption!.choices ?? []) : [];

        if (!versionsCurated && t.softwareKind && (PRESET_KINDS as readonly string[]).includes(t.softwareKind)) {
          const kind = t.softwareKind as PresetKind;
          const liveVersions = await this.discovery.getVersions(kind);
          // KNOWN_MINECRAFT_VERSIONS as the floor, never plain free text:
          // found live, a template that was seeded (not curated through
          // the wizard) showed a bare text input to the customer — "type
          // a version and hope" — every time this live fetch happened to
          // fail (a third-party outage, or this environment having no
          // outbound access to it at all). A hand-picked, real, per-
          // software list is always available even then.
          choices = liveVersions.length > 0 ? liveVersions : KNOWN_MINECRAFT_VERSIONS[kind];
          versionsCurated = true;
        }

        // `defaultValue` is a free-text column ("latest" for every preset,
        // resolved by the install script itself — see software-presets.ts)
        // that predates per-template curated version lists. Once a template
        // is curated (`rules` narrowed to `in:<list>`, or curated live just
        // above), "latest" is no longer a value `resolveDeclaredVariables`
        // will accept, so it can never be trusted as this dropdown's
        // selected value without first checking it's actually a member of
        // that same list — otherwise the customer sees one version
        // pre-selected (the browser's own first-<option> fallback for an
        // unmatched `<select>` value) while the value that would actually
        // be submitted is the stale "latest".
        const defaultVersion =
          versionsCurated && versionOption?.defaultValue && !choices.includes(versionOption.defaultValue)
            ? (choices[0] ?? null)
            : (versionOption?.defaultValue ?? null);
        return {
          id: t.id,
          name: t.name,
          description: t.description,
          iconUrl: t.iconUrl,
          softwareKind: t.softwareKind,
          group: t.group,
          versions: versionsCurated ? choices : versionOption ? [versionOption.defaultValue] : [],
          defaultVersion,
          versionsCurated,
        };
      }),
    );

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
    // Version-aware: um servidor com mods no Java errado morre
    // carregando os mods, nao no startup (ver pickDockerImage).
    const dockerImage = pickDockerImage(images, dto.variables?.MINECRAFT_VERSION);
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
    const resolvedValues = applyPlanManagedVariables(resolveDeclaredVariables(templateVars, dto.variables ?? {}), server.memoryMb);

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

  /**
   * Changes an already-`ready` server's software/template — Vanilla ⇄
   * Paper ⇄ Forge ⇄ Fabric, or just a different curated Minecraft version
   * of the same one. Deliberately a SEPARATE method from `complete`
   * above, not a widened CAS on it: the two have disjoint preconditions
   * (this only ever accepts 'ready'; `complete` only ever accepts
   * 'setup_pending'/'install_failed') and disjoint permission checks
   * (`startup.update` — this genuinely rewrites startup config on a live
   * server, the same permission `ServerVariablesService.update` already
   * requires — vs. `complete`'s deliberate `server.read`, which only
   * makes sense pre-ready; see that method's own doc comment). Sharing
   * one method with an `if` branching on which precondition applied
   * would read as one operation with two unrelated meanings rather than
   * two operations that happen to dispatch the same way.
   *
   * Requires the server to already be `powerState: 'offline'` (product
   * decision: this never stops the server itself — a clear 409 here
   * beats a customer's world getting yanked out from under a running
   * container, or a cryptic agent-side rejection). World saves/plugins/
   * configs survive regardless: the install script — like every
   * template's — only ever writes/overwrites its own files inside the
   * SAME persistent data directory, never wipes it, so re-running it
   * against an existing volume is exactly as safe as the first install
   * `complete` already trusts it to be.
   */
  async changeVersion(
    actor: AccessActor,
    serverId: string,
    dto: ChangeServerVersionDto,
    auditAction: 'server.version.changed' | 'server.version.reinstalled' = 'server.version.changed',
  ) {
    const { server, can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    if (!can('startup.update')) throw new ForbiddenException('Missing permission: startup.update');
    if (server.status !== 'ready') throw new ConflictException('INVALID_TRANSITION: server is not ready for a version change');
    if (server.powerState !== 'offline') throw new ConflictException('SERVER_MUST_BE_OFFLINE: pare o servidor antes de trocar a versão');

    const template = await this.prisma.serverTemplate.findFirst({
      where: { id: dto.templateId, deletedAt: null, isPublic: true, isActive: true },
    });
    if (!template) throw new NotFoundException('Template not found');

    const images = template.dockerImages as Record<string, string>;
    // Version-aware: um servidor com mods no Java errado morre
    // carregando os mods, nao no startup (ver pickDockerImage).
    const dockerImage = pickDockerImage(images, dto.variables?.MINECRAFT_VERSION);
    if (!dockerImage) throw new ConflictException('Template has no docker images configured');

    const templateVars = await this.prisma.templateVariable.findMany({ where: { templateId: template.id } });
    const resolvedValues = applyPlanManagedVariables(resolveDeclaredVariables(templateVars, dto.variables ?? {}), server.memoryMb);

    // Same "CAS + variable upserts in one transaction" shape as `complete`
    // above, re-checking `powerState` at UPDATE time too — the server
    // could have started between `access.resolve`'s read and here.
    const count = await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const result = await tx.server.updateMany({
        where: { id: serverId, status: 'ready', powerState: 'offline' },
        data: { status: 'installing', templateId: template.id, dockerImage, startupCommand: template.startupCommand },
      });
      if (result.count === 0) return 0;

      await Promise.all(
        templateVars.map((tv) =>
          tx.serverVariable.upsert({
            where: { serverId_variableId: { serverId, variableId: tv.id } },
            create: { serverId, variableId: tv.id, value: resolvedValues[tv.envVariable] },
            update: { value: resolvedValues[tv.envVariable] },
          }),
        ),
      );
      return result.count;
    });
    if (count === 0) throw new ConflictException('SERVER_MUST_BE_OFFLINE: pare o servidor antes de trocar a versão');

    await this.audit.record({
      action: auditAction,
      actorId: actor.id,
      targetType: 'server',
      targetId: serverId,
      metadata: { templateId: template.id, previousTemplateId: server.templateId },
    });

    // dispatchReinstallToAgent, NOT dispatchToAgent: this server is
    // `ready`, which means the agent already has its container registered
    // from the ORIGINAL create — agent.createServer would always 409
    // SERVER_EXISTS here and never actually swap anything (see that
    // method's own doc comment for the bug this replaced). `previous`
    // is what a genuine dispatch failure reverts to, since the old
    // container is untouched in that case.
    await this.servers.dispatchReinstallToAgent(
      serverId,
      server.nodeId,
      {
        image: dockerImage,
        startupTemplate: template.startupCommand,
        stopSignal: undefined,
        declaredVariables: templateVars.map((tv) => tv.envVariable),
        variables: resolvedValues,
        installImage: template.installImage || DEFAULT_INSTALL_IMAGE,
        installEntrypoint: template.installEntrypoint || DEFAULT_INSTALL_ENTRYPOINT,
        installScript: template.installScript,
      },
      { templateId: server.templateId!, dockerImage: server.dockerImage!, startupCommand: server.startupCommand! },
      { rethrow: true },
    );

    return { id: serverId, status: 'installing' as const };
  }

  /**
   * Reinstalls the server's current software without making the browser
   * reconstruct its startup configuration. Server variables are the
   * authoritative current values, including loader/build selections that
   * are intentionally hidden from the normal settings form. Passing all of
   * them back through changeVersion keeps those values while reusing its
   * offline check, CAS, image selection, audit and Agent dispatch.
   */
  async reinstallCurrent(actor: AccessActor, serverId: string) {
    const { server, can } = await this.access.resolve(actor.id, serverId, actor.isAdmin);
    if (!can('startup.update')) throw new ForbiddenException('Missing permission: startup.update');
    if (!server.templateId) throw new ConflictException('O servidor ainda não possui uma versão instalada.');

    const currentVariables = await this.prisma.serverVariable.findMany({
      where: { serverId, variable: { templateId: server.templateId } },
      select: { value: true, variable: { select: { envVariable: true } } },
    });
    const variables = Object.fromEntries(currentVariables.map((row) => [row.variable.envVariable, row.value]));

    // A failed first install cannot use changeVersion: that path is for a
    // previously working (`ready`) server and assumes the Agent already has
    // it registered. complete() is the retry path built for install_failed;
    // dispatchToAgent first tries create and transparently reroutes a
    // SERVER_EXISTS response to reinstall, covering both possible Agent
    // states without creating another panel server/allocation.
    if (server.status === 'install_failed') {
      return this.complete(actor, serverId, { name: server.name, templateId: server.templateId, variables });
    }
    if (server.status !== 'ready') {
      throw new ConflictException('Aguarde a instalação atual terminar antes de reinstalar esta versão.');
    }

    return this.changeVersion(actor, serverId, { templateId: server.templateId, variables }, 'server.version.reinstalled');
  }
}
