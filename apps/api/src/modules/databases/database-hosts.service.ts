import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { MysqlHostClient } from './mysql-host-client.service';
import { CreateDatabaseHostDto, UpdateDatabaseHostDto } from './dto/database-host.dto';

@Injectable()
export class DatabaseHostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly mysql: MysqlHostClient,
  ) {}

  static passwordAad(hostId: string): string {
    return `database_hosts:password_enc:${hostId}`;
  }

  list() {
    // The _count here is a query against the RLS-protected `databases`
    // table (see remove()'s comment below) — must run under withRLS or
    // every host silently shows a count of zero.
    return this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) =>
      tx.databaseHost.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true, host: true, port: true, username: true, nodeId: true, maxDatabases: true, createdAt: true, _count: { select: { databases: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async get(id: string) {
    const host = await this.prisma.databaseHost.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, name: true, host: true, port: true, username: true, nodeId: true, maxDatabases: true, createdAt: true },
    });
    if (!host) throw new NotFoundException('Database host not found');
    return host;
  }

  /**
   * Tests the admin-supplied credentials against the real host BEFORE
   * persisting anything — a bad password/firewall rule fails loudly here,
   * at admin-input time, instead of silently at a customer's first
   * database create weeks later.
   */
  async create(dto: CreateDatabaseHostDto) {
    const port = dto.port ?? 3306;
    await this.mysql.testConnection({ host: dto.host, port, username: dto.username, password: dto.password });

    // Row created first (Postgres-generated uuidv7 id, matching every
    // other table's convention) with a placeholder ciphertext, THEN
    // updated with the real one bound to that id via AAD — same reason
    // NodeBootstrapService encrypts into an already-existing row: the
    // encryption is bound to WHERE it lives, which doesn't exist yet
    // before the INSERT. Both statements commit together in one
    // transaction, so the plaintext password is never visible outside it
    // and never persisted unencrypted.
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.databaseHost.create({
        data: {
          name: dto.name,
          host: dto.host,
          port,
          username: dto.username,
          passwordEnc: Buffer.alloc(0),
          nodeId: dto.nodeId,
          maxDatabases: dto.maxDatabases ?? 0,
        },
      });
      const enc = this.crypto.encrypt(dto.password, DatabaseHostsService.passwordAad(created.id));
      const keyVersion = Number(enc.slice(1, enc.indexOf('.')));
      const updated = await tx.databaseHost.update({
        where: { id: created.id },
        data: { passwordEnc: Buffer.from(enc, 'utf8'), keyVersion },
      });
      return { id: updated.id, name: updated.name, host: updated.host, port: updated.port, username: updated.username, maxDatabases: updated.maxDatabases };
    });
  }

  async update(id: string, dto: UpdateDatabaseHostDto) {
    await this.get(id);
    return this.prisma.databaseHost.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.get(id);
    // `databases` is RLS-protected (can_access_server) — a plain
    // this.prisma.database.count() here would silently run with no
    // app.user_id/app.is_admin session var set, so RLS treats it as an
    // anonymous caller and filters out every row, always reporting
    // "not in use" even when it very much is. Found live: this exact
    // call let a host with an active database delete successfully.
    // withRLS is the mandatory chokepoint for every tenant-table query,
    // per PrismaService's own doc comment — this was the one place in
    // this file that forgot it.
    const inUse = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.database.count({ where: { hostId: id } }));
    if (inUse > 0) throw new ConflictException('Database host is in use by existing databases');
    await this.prisma.databaseHost.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  /** Decrypts a host's admin credentials for MysqlHostClient — never returned to any API caller. */
  async decryptCredentials(id: string): Promise<{ host: string; port: number; username: string; password: string }> {
    const host = await this.prisma.databaseHost.findFirst({ where: { id, deletedAt: null } });
    if (!host) throw new NotFoundException('Database host not found');
    const password = this.crypto.decrypt(Buffer.from(host.passwordEnc).toString('utf8'), DatabaseHostsService.passwordAad(host.id));
    return { host: host.host, port: host.port, username: host.username, password };
  }
}
