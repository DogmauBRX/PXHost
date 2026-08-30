import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import * as mysql from 'mysql2/promise';

// Generated identifiers only — never customer-supplied verbatim (see
// DatabasesService.sanitizeSuffix) — but re-checked here as defense in
// depth right before use, since MySQL has no way to bind an identifier
// as a placeholder the way it can bind a value.
const IDENTIFIER_RE = /^[a-z0-9_]{1,64}$/;

function assertSafeIdentifier(name: string, kind: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`mysql-host-client: refusing unsafe ${kind} identifier ${JSON.stringify(name)}`);
  }
}

/**
 * Talks directly to an admin-registered MySQL/MariaDB "database host"
 * (architecture doc roadmap M9) to provision/tear down the actual
 * schema+user a game server's plugin connects to — never proxied through
 * the Node Agent, since a database host is a shared resource the panel
 * administers directly, not something that lives on any one node's
 * filesystem. Every connection is short-lived: connect, run the DDL,
 * disconnect — no pooling, since these are infrequent admin/provisioning
 * operations, not request-path hot paths.
 */
@Injectable()
export class MysqlHostClient {
  private async connect(host: { host: string; port: number; username: string; password: string }): Promise<mysql.Connection> {
    try {
      return await mysql.createConnection({
        host: host.host,
        port: host.port,
        user: host.username,
        password: host.password,
        connectTimeout: 10_000,
        multipleStatements: false, // one statement per round trip — no ambiguity about partial batch execution
      });
    } catch (err) {
      throw new ServiceUnavailableException(`Could not connect to database host: ${(err as Error).message}`);
    }
  }

  /** Used when registering a host, so a typo'd password/firewall rule fails at admin-input time, not at the customer's first database create. */
  async testConnection(host: { host: string; port: number; username: string; password: string }): Promise<void> {
    const conn = await this.connect(host);
    try {
      await conn.query('SELECT 1');
    } finally {
      await conn.end();
    }
  }

  async createDatabaseAndUser(
    host: { host: string; port: number; username: string; password: string },
    opts: { database: string; dbUsername: string; dbPassword: string; remote: string },
  ): Promise<void> {
    assertSafeIdentifier(opts.database, 'database');
    assertSafeIdentifier(opts.dbUsername, 'username');

    const conn = await this.connect(host);
    try {
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${opts.database}\``);
      // The password is the one value here that CAN be bound as a
      // placeholder — everything else (db name, username, remote) is a
      // generated, allowlist-checked identifier interpolated directly,
      // since MySQL has no placeholder syntax for identifiers.
      await conn.query(`CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?`, [opts.dbUsername, opts.remote, opts.dbPassword]);
      await conn.query(`GRANT ALL PRIVILEGES ON \`${opts.database}\`.* TO ?@?`, [opts.dbUsername, opts.remote]);
      await conn.query('FLUSH PRIVILEGES');
    } finally {
      await conn.end();
    }
  }

  /** Best-effort: IF EXISTS on both statements, so a database that's already gone (or was never fully created) never blocks server deletion. */
  async dropDatabaseAndUser(
    host: { host: string; port: number; username: string; password: string },
    opts: { database: string; dbUsername: string; remote: string },
  ): Promise<void> {
    assertSafeIdentifier(opts.database, 'database');
    assertSafeIdentifier(opts.dbUsername, 'username');

    const conn = await this.connect(host);
    try {
      await conn.query(`DROP DATABASE IF EXISTS \`${opts.database}\``);
      await conn.query(`DROP USER IF EXISTS ?@?`, [opts.dbUsername, opts.remote]);
      await conn.query('FLUSH PRIVILEGES');
    } finally {
      await conn.end();
    }
  }
}
