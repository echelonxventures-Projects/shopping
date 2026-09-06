// @aether/service-monetization — Billable Resource Registry, Metering, Rating,
// Entitlements, Invoicing (P1-MON-001). Doctrine 5 kernel application:
// every capability registers as a billable resource; rate plans (tiered,
// per-unit, % of GMV, min/caps) are bitemporal pack data; entitlements gate
// features at runtime (never hardcoded feature flags).

import type { Bitemporal } from '@aether/kernel-primitives';

export interface BillableResource {
  id: string;
  name: string;
  unit: string;
  meterEvent: string;
}

export interface RateTier {
  upTo: number | null;
  unitAmount: number;
}

export interface RateLine {
  resource: string; // billable resource NAME (or id)
  type: 'per-unit' | 'tiered' | 'percent-gmv' | 'flat';
  unitAmount?: number;
  tiers?: RateTier[];
  rate?: number; // for percent-gmv
  minPerPeriod?: number;
}

export interface RatePlan extends Bitemporal {
  id: string;
  name: string;
  periodicFee?: { amount: number; currency: string; period: string };
  rates: RateLine[];
  includedQuotas: Record<string, number | null>;
  grants: Record<string, boolean>; // feature entitlements
}

export interface MeterEvent {
  tenantId: string;
  resource: string; // billable resource name
  qty: number;
  at: string;
  metadata?: Record<string, unknown>;
}

export interface RatedLine {
  resource: string;
  qty: number;
  amount: number;
  explain: string[];
}

export interface Invoice {
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  planId: string;
  periodicFee: number;
  rated: RatedLine[];
  total: number;
  currency: string;
}

export interface Entitlement {
  tenantId: string;
  feature: string;
  granted: boolean;
  quotaRemaining?: number | null;
  source: 'plan' | 'addon' | 'default-free';
}

export class MonetizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MonetizationError';
  }
}

export class MonetizationService {
  private resources = new Map<string, BillableResource>();
  private plans = new Map<string, RatePlan>();
  private subscriptions = new Map<string, string>(); // tenantId -> planId
  private meters = new Map<string, MeterEvent[]>(); // `${tenant}:${resource}` -> events
  private extraGrants = new Map<string, Set<string>>(); // tenantId -> add-on feature grants

  constructor(pack: { billableResources: BillableResource[]; ratePlans: RatePlan[] }) {
    for (const r of pack.billableResources) this.resources.set(r.name, r);
    for (const p of pack.ratePlans) this.plans.set(p.id, p);
  }

  registerResource(r: BillableResource): void {
    this.resources.set(r.name, r);
  }

  subscribe(tenantId: string, planId: string): void {
    if (!this.plans.has(planId)) throw new MonetizationError(`Unknown plan "${planId}"`);
    this.subscriptions.set(tenantId, planId);
  }

  planFor(tenantId: string): RatePlan {
    const id = this.subscriptions.get(tenantId);
    if (!id) throw new MonetizationError(`Tenant ${tenantId} has no subscription — subscribe first`);
    return this.plans.get(id)!;
  }

  grantAddon(tenantId: string, feature: string): void {
    if (!this.extraGrants.has(tenantId)) this.extraGrants.set(tenantId, new Set());
    this.extraGrants.get(tenantId)!.add(feature);
  }

  /** meter a usage event (all platform capabilities emit these) */
  meter(evt: MeterEvent): void {
    const res = this.resources.get(evt.resource);
    if (!res) throw new MonetizationError(`Unknown billable resource "${evt.resource}" — register it first (pack data)`);
    const key = `${evt.tenantId}:${evt.resource}`;
    if (!this.meters.has(key)) this.meters.set(key, []);
    this.meters.get(key)!.push(evt);
  }

  usage(tenantId: string, resource: string): number {
    return (this.meters.get(`${tenantId}:${resource}`) ?? []).reduce((s, e) => s + e.qty, 0);
  }

  /** entitlement check — THE gate for all features (config-driven, never code flags) */
  entitlement(tenantId: string, feature: string): Entitlement {
    const addons = this.extraGrants.get(tenantId);
    if (addons?.has(feature)) return { tenantId, feature, granted: true, source: 'addon' };
    const plan = this.subscriptions.get(tenantId);
    if (plan) {
      const p = this.plans.get(plan)!;
      if (feature in p.grants) {
        const quota = p.includedQuotas[feature];
        return {
          tenantId, feature,
          granted: p.grants[feature]!,
          quotaRemaining: quota === null ? null : quota,
          source: 'plan',
        };
      }
    }
    // default-free floor: features not in any grant table are free (never accidentally paywalled)
    return { tenantId, feature, granted: true, source: 'default-free' };
  }

  rate(tenantId: string, resource: string, qty: number): RatedLine {
    const plan = this.planFor(tenantId);
    const line = plan.rates.find((r) => r.resource === resource || this.resources.get(r.resource)?.name === resource);
    if (!line) return { resource, qty, amount: 0, explain: [`${resource} not in plan ${plan.id} — 0`] };
    const included = plan.includedQuotas[resource];
    const billableQty = included === null || included === undefined ? qty : Math.max(0, qty - included);
    const explain = [`plan=${plan.id}`, `qty=${qty}`, included != null ? `included=${included}` : 'included=unlimited', `billableQty=${billableQty}`];
    if (billableQty === 0) {
      explain.push('within included quota');
      return { resource, qty, amount: 0, explain };
    }
    switch (line.type) {
      case 'per-unit': {
        const amount = Math.round(billableQty * (line.unitAmount ?? 0) * 10000) / 10000;
        explain.push(`per-unit ${line.unitAmount}/unit`);
        return { resource, qty, amount, explain };
      }
      case 'tiered': {
        let remaining = qty;
        let prevCap = included ?? 0;
        let amount = 0;
        for (const t of line.tiers ?? []) {
          const cap = t.upTo ?? Infinity;
          const inTier = Math.max(0, Math.min(qty, cap) - prevCap);
          amount += inTier * t.unitAmount;
          prevCap = cap;
          remaining -= inTier;
        }
        amount = Math.round(amount * 10000) / 10000;
        explain.push(`tiered across ${line.tiers?.length ?? 0} tiers`);
        return { resource, qty, amount, explain };
      }
      case 'percent-gmv': {
        const gmv = qty; // caller passes GMV value as qty for percent resources
        const amount = Math.max(line.minPerPeriod ?? 0, Math.round(gmv * (line.rate ?? 0) * 100) / 100);
        explain.push(`percent-gmv rate=${line.rate}${line.minPerPeriod ? ` min=${line.minPerPeriod}` : ''}`);
        return { resource, qty, amount, explain };
      }
      case 'flat':
        explain.push('flat');
        return { resource, qty, amount: line.unitAmount ?? 0, explain };
      default:
        return { resource, qty, amount: 0, explain: ['unknown rate type'] };
    }
  }

  /** invoice for period: periodic fee + all rated usage */
  invoice(tenantId: string, periodStart: string, periodEnd: string): Invoice {
    const plan = this.planFor(tenantId);
    const rated: RatedLine[] = [];
    for (const r of this.resources.values()) {
      const qty = this.usage(tenantId, r.name);
      if (qty === 0) continue;
      rated.push(this.rate(tenantId, r.name, qty));
    }
    const periodicFee = plan.periodicFee?.amount ?? 0;
    const usageTotal = Math.round(rated.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    return {
      tenantId, periodStart, periodEnd, planId: plan.id,
      periodicFee, rated,
      total: Math.round((periodicFee + usageTotal) * 100) / 100,
      currency: plan.periodicFee?.currency ?? 'USD',
    };
  }
}

// ---------- Module-as-a-Product contract (plug-and-play, billable, configurable) ----------
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';
import { readFileSync as __readFileSync } from 'node:fs';
import { join as __join, dirname as __dirname } from 'node:path';
import { fileURLToPath as __fileURLToPath } from 'node:url';

const monetizationModule: AetherModule = {
  manifest: JSON.parse(__readFileSync(__join(__dirname(__fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as { billableResources: BillableResource[]; ratePlans: RatePlan[] };
    const svc = new MonetizationService(pack);
    const meter = (ev: string) => billing.meter(ev);
    return {
      subscribe: (t: string, p: string) => svc.subscribe(t, p),
      meter: (e: MeterEvent) => (meter('usage.metered'), svc.meter(e)),
      rate: (t: string, r: string, q: number) => svc.rate(t, r, q),
      invoice: (t: string, ps: string, pe: string) => (meter('invoice.generated'), svc.invoice(t, ps, pe)),
      entitlement: (t: string, f: string) => svc.entitlement(t, f),
      usage: (t: string, r: string) => svc.usage(t, r),
      grantAddon: (t: string, f: string) => svc.grantAddon(t, f),
      __raw: svc,
    };
  },
};

export default monetizationModule;
