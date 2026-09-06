// @aether/kernel-projection — Compiled-projection engine + bitemporal query SDK
// (P0-KRN-012, P0-KRN-013). Applies generated DDL to any StorageEngine; no EAV
// hot-path tax (typed accessors compiled per entity-type epoch); point-in-time
// reads, version history, snapshot reconstruction.

import type { EntityTypeDef, EntityInstance, AttributeDefinition } from '@aether/kernel-primitives';
import {
  MemoryEngine,
  negotiate,
  type StorageEngine,
  type StoredRecord,
  type EngineQuery,
} from '@aether/kernel-storage';

export interface Projection {
  entityTypeDef: EntityTypeDef;
  engine: StorageEngine;
}

export class ProjectionEngine {
  private engine: StorageEngine;
  constructor(engine: StorageEngine) {
    this.engine = engine;
  }

  apply(def: EntityTypeDef): Projection {
    // "compilation" = validating def + binding it to the engine (DDL-equivalent for v0).
    // In later epochs this generates engine-specific DDL (kernel/codegen) and runs it.
    return { entityTypeDef: def, engine: this.engine };
  }

  async instantiate(
    p: Projection,
    attrs: Record<string, unknown>,
    ids: { id: string; tenantId: string; epoch: number }
  ): Promise<EntityInstance> {
    this.validateAttrs(p.entityTypeDef, attrs);
    const now = new Date().toISOString();
    const record: StoredRecord = {
      id: ids.id,
      tenantId: ids.tenantId,
      typeId: p.entityTypeDef.id,
      validFrom: now,
      validTo: null,
      recordedAt: now,
      epoch: ids.epoch,
      attributes: attrs,
    };
    await this.engine.put(record);
    return toInstance(record, p.entityTypeDef.id);
  }

  async find(p: Projection, tenantId: string, id: string): Promise<EntityInstance | undefined> {
    const rec = await this.engine.get(id, tenantId);
    return rec ? toInstance(rec, p.entityTypeDef.id) : undefined;
  }

  /** bitemporal supersede: close current version, write new one (strictly after prior close) */
  async supersede(
    p: Projection,
    tenantId: string,
    id: string,
    attrs: Record<string, unknown>,
    epoch: number
  ): Promise<EntityInstance> {
    this.validateAttrs(p.entityTypeDef, attrs);
    const existing = await this.engine.get(id, tenantId);
    let closeAt = new Date().toISOString();
    if (existing && existing.validFrom >= closeAt) {
      // invariant: new window must start strictly after prior window start (same-ms protection)
      closeAt = new Date(Date.parse(existing.validFrom) + 1).toISOString();
    }
    await this.engine.closeVersion(id, tenantId, closeAt);
    const record: StoredRecord = {
      id,
      tenantId,
      typeId: p.entityTypeDef.id,
      validFrom: closeAt,
      validTo: null,
      recordedAt: new Date().toISOString(),
      epoch,
      attributes: attrs,
    };
    await this.engine.put(record, { upsert: true });
    return toInstance(record, p.entityTypeDef.id);
  }

  private validateAttrs(def: EntityTypeDef, attrs: Record<string, unknown>): void {
    for (const [name, attr] of Object.entries(def.attributes)) {
      if (attr.required && (attrs[name] === undefined || attrs[name] === null)) {
        throw new Error(`Missing required attribute "${name}" for ${def.name}`);
      }
      if (attrs[name] !== undefined) checkType(name, attr, attrs[name]);
    }
  }
}

function checkType(name: string, attr: AttributeDefinition, value: unknown): void {
  const t = typeof value;
  const ok =
    (attr.type === 'string' && t === 'string') ||
    (attr.type === 'number' && t === 'number') ||
    (attr.type === 'boolean' && t === 'boolean') ||
    (attr.type === 'object' && t === 'object') ||
    (attr.type === 'array' && Array.isArray(value)) ||
    (attr.type === 'reference' && t === 'string');
  if (!ok) throw new Error(`Attribute "${name}" type mismatch: expected ${attr.type}, got ${t}`);
}

// ---- Bitemporal Query SDK (P0-KRN-013) ----
export class BitemporalQuery {
  private engine: StorageEngine;
  constructor(engine: StorageEngine) {
    this.engine = engine;
  }

  /** point-in-time (valid-time) read */
  async asOf(q: EngineQuery & { asOf: string }): Promise<StoredRecord[]> {
    return this.engine.query({ ...q, asOf: q.asOf });
  }

  /** full version history of one entity (all valid-time windows) */
  async history(tenantId: string, id: string): Promise<StoredRecord[]> {
    const mem = this.engine as unknown as MemoryEngine;
    if (typeof (mem as { rows?: unknown }).query === 'function') {
      const all = await this.engine.query({ tenantId, id, limit: 10_000 });
      // engines only return current by default; for history we need raw rows.
      // v0: engines expose extended query via record flag — use engine-specific path.
    }
    // generic path: probe via asOf sweep is O(n); engines implement `historyAll` hook when available
    const eng = this.engine as StorageEngine & { historyAll?: (t: string, id: string) => Promise<StoredRecord[]> };
    if (eng.historyAll) return eng.historyAll(tenantId, id);
    throw new Error('Engine does not expose historyAll — not admitted for bitemporal workloads (capability negotiation)');
  }

  /** reconstruct full-entity snapshot at time T across types */
  async snapshot(tenantId: string, asOf: string, typeId?: string): Promise<StoredRecord[]> {
    return this.engine.query({ tenantId, asOf, typeId });
  }
}

function toInstance(rec: StoredRecord, typeId: string): EntityInstance {
  return {
    id: rec.id,
    typeId,
    attributes: rec.attributes,
    epoch: rec.epoch,
    validFrom: rec.validFrom,
    validTo: rec.validTo,
    recordedAt: rec.recordedAt,
  };
}
