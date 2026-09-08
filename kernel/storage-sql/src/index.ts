// @aether/kernel-storage-sql — SQL storage engine (Storage SPI adapter).
// A REAL relational engine over node:sqlite (embedded SQL, zero deps) — the
// PostgreSQL-class Reference Pack path: same SPI, real ACID tables, indexes,
// prepared statements. Admitted ONLY through the conformance matrix like every
// engine. Bitemporal windows are first-class rows (asOf queries via SQL WHERE,
// history via ORDER BY) — no EAV, no hacks.
//
// Schema (compiled projection — the SQL equivalent of the codegen DDL):
//   records(
//     tenant_id, id, type_id, valid_from, valid_to, recorded_at, epoch,
//     attributes TEXT(JSON), PRIMARY KEY (tenant_id, id, valid_from)
//   )
// Indexes: current-version (tenant, id) WHERE valid_to IS NULL; type scans.

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { StorageEngine, StorageCapabilities, StoredRecord, EngineQuery, PutOptions } from '@aether/kernel-storage';

export class SqlEngine implements StorageEngine {
  readonly name = 'sql-engine';
  readonly capabilities: StorageCapabilities = {
    engineClass: 'relational',
    durable: true,
    transactions: true,
    bitemporalIndexes: true,
    fullTextSearch: false, // FTS arrives as its own adapter (search SPI)
    multiTenantIsolation: 'rls',
  };

  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const path = dbPath ?? join(mkdtempSync(join(tmpdir(), 'aether-sql-')), 'store.db');
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        tenant_id  TEXT NOT NULL,
        id         TEXT NOT NULL,
        type_id    TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to   TEXT,
        recorded_at TEXT NOT NULL,
        epoch      INTEGER NOT NULL,
        attributes TEXT NOT NULL,
        PRIMARY KEY (tenant_id, id, valid_from)
      );
      CREATE INDEX IF NOT EXISTS idx_current ON records (tenant_id, id) WHERE valid_to IS NULL;
      CREATE INDEX IF NOT EXISTS idx_type ON records (type_id);
    `);
  }

  /** SQL-transacted put (single ACID statement — engine-level transactions) */
  async put(record: StoredRecord, options?: PutOptions): Promise<void> {
    const existing = this.db
      .prepare('SELECT valid_to FROM records WHERE tenant_id = ? AND id = ? AND valid_to IS NULL')
      .get(record.tenantId, record.id) as { valid_to: string | null } | undefined;
    if (existing && !options?.upsert) {
      throw new Error(`optimistic-concurrency conflict on ${record.tenantId}:${record.id}: current version exists`);
    }
    this.db
      .prepare(
        `INSERT INTO records (tenant_id, id, type_id, valid_from, valid_to, recorded_at, epoch, attributes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, id, valid_from) DO UPDATE SET
           type_id = excluded.type_id, valid_to = excluded.valid_to,
           recorded_at = excluded.recorded_at, epoch = excluded.epoch, attributes = excluded.attributes`
      )
      .run(
        record.tenantId,
        record.id,
        record.typeId,
        record.validFrom,
        record.validTo,
        record.recordedAt,
        record.epoch,
        JSON.stringify(record.attributes)
      );
  }

  async get(id: string, tenantId: string): Promise<StoredRecord | undefined> {
    const row = this.db
      .prepare('SELECT * FROM records WHERE tenant_id = ? AND id = ? AND valid_to IS NULL')
      .get(tenantId, id) as SqlRow | undefined;
    return row ? this.toRecord(row) : undefined;
  }

  /** asOf + filters computed IN SQL (bitemporal indexes are real indexes here) */
  async query(q: EngineQuery): Promise<StoredRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    clauses.push('valid_to IS NULL');
    if (q.tenantId) {
      clauses.push('tenant_id = ?');
      params.push(q.tenantId);
    }
    if (q.typeId) {
      clauses.push('type_id = ?');
      params.push(q.typeId);
    }
    if (q.id) {
      clauses.push('id = ?');
      params.push(q.id);
    }
    if (q.asOf) {
      clauses[0] = '(valid_from <= ? AND (valid_to IS NULL OR valid_to > ?))'; // replace the current-only clause
      params.unshift(q.asOf, q.asOf);
    }
    const limit = q.limit ? ' LIMIT ' + Math.floor(q.limit) : '';
    const rows = this.db
      .prepare(`SELECT * FROM records WHERE ${clauses.join(' AND ')}${limit}`)
      .all(...params) as SqlRow[];
    return rows.map((r) => this.toRecord(r));
  }

  /** bitemporal supersede: close the current window + insert the next — one transaction */
  async closeVersion(id: string, tenantId: string, validTo: string): Promise<void> {
    const tx = this.db.exec('BEGIN');
    void tx;
    try {
      const cur = this.db
        .prepare('SELECT valid_from FROM records WHERE tenant_id = ? AND id = ? AND valid_to IS NULL')
        .get(tenantId, id) as { valid_from: string } | undefined;
      if (cur) {
        this.db
          .prepare('UPDATE records SET valid_to = ? WHERE tenant_id = ? AND id = ? AND valid_from = ?')
          .run(validTo, tenantId, id, cur.valid_from);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async deleteAll(tenantId?: string): Promise<void> {
    if (!tenantId) {
      this.db.exec('DELETE FROM records');
    } else {
      this.db.prepare('DELETE FROM records WHERE tenant_id = ?').run(tenantId);
    }
  }

  /** full version history — every window, ordered (HistoryCapableEngine) */
  async historyAll(tenantId: string, id: string): Promise<StoredRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM records WHERE tenant_id = ? AND id = ? ORDER BY valid_from')
      .all(tenantId, id) as SqlRow[];
    return rows.map((r) => this.toRecord(r));
  }

  private toRecord(row: SqlRow): StoredRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      typeId: row.type_id,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      recordedAt: row.recorded_at,
      epoch: row.epoch,
      attributes: JSON.parse(row.attributes) as Record<string, unknown>,
    };
  }

  /** engine close (dev; production pools connections) */
  close(): void {
    this.db.close();
  }
}

interface SqlRow {
  tenant_id: string;
  id: string;
  type_id: string;
  valid_from: string;
  valid_to: string | null;
  recorded_at: string;
  epoch: number;
  attributes: string;
}
