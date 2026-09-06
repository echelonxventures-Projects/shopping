// @aether/kernel-storage — Storage SPI (P0-CTR-003).
// Doctrine 6: engine-agnostic persistence. Engines declare capabilities; the projection
// engine negotiates per workload. Two Reference Pack engines ship: memory (dev/test)
// and file (durable, zero-dependency). Relational/search/KV engine classes are admitted
// through the conformance harness — never hand-wired.

export interface StorageCapabilities {
  engineClass: 'relational' | 'document' | 'kv' | 'search' | 'graph' | 'timeseries' | 'stream' | 'object' | 'ledger';
  durable: boolean;
  transactions: boolean;
  bitemporalIndexes: boolean;
  fullTextSearch: boolean;
  multiTenantIsolation: 'rls' | 'keys' | 'none';
  maxRecordBytes?: number;
}

export interface StoredRecord {
  id: string;
  tenantId: string;
  typeId: string;
  validFrom: string;
  validTo: string | null;
  recordedAt: string;
  epoch: number;
  attributes: Record<string, unknown>;
}

export interface PutOptions {
  /** upsert semantic; false => reject if current version exists (optimistic concurrency) */
  upsert?: boolean;
}

export interface EngineQuery {
  tenantId?: string;
  typeId?: string;
  id?: string;
  /** bitemporal point-in-time filter (valid-time) */
  asOf?: string;
  limit?: number;
}

export interface StorageEngine {
  readonly name: string;
  readonly capabilities: StorageCapabilities;

  put(record: StoredRecord, options?: PutOptions): Promise<void>;
  get(id: string, tenantId: string): Promise<StoredRecord | undefined>;
  query(q: EngineQuery): Promise<StoredRecord[]>;
  /** logically close current version at validTo (bitemporal supersede) */
  closeVersion(id: string, tenantId: string, validTo: string): Promise<void>;
  deleteAll(tenantId?: string): Promise<void>;
}

export class CapabilityMismatchError extends Error {
  constructor(engineName: string, required: string) {
    super(`Engine "${engineName}" lacks required capability: ${required}`);
    this.name = 'CapabilityMismatchError';
  }
}

export function negotiate(engine: StorageEngine, requires: Partial<StorageCapabilities>): void {
  const c = engine.capabilities;
  if (requires.durable && !c.durable) throw new CapabilityMismatchError(engine.name, 'durable');
  if (requires.transactions && !c.transactions) throw new CapabilityMismatchError(engine.name, 'transactions');
  if (requires.fullTextSearch && !c.fullTextSearch) throw new CapabilityMismatchError(engine.name, 'fullTextSearch');
  if (requires.engineClass && c.engineClass !== requires.engineClass) {
    throw new CapabilityMismatchError(engine.name, `engineClass=${requires.engineClass}`);
  }
}

// ---- Reference Pack engine 1: memory (dev/test) ----
export class MemoryEngine implements StorageEngine {
  readonly name = 'memory-engine';
  readonly capabilities: StorageCapabilities = {
    engineClass: 'document',
    durable: false,
    transactions: false,
    bitemporalIndexes: false,
    fullTextSearch: false,
    multiTenantIsolation: 'keys',
  };
  private rows = new Map<string, StoredRecord>(); // key: tenant:id:validFrom — ALL version windows
  private current = new Map<string, StoredRecord>(); // key: tenant:id — current window only

  private rowKey(r: { tenantId: string; id: string; validFrom: string }): string {
    return `${r.tenantId}:${r.id}:${r.validFrom}`;
  }
  private curKey(tenantId: string, id: string): string {
    return `${tenantId}:${id}`;
  }

  async put(record: StoredRecord, options?: PutOptions): Promise<void> {
    const cur = this.current.get(this.curKey(record.tenantId, record.id));
    if (cur && !options?.upsert) {
      throw new Error(`optimistic-concurrency conflict on ${this.curKey(record.tenantId, record.id)}: current version exists`);
    }
    this.rows.set(this.rowKey(record), record);
    if (record.validTo === null) this.current.set(this.curKey(record.tenantId, record.id), record);
  }

  async get(id: string, tenantId: string): Promise<StoredRecord | undefined> {
    return this.current.get(this.curKey(tenantId, id));
  }

  async query(q: EngineQuery): Promise<StoredRecord[]> {
    let out = [...this.rows.values()];
    if (q.tenantId) out = out.filter((r) => r.tenantId === q.tenantId);
    if (q.typeId) out = out.filter((r) => r.typeId === q.typeId);
    if (q.id) out = out.filter((r) => r.id === q.id);
    if (q.asOf) out = out.filter((r) => r.validFrom <= q.asOf && (r.validTo === null || r.validTo > q.asOf));
    else out = out.filter((r) => r.validTo === null);
    return q.limit ? out.slice(0, q.limit) : out;
  }

  async closeVersion(id: string, tenantId: string, validTo: string): Promise<void> {
    const ck = this.curKey(tenantId, id);
    const cur = this.current.get(ck);
    if (!cur) return;
    const closed: StoredRecord = { ...cur, validTo };
    this.rows.set(this.rowKey(closed), closed);
    this.current.delete(ck);
  }

  async historyAll(tenantId: string, id: string): Promise<StoredRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.tenantId === tenantId && r.id === id)
      .sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  }

  async deleteAll(tenantId?: string): Promise<void> {
    if (!tenantId) {
      this.rows.clear();
      this.current.clear();
    } else {
      for (const [k, r] of this.rows) if (r.tenantId === tenantId) this.rows.delete(k);
      for (const k of this.current.keys()) if (k.startsWith(`${tenantId}:`)) this.current.delete(k);
    }
  }
}

// ---- Reference Pack engine 2: file (durable, zero-dependency) ----
export class FileEngine implements HistoryCapableEngine {
  readonly name = 'file-engine';
  readonly capabilities: StorageCapabilities = {
    engineClass: 'document',
    durable: true,
    transactions: false,
    bitemporalIndexes: false,
    fullTextSearch: false,
    multiTenantIsolation: 'keys',
  };
  private rows = new Map<string, StoredRecord>(); // key: tenant:id:validFrom — ALL windows
  private current = new Map<string, StoredRecord>(); // key: tenant:id — current window
  private loaded = false;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  private rowKey(r: { tenantId: string; id: string; validFrom: string }): string {
    return `${r.tenantId}:${r.id}:${r.validFrom}`;
  }
  private curKey(tenantId: string, id: string): string {
    return `${tenantId}:${id}`;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.dbPath, 'utf8');
      for (const line of raw.split('\n').filter((l) => l.trim())) {
        const rec = JSON.parse(line) as StoredRecord;
        this.rows.set(this.rowKey(rec), rec);
        if (rec.validTo === null) this.current.set(this.curKey(rec.tenantId, rec.id), rec);
      }
    } catch {
      /* fresh db */
    }
  }

  private flush(): void {
    const dir = dirname(this.dbPath);
    mkdirSync(dir, { recursive: true });
    const lines = [...this.rows.values()].map((r) => JSON.stringify(r));
    writeFileSync(this.dbPath, lines.join('\n') + (lines.length ? '\n' : ''));
  }

  async put(record: StoredRecord, options?: PutOptions): Promise<void> {
    this.load();
    const cur = this.current.get(this.curKey(record.tenantId, record.id));
    if (cur && !options?.upsert) {
      throw new Error(`optimistic-concurrency conflict on ${this.curKey(record.tenantId, record.id)}: current version exists`);
    }
    this.rows.set(this.rowKey(record), record);
    if (record.validTo === null) this.current.set(this.curKey(record.tenantId, record.id), record);
    this.flush();
  }

  async get(id: string, tenantId: string): Promise<StoredRecord | undefined> {
    this.load();
    return this.current.get(this.curKey(tenantId, id));
  }

  async query(q: EngineQuery): Promise<StoredRecord[]> {
    this.load();
    let out = [...this.rows.values()];
    if (q.tenantId) out = out.filter((r) => r.tenantId === q.tenantId);
    if (q.typeId) out = out.filter((r) => r.typeId === q.typeId);
    if (q.id) out = out.filter((r) => r.id === q.id);
    if (q.asOf) out = out.filter((r) => r.validFrom <= q.asOf && (r.validTo === null || r.validTo > q.asOf));
    else out = out.filter((r) => r.validTo === null);
    return q.limit ? out.slice(0, q.limit) : out;
  }

  async closeVersion(id: string, tenantId: string, validTo: string): Promise<void> {
    this.load();
    const ck = this.curKey(tenantId, id);
    const cur = this.current.get(ck);
    if (!cur) return;
    const closed: StoredRecord = { ...cur, validTo };
    this.rows.set(this.rowKey(closed), closed);
    this.current.delete(ck);
    this.flush();
  }

  async historyAll(tenantId: string, id: string): Promise<StoredRecord[]> {
    this.load();
    return [...this.rows.values()]
      .filter((r) => r.tenantId === tenantId && r.id === id)
      .sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  }

  async deleteAll(tenantId?: string): Promise<void> {
    this.load();
    if (!tenantId) {
      this.rows.clear();
      this.current.clear();
    } else {
      for (const [k, r] of this.rows) if (r.tenantId === tenantId) this.rows.delete(k);
      for (const k of this.current.keys()) if (k.startsWith(`${tenantId}:`)) this.current.delete(k);
    }
    this.flush();
  }
}

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface HistoryCapableEngine extends StorageEngine {
  /** full version history (all valid-time windows) for bitemporal workloads */
  historyAll(tenantId: string, id: string): Promise<StoredRecord[]>;
}
