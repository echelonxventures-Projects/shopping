// @aether/service-offline-mode — low-connectivity storefront operation
// (P2-OFF-001). Module-as-a-Product: capture windows, queue limits, conflict
// strategies, price-drift tolerance, sync priorities are ALL PACK DATA.
// Orders captured offline replay through the checkout saga on reconnect —
// with price-drift protection: if the price moved beyond tolerance, the
// sync HOLDS the order for customer re-confirmation instead of charging wrong.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface OfflinePack {
  pack: { name: string };
  policies: {
    captureWindow: { maxAgeMs: number; maxCartAgeMs: number };
    queue: { maxPendingActions: number; maxPayloadKb: number; overflowPolicy: string };
    sync: { conflictStrategy: string; priceDriftTolerancePct: number; batchSize: number; retryBackoffMs: number[] };
    priority: { order: string[] };
    seedContent: string[];
  };
}

export interface OfflineAction {
  actionId: string;
  type: string; // order.place | cart.update | ...
  capturedAt: number; // epoch ms
  payloadKb: number;
  payload: Record<string, unknown>;
  priority: number; // lower = earlier sync
}

export type SyncOutcome =
  | { actionId: string; status: 'synced' }
  | { actionId: string; status: 'held-price-drift'; expectedPrice: number; currentPrice: number }
  | { actionId: string; status: 'rejected-stale'; reason: string }
  | { actionId: string; status: 'rejected-overflow'; reason: string };

export class OfflineModeService {
  private pack: OfflinePack;
  private queue: OfflineAction[] = [];
  private seq = 0;

  constructor(pack: OfflinePack) {
    this.pack = pack;
  }

  /** capture an action while offline — window + size + queue policies enforced */
  capture(type: string, capturedAt: number, payloadKb: number, payload: Record<string, unknown>): OfflineAction {
    const p = this.pack.policies;
    const windowMs = type === 'order.place' ? p.captureWindow.maxAgeMs : p.captureWindow.maxCartAgeMs;
    // (age checked at sync time; here we validate size + queue)
    if (payloadKb > p.queue.maxPayloadKb) {
      throw new Error(`Payload ${payloadKb}KB exceeds offline queue limit ${p.queue.maxPayloadKb}KB (pack policy)`);
    }
    if (this.queue.length >= p.queue.maxPendingActions) {
      if (p.queue.overflowPolicy === 'reject-oldest') {
        this.queue.shift(); // drop oldest, keep freshest actions
      } else {
        throw new Error('Offline queue full — overflow policy rejects new captures');
      }
    }
    const priority = p.priority.order.indexOf(type);
    const action: OfflineAction = {
      actionId: `act-${++this.seq}`, type, capturedAt, payloadKb, payload,
      priority: priority === -1 ? p.priority.order.length : priority,
    };
    this.queue.push(action);
    return action;
  }

  queueDepth(): number {
    return this.queue.length;
  }

  /**
   * sync the queue against live state. The host supplies a `live` lookup:
   *   currentPrice(type=order.place → offer price) for drift checking.
   * Sync order follows pack priority; stale actions rejected by window.
   */
  sync(live: { now: number; currentPriceFor?: (payload: Record<string, unknown>) => number | undefined }): SyncOutcome[] {
    const p = this.pack.policies;
    const ordered = [...this.queue].sort((a, b) => a.priority - b.priority || a.capturedAt - b.capturedAt);
    this.queue = [];
    const outcomes: SyncOutcome[] = [];
    for (const action of ordered) {
      const windowMs = action.type === 'order.place' ? p.captureWindow.maxAgeMs : p.captureWindow.maxCartAgeMs;
      const age = live.now - action.capturedAt;
      if (age > windowMs) {
        outcomes.push({ actionId: action.actionId, status: 'rejected-stale', reason: `age ${Math.round(age / 60000)}min > window ${Math.round(windowMs / 60000)}min` });
        continue;
      }
      // price-drift protection for order captures (conflict strategy from pack)
      if (action.type === 'order.place' && live.currentPriceFor && p.sync.conflictStrategy.includes('price-check')) {
        const expected = Number(action.payload['price']);
        const current = live.currentPriceFor(action.payload);
        if (expected !== undefined && current !== undefined) {
          const driftPct = Math.abs((current - expected) / expected) * 100;
          if (driftPct > p.sync.priceDriftTolerancePct) {
            outcomes.push({ actionId: action.actionId, status: 'held-price-drift', expectedPrice: expected, currentPrice: current });
            continue;
          }
        }
      }
      outcomes.push({ actionId: action.actionId, status: 'synced' });
    }
    return outcomes;
  }

  /** seed content for the offline PWA shell (pack decides what ships) */
  seedManifest(): string[] {
    return [...this.pack.policies.seedContent];
  }
}

const offlineModeModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as OfflinePack;
    const svc = new OfflineModeService(pack);
    const meter = (ev: string) => billing.meter(ev);
    return {
      capture: (t: string, at: number, kb: number, p: Record<string, unknown>) => (meter('action.captured'), svc.capture(t, at, kb, p)),
      queueDepth: () => svc.queueDepth(),
      sync: (live: { now: number; currentPriceFor?: (p: Record<string, unknown>) => number | undefined }) => (meter('queue.synced'), svc.sync(live)),
      seedManifest: () => svc.seedManifest(),
      __raw: svc,
    };
  },
};

export default offlineModeModule;
