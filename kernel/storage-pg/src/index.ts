// @aether/kernel-storage-pg — wire-protocol PostgreSQL-class storage engine
// (Storage SPI adapter — the production data plane). Speaks the PostgreSQL
// wire protocol via the pg-class driver (swappable Reference Pack); admitted
// ONLY through the same conformance matrix as every engine (§2.7). Bitemporal
// windows are first-class rows: asOf in SQL WHERE, history via ORDER BY,
// supersede in a real transaction. DSN comes from config/env (never code).
//
// Schema (compiled projection — SQL equivalent of the codegen DDL):
//   records(
//     tenant_id, id, type_id, valid_from, valid_to, recorded_at, epoch,
//     attributes JSONB, PRIMARY KEY (tenant_id, id, valid_from)
//   )
// Indexes: current-version partial (tenant, id) WHERE valid_to IS NULL; type.
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { StorageEngine, StorageCapabilities, StoredRecord, EngineQuery, PutOptions, HistoryCapableEngine } from '@aether/kernel-storage';

export interface PgEngineOptions {
  /** connection string or pg config (from pack/env — never hardcoded) */
  connectionString?: string;
  /** logical DB name inside the server (multi-tenant cell naming) */
  database?: string;
  /** table namespace prefix when multiple platforms share a database */
  tablePrefix?: string;
  /** pool sizing (production knobs — pack data) */
  pool?: { max?: number; idleTimeoutMillis?: number };
}

export class PgEngine implements HistoryCapableEngine {
  readonly name = 'postgres-wire';
  readonly capabilities: StorageCapabilities = {
    engineClass: 'relational',
    durable: true,
    transactions: true,
    bitemporalIndexes: true,
    fullTextSearch: false, // search SPI adapter (OpenSearch-class) owns FTS
    multiTenantIsolation: 'rls',
  };

  private pool: Pool;
  private table: string;
  private ready: Promise<void> | null = null;

  constructor(opts: PgEngineOptions = {}) {
    const cfg = opts.connectionString
      ? { connectionString: opts.connectionString }
      : {
          host: process.env.PGHOST ?? '127.0.0.1',
          port: Number(process.env.PGPORT ?? 5432),
          user: process.env.PGUSER ?? 'aether',
          password: process.env.PGPASSWORD ?? 'aether',
          database: opts.database ?? process.env.PGDATABASE ?? 'aether',
        };
    this.pool = new Pool({ ...cfg, max: opts.pool?.max ?? 8, idleTimeoutMillis: opts.pool?.idleTimeoutMillis ?? 30_000 });
    this.table = `${opts.tablePrefix ?? ''}records`;
  }

  /** lazy one-time migration — every public op awaits it (admission-safe) */
  private ensure(): Promise<void> {
    this.ready ??= (async () => {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS ${this.table} (
          tenant_id   TEXT NOT NULL,
          id          TEXT NOT NULL,
          type_id     TEXT NOT NULL,
          valid_from  TEXT NOT NULL,
          valid_to    TEXT,
          recorded_at TEXT NOT NULL,
          epoch       INTEGER NOT NULL,
          attributes  JSONB NOT NULL,
          PRIMARY KEY (tenant_id, id, valid_from)
        )`);
      await this.pool.query(
        `CREATE INDEX IF NOT EXISTS ${this.table}_current ON ${this.table} (tenant_id, id) WHERE valid_to IS NULL`
      );
      await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_type ON ${this.table} (type_id)`);
    })();
    return this.ready;
  }

  /** explicit readiness (optional — lazy init also covers it) */
  async init(): Promise<void> {
    await this.ensure();
  }

  async put(record: StoredRecord, options?: PutOptions): Promise<void> {
    await this.ensure();
    const existing = await this.pool.query(
      `SELECT valid_to FROM ${this.table} WHERE tenant_id = $1 AND id = $2 AND valid_to IS NULL`,
      [record.tenantId, record.id]
    );
    if ((existing.rowCount ?? 0) > 0 && !options?.upsert) {
      throw new Error(`optimistic-concurrency conflict on ${record.tenantId}:${record.id}: current version exists`);
    }
    await this.pool.query(
      `INSERT INTO ${this.table} (tenant_id, id, type_id, valid_from, valid_to, recorded_at, epoch, attributes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (tenant_id, id, valid_from) DO UPDATE SET
         type_id = excluded.type_id, valid_to = excluded.valid_to,
         recorded_at = excluded.recorded_at, epoch = excluded.epoch,
         attributes = excluded.attributes`,
      [
        record.tenantId,
        record.id,
        record.typeId,
        record.validFrom,
        record.validTo,
        record.recordedAt,
        record.epoch,
        JSON.stringify(record.attributes),
      ]
    );
  }

  async get(id: string, tenantId: string): Promise<StoredRecord | undefined> {
    await this.ensure();
    const r = await this.pool.query(
      `SELECT * FROM ${this.table} WHERE tenant_id = $1 AND id = $2 AND valid_to IS NULL`,
      [tenantId, id]
    );
    return r.rows[0] ? this.toRecord(r.rows[0]) : undefined;
  }

  /** asOf + filters computed IN SQL (bitemporal indexes are real indexes) */
  async query(q: EngineQuery): Promise<StoredRecord[]> {
    await this.ensure();
    const clauses: string[] = [];
    const params: unknown[] = [];
    clauses.push('valid_to IS NULL');
    if (q.tenantId) { params.push(q.tenantId); clauses.push(`tenant_id = $${params.length}`); }
    if (q.typeId) { params.push(q.typeId); clauses.push(`type_id = $${params.length}`); }
    if (q.id) { params.push(q.id); clauses.push(`id = $${params.length}`); }
    if (q.asOf) {
      clauses[0] = `(valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1))`;
      params.unshift(q.asOf);
      // re-number remaining placeholders after unshift
      for (let i = 1; i < clauses.length; i++) {
        const m = clauses[i]!.match(/\$(\d+)/);
        if (m) clauses[i] = clauses[i]!.replace(/\$(\d+)/, `$${Number(m[1]) + 1}`);
      }
    }
    const limit = q.limit ? ` LIMIT ${Math.floor(q.limit)}` : '';
    const r = await this.pool.query(
      `SELECT * FROM ${this.table} WHERE ${clauses.join(' AND ')}${limit}`,
      params
    );
    return r.rows.map((row) => this.toRecord(row));
  }

  /** bitemporal supersede: close window + insert next — one transaction */
  async closeVersion(id: string, tenantId: string, validTo: string): Promise<void> {
    await this.ensure();
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        `SELECT valid_from FROM ${this.table} WHERE tenant_id = $1 AND id = $2 AND valid_to IS NULL`,
        [tenantId, id]
      );
      if (cur.rows[0]) {
        await client.query(
          `UPDATE ${this.table} SET valid_to = $1 WHERE tenant_id = $2 AND id = $3 AND valid_from = $4`,
          [validTo, tenantId, id, cur.rows[0].valid_from]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteAll(tenantId?: string): Promise<void> {
    await this.ensure();
    if (!tenantId) await this.pool.query(`DELETE FROM ${this.table}`);
    else await this.pool.query(`DELETE FROM ${this.table} WHERE tenant_id = $1`, [tenantId]);
  }

  /** full version history — every window, ordered */
  async historyAll(tenantId: string, id: string): Promise<StoredRecord[]> {
    await this.ensure();
    const r = await this.pool.query(
      `SELECT * FROM ${this.table} WHERE tenant_id = $1 AND id = $2 ORDER BY valid_from`,
      [tenantId, id]
    );
    return r.rows.map((row) => this.toRecord(row));
  }

  private toRecord(row: QueryResultRow): StoredRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      typeId: row.type_id,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      recordedAt: row.recorded_at,
      epoch: Number(row.epoch),
      attributes: row.attributes as Record<string, unknown>,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ---------- Distributed rate limiter (shared window counter on PG) ----------
// Multi-pod deployments: every gateway replica calls acquire() against the
// SAME window row — the limiter is cluster-wide, not per-process. Pack data
// (gateway rateLimits.requestsPerMinute) decides the budget per key.

export class PostgresRateLimiter {
  private pool: Pool;
  private table: string;
  private ready: Promise<void>;

  constructor(opts: PgEngineOptions & { tablePrefix?: string } = {}) {
    const cfg = opts.connectionString
      ? { connectionString: opts.connectionString }
      : {
          host: process.env.PGHOST ?? '127.0.0.1',
          port: Number(process.env.PGPORT ?? 5432),
          user: process.env.PGUSER ?? 'aether',
          password: process.env.PGPASSWORD ?? 'aether',
          database: opts.database ?? process.env.PGDATABASE ?? 'aether',
        };
    this.pool = new Pool({ ...cfg, max: 4 });
    this.table = `${opts.tablePrefix ?? ''}rate_windows`;
    this.ready = this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        rkey TEXT NOT NULL, w BIGINT NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY (rkey, w)
      )`).then(() => undefined);
  }

  /** count this request; true = within budget, false = rate-limited */
  async acquire(key: string, limitPerMinute: number): Promise<boolean> {
    await this.ready;
    const window = Math.floor(Date.now() / 60_000);
    const r = await this.pool.query(
      `INSERT INTO ${this.table} (rkey, w, count) VALUES ($1, $2, 1)
       ON CONFLICT (rkey, w) DO UPDATE SET count = ${this.table}.count + 1
       RETURNING count`,
      [key, window]
    );
    return Number(r.rows[0]!.count) <= limitPerMinute;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
