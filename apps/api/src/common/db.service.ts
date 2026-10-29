import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { APP_CONFIG, AppConfig } from './config';

/** A database client bound to one transaction and one tenant. */
export interface TenantTx {
  tenantId: string;
  userId: string | null;
  query<T extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<T>;
  maybeOne<T extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<T | null>;
}

/**
 * Every request runs in a transaction that sets app.tenant_id from the verified
 * token, so PostgreSQL row-level security filters every table. The API connects
 * as a role without BYPASSRLS; a missing tenant context therefore sees nothing.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    // Dates and timestamps are exchanged in UTC; tenant time zones are applied by the engine.
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 20, options: '-c timezone=UTC' });
  }

  async withTenant<T>(tenantId: string, userId: string | null, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(this.wrap(client, tenantId, userId));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Queries that need no tenant context (dev sign-in lookup, health). */
  async system<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query<T>(sql, params);
    return res.rows;
  }

  private wrap(client: PoolClient, tenantId: string, userId: string | null): TenantTx {
    const query = async <T extends QueryResultRow>(sql: string, params: unknown[] = []) =>
      (await client.query<T>(sql, params)).rows;
    return {
      tenantId,
      userId,
      query,
      one: async <T extends QueryResultRow>(sql: string, params: unknown[] = []) => {
        const rows = await query<T>(sql, params);
        if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}`);
        return rows[0];
      },
      maybeOne: async <T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | null> => {
        const rows = await query<T>(sql, params);
        return rows.length ? rows[0] : null;
      },
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
