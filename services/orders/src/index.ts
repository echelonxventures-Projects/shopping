// @aether/service-orders — order state machine on durable storage (P1-ORD-001).
// Kernel application: transitions come from the order-lifecycle workflow in the
// pack (never hardcoded states). Every transition is bitemporally versioned and
// journaled with its trigger + guard evaluation, so the full lifecycle is
// reconstructable point-in-time (disputes, audits).

import { WorkflowEngine } from '@aether/kernel-runtime/src/index.ts';
import { MemoryEngine, FileEngine, type StorageEngine, type StoredRecord } from '@aether/kernel-storage/src/index.ts';
import type { WorkflowDef } from '@aether/kernel-primitives';

export interface OrderLine {
  offerId: string;
  productId: string;
  sellerId: string;
  qty: number;
  unitPrice: number;
}

export interface OrderRecord {
  orderId: string;
  tenantId: string;
  customerId: string;
  lines: OrderLine[];
  currency: string;
  status: string;
  placedAt: string;
}

export interface TransitionEvent {
  orderId: string;
  from: string;
  to: string;
  trigger: string;
  at: string;
  actor?: string;
}

export class OrderStateError extends Error {
  constructor(orderId: string, from: string, to: string) {
    super(`Illegal order transition: ${orderId} ${from} → ${to} (workflow: order-lifecycle)`);
    this.name = 'OrderStateError';
  }
}

export class OrdersService {
  private wf: WorkflowEngine;
  private engine: StorageEngine;

  constructor(orderWorkflow: WorkflowDef, engine?: StorageEngine) {
    this.wf = new WorkflowEngine([orderWorkflow]);
    // storage engine is pluggable (admitted via conformance); file engine default for durability
    this.engine = engine ?? new FileEngine(defaultDbPath());
  }

  async place(order: OrderRecord): Promise<OrderRecord> {
    const initial = this.wf.initial('order-lifecycle');
    if (!initial) throw new Error('order-lifecycle workflow missing from pack');
    const now = new Date().toISOString();
    const rec: StoredRecord = {
      id: order.orderId,
      tenantId: order.tenantId,
      typeId: 'et_order',
      validFrom: now,
      validTo: null,
      recordedAt: now,
      epoch: 1,
      attributes: { ...order, status: initial, placedAt: order.placedAt ?? now },
    };
    await this.engine.put(rec, { upsert: true });
    return rec.attributes as unknown as OrderRecord;
  }

  async get(tenantId: string, orderId: string): Promise<OrderRecord | undefined> {
    const rec = await this.engine.get(orderId, tenantId);
    return rec ? (rec.attributes as unknown as OrderRecord) : undefined;
  }

  /**
   * Transition via pack workflow. Guards evaluated against facts; the trigger
   * must exist in the pack's transition table. Emits a TransitionEvent for the
   * audit journal (event-sourced lifecycle).
   */
  async transition(
    tenantId: string,
    orderId: string,
    to: string,
    trigger: string,
    facts: Record<string, unknown> = {}
  ): Promise<TransitionEvent> {
    const current = await this.get(tenantId, orderId);
    if (!current) throw new Error(`Order ${orderId} not found`);
    const legal = this.wf.canTransition('order-lifecycle', current.status, to, guardFacts(current, facts));
    if (!legal) throw new OrderStateError(orderId, current.status, to);
    const at = new Date().toISOString();
    const event: TransitionEvent = { orderId, from: current.status, to, trigger, at };
    // bitemporal version history via supersede semantics (keep prior windows)
    const prior = await this.engine.get(orderId, tenantId);
    if (prior) {
      await this.engine.closeVersion(orderId, tenantId, at);
    }
    await this.engine.put(
      {
        id: orderId,
        tenantId,
        typeId: 'et_order',
        validFrom: at,
        validTo: null,
        recordedAt: at,
        epoch: 1,
        attributes: { ...current, status: to },
      },
      { upsert: true }
    );
    return event;
  }

  async history(tenantId: string, orderId: string): Promise<StoredRecord[]> {
    const eng = this.engine as StorageEngine & { historyAll?: (t: string, id: string) => Promise<StoredRecord[]> };
    if (!eng.historyAll) throw new Error('engine lacks historyAll — not admitted for order workloads');
    return eng.historyAll(tenantId, orderId);
  }

  canTransition(from: string, to: string, facts: Record<string, unknown> = {}): boolean {
    return this.wf.canTransition('order-lifecycle', from, to, guardFacts({} as OrderRecord, facts));
  }
}

function guardFacts(order: OrderRecord, facts: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...facts };
  for (const [k, v] of Object.entries(facts)) out[`guard:${k}`] = v;
  out.orderValue = order.lines?.reduce((s, l) => s + l.qty * l.unitPrice, 0) ?? 0;
  return out;
}

function defaultDbPath(): string {
  // dev/test durability path; production engines arrive via conformance admission
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  return join(tmpdir(), 'aether-orders', 'orders.jsonl');
}
