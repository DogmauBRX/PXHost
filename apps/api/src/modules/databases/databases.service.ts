import { randomBytes, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ServerAccessService } from '../authorization/server-access.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { DatabaseHostsService } from './database-hosts.service';
import { MysqlHostClient } from './mysql-host-client.service';
import { AuditService } from '../audit/audit.service';
import { ActivityService } from '../activity/activity.service';
import { CreateDatabaseDto } from './dto/database.dto';

const DEFAULT_SUFFIX = 'db';
const REMOTE = '%'; // any host may connect with correct credentials — the game server's own outbound IP isn't knowable in advance (architecture doc roadmap M9, same convention as Pterodactyl)

@Injectable()
export class DatabasesService {
  constructor(
    private readonly access: ServerAccessService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly hosts: DatabaseHostsService,
    private readonly mysql: MysqlHostClient,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
  ) {}

  static passwordAad(databaseId: string): string {
    return `databases:password_enc:${databaseId}`;
  }

  async list(userId: string, serverId: string) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('database.read')) throw new ForbiddenException('Missing permission: database.read');
    return this.prisma.withRLS({ userId, isAdmin: false }, (tx) =>
      tx.database.findMany({
        where: { serverId: server.id },
        select: {
          id: true,
          database: true,
          username: true,
          remote: true,
          createdAt: true,
          host: { select: { id: true, name: true, host: true, port: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  /**
   * Provisions a real MySQL/MariaDB schema+user on an admin-registered
   * host and returns the plaintext password ONCE — like a bootstrap
   * token, it's never re-servable after this response; only the
   * encrypted form persists (architecture doc 3.6).
   */
  async create(userId: string, serverId: string, dto: CreateDatabaseDto) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('database.create')) throw new ForbiddenException('Missing permission: database.create');

    const existingCount = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) => tx.database.count({ where: { serverId: server.id } }));
    if (existingCount >= server.maxDatabases) {
      throw new ConflictException('Database limit reached for this server’s plan');
    }

    const hostId = await this.pickHostWithCapacity();
    const hostCreds = await this.hosts.decryptCredentials(hostId);

    const suffix = this.sanitizeSuffix(dto.name);
    const database = `s${server.shortId.toLowerCase()}_${suffix}`;
    const dbPassword = randomBytes(24).toString('base64url');

    const dbUsername = await this.generateUniqueUsername(hostId, server.shortId);

    await this.mysql.createDatabaseAndUser(hostCreds, { database, dbUsername, dbPassword, remote: REMOTE });

    try {
      const id = randomUUID();
      const enc = this.crypto.encrypt(dbPassword, DatabasesService.passwordAad(id));
      const keyVersion = Number(enc.slice(1, enc.indexOf('.')));
      const created = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) =>
        tx.database.create({
          data: {
            id,
            serverId: server.id,
            hostId,
            database,
            username: dbUsername,
            passwordEnc: Buffer.from(enc, 'utf8'),
            keyVersion,
            remote: REMOTE,
          },
        }),
      );
      await this.audit.record({
        action: 'server.database.create',
        targetType: 'server',
        targetId: server.id,
        actorId: userId,
        metadata: { databaseId: created.id, database, hostId },
      });
      await this.activity.record({ actorId: userId, serverId: server.id, event: 'server.database.create', properties: { databaseId: created.id, database } });
      return {
        id: created.id,
        database: created.database,
        username: created.username,
        password: dbPassword,
        remote: created.remote,
        host: { host: hostCreds.host, port: hostCreds.port },
      };
    } catch (err) {
      // The row insert failed AFTER the real schema+user already exist on
      // the host — never leave an orphaned, uncredentialed MySQL account
      // behind just because the metadata write failed.
      await this.mysql.dropDatabaseAndUser(hostCreds, { database, dbUsername, remote: REMOTE }).catch(() => undefined);
      throw err;
    }
  }

  async delete(userId: string, serverId: string, databaseId: string) {
    const { server, can } = await this.access.resolve(userId, serverId);
    if (!can('database.delete')) throw new ForbiddenException('Missing permission: database.delete');
    const db = await this.prisma.withRLS({ userId, isAdmin: false }, (tx) => tx.database.findFirst({ where: { id: databaseId, serverId: server.id } }));
    if (!db) throw new NotFoundException('Database not found');

    const hostCreds = await this.hosts.decryptCredentials(db.hostId);
    await this.mysql.dropDatabaseAndUser(hostCreds, { database: db.database, dbUsername: db.username, remote: db.remote });

    await this.prisma.withRLS({ userId, isAdmin: false }, (tx) => tx.database.delete({ where: { id: db.id } }));
    await this.audit.record({
      action: 'server.database.delete',
      targetType: 'server',
      targetId: server.id,
      actorId: userId,
      metadata: { databaseId: db.id, database: db.database },
    });
    await this.activity.record({ actorId: userId, serverId: server.id, event: 'server.database.delete', properties: { databaseId: db.id, database: db.database } });
  }

  /**
   * Drops every database a server owns on their real hosts, then their
   * metadata rows — called by ServersService.remove() BEFORE the server
   * row itself is hard-deleted (architecture doc roadmap M9: "server
   * deletion drops the schema+user"). Runs as admin, not a resolved
   * tenant action: server deletion is admin/automation-triggered
   * (architecture doc 9.4 — self-service deletion is off by default), and
   * by the time this runs the caller has already authorized the deletion
   * itself. Best-effort per database: one host being unreachable must
   * never block the rest of the teardown, but every failure is returned
   * so the caller can audit-log it rather than silently losing track of
   * an orphaned external schema+user.
   */
  async deleteAllForServer(serverId: string): Promise<{ droppedCount: number; failures: { database: string; error: string }[] }> {
    const dbs = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.database.findMany({ where: { serverId } }));
    const failures: { database: string; error: string }[] = [];
    let droppedCount = 0;
    for (const db of dbs) {
      try {
        const hostCreds = await this.hosts.decryptCredentials(db.hostId);
        await this.mysql.dropDatabaseAndUser(hostCreds, { database: db.database, dbUsername: db.username, remote: db.remote });
        droppedCount++;
      } catch (err) {
        failures.push({ database: db.database, error: (err as Error).message });
      }
    }
    return { droppedCount, failures };
  }

  private sanitizeSuffix(name: string | undefined): string {
    const trimmed = (name ?? '').trim().toLowerCase();
    return /^[a-z0-9_]{1,32}$/.test(trimmed) ? trimmed : DEFAULT_SUFFIX;
  }

  // Both of the withRLS wrappers below exist because `databases` is
  // RLS-protected (can_access_server) — found live, the same bug twice:
  // a plain this.prisma.database.* call here runs with no
  // app.user_id/app.is_admin session var set, so RLS silently filters out
  // every row (treats the caller as anonymous) rather than erroring. The
  // uniqueness check below would have always seen zero collisions
  // (harmless in practice, since the candidate already carries random
  // entropy, but the check itself was dead code), and pickHostWithCapacity
  // would have always seen zero usage on every host, never actually
  // spreading load — a `_count` on a relation to an RLS table is still a
  // query against that table, so it's just as exposed as a direct one.
  private async generateUniqueUsername(hostId: string, shortId: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `u${shortId.toLowerCase()}${randomBytes(3).toString('hex')}`; // fits MySQL's 32-char username ceiling with room to spare
      const existing = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.database.findFirst({ where: { hostId, username: candidate }, select: { id: true } }));
      if (!existing) return candidate;
    }
    throw new ConflictException('Could not allocate a unique database username, please retry');
  }

  /** Least-loaded host with room under its own admin-set cap — mirrors the node auto-deploy spread in architecture doc 2.6, never bin-packs. */
  private async pickHostWithCapacity(): Promise<string> {
    const hosts = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.databaseHost.findMany({
        where: { deletedAt: null },
        select: { id: true, maxDatabases: true, _count: { select: { databases: true } } },
      }),
    );
    const withRoom = hosts.filter((h) => h._count.databases < h.maxDatabases);
    if (withRoom.length === 0) throw new ConflictException('No database host with available capacity');
    withRoom.sort((a, b) => a._count.databases / a.maxDatabases - b._count.databases / b.maxDatabases);
    return withRoom[0].id;
  }
}
