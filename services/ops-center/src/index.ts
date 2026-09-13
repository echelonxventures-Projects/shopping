// @aether/service-ops-center — chaos drills + runbooks-as-data + FinOps
// attribution (P3-SCL-004, PX-OPS-001, PX-FIN-001). Module-as-a-Product:
// drills are pack SCENARIOS executed against a host-provided harness (Total
// Agnosticism: the fault injector is an adapter, sim or real); runbooks are
// GENERATED from the live product registry so every product has one and none
// can drift; FinOps multiplies metered usage by a pack cost table into
// per-tenant unit economics. Operations derive from data, not tribal memory.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';
import { ProductRegistry, defaultServicesDir } from '@aether/kernel-product-registry/src/index.ts';

// ---------- pack shapes ----------
export interface DrillInvariant {
  check: string;
  expect?: unknown;
  expectMax?: number;
}

export interface DrillDef {
  id: string;
  name: string;
  fault: { kind: string; target: string; multiplier?: number };
  blastRadius: string;
  invariants: DrillInvariant[];
  rollback: string[];
}

export interface OpsPack {
  pack: { name: string };
  drills: DrillDef[];
  drillPolicy: { requiredCadenceDays: number; breakGlassApprovers: number; abortOnInvariantBreach: boolean };
  runbookTemplate: {
    sections: string[];
    commonFailures: Array<{ symptom: string; firstMove: string }>;
    escalation: Record<string, string>;
  };
  onCallPolicy: { rotationDays: number; ackMinutes: number; pageEscalationMinutes: number };
  finops: {
    resourceCosts: Array<{ resource: string; unitCostMicros: number }>;
    currency: string;
    marginTargetPct: number;
  };
}

// ---------- drill harness (host adapter — sim or real cluster) ----------
export interface DrillHarness {
  inject(fault: DrillDef['fault']): void;
  measure(check: string): unknown | Promise<unknown>; // real-cluster probes may be async
  executeRollbackStep(step: string): boolean | Promise<boolean>;
}

export interface DrillResult {
  drillId: string;
  passed: boolean;
  aborted: boolean;
  invariantResults: Array<{ check: string; observed: unknown; passed: boolean }>;
  rollbackVerified: boolean;
  rollbackSteps: Array<{ step: string; ok: boolean }>;
}

export interface Runbook {
  productId: string;
  displayName: string;
  sections: Record<string, unknown>;
}

export interface UsageEvent {
  tenantId: string;
  resource: string;
  qty: number;
}

export class OpsCenterService {
  private pack: OpsPack;
  private registry: ProductRegistry;

  constructor(pack: OpsPack, servicesDir = defaultServicesDir) {
    this.pack = pack;
    this.registry = new ProductRegistry();
    this.registry.scanDirectory(servicesDir);
  }

  listDrills(): DrillDef[] {
    return this.pack.drills;
  }

  /** execute a chaos drill scenario against a harness; verify invariants + rollback */
  async runDrill(drillId: string, harness: DrillHarness): Promise<DrillResult> {
    const drill = this.pack.drills.find((d) => d.id === drillId);
    if (!drill) throw new Error(`unknown drill ${drillId} — drills are pack data, add it there`);
    harness.inject(drill.fault);

    const invariantResults: DrillResult['invariantResults'] = [];
    let aborted = false;
    for (const inv of drill.invariants) {
      const observed = await harness.measure(inv.check);
      const passed =
        inv.expectMax !== undefined ? typeof observed === 'number' && observed <= inv.expectMax : observed === inv.expect;
      invariantResults.push({ check: inv.check, observed, passed });
      if (!passed && this.pack.drillPolicy.abortOnInvariantBreach) {
        aborted = true;
        break;
      }
    }

    // rollback ALWAYS runs (that is the point of a game day)
    const rollbackSteps: Array<{ step: string; ok: boolean }> = [];
    for (const step of drill.rollback) rollbackSteps.push({ step, ok: await harness.executeRollbackStep(step) });
    const rollbackVerified = rollbackSteps.every((s) => s.ok);
    return {
      drillId,
      passed: !aborted && invariantResults.every((r) => r.passed) && rollbackVerified,
      aborted,
      invariantResults,
      rollbackVerified,
      rollbackSteps,
    };
  }

  /** runbook GENERATED from the live product listing — every product gets one, none drift */
  runbookFor(productId: string): Runbook {
    const p = this.registry.get(productId);
    if (!p) throw new Error(`no product ${productId} in registry`);
    const t = this.pack.runbookTemplate;
    const sections: Record<string, unknown> = {};
    for (const s of t.sections) {
      if (s === 'overview') sections[s] = `${p.displayName} v${p.version} — ${p.description}`;
      else if (s === 'capabilities') sections[s] = p.capabilities;
      else if (s === 'public-api') sections[s] = p.apiSurface;
      else if (s === 'meterable-signals') sections[s] = p.offer.meterableResources;
      else if (s === 'packs-to-check') sections[s] = p.bundledPacks;
      else if (s === 'common-failures') sections[s] = t.commonFailures;
      else if (s === 'escalation') sections[s] = t.escalation;
    }
    return { productId: p.productId, displayName: p.displayName, sections };
  }

  /** one runbook per registered product — coverage is total by construction */
  allRunbooks(): Runbook[] {
    return this.registry.list().map((p) => this.runbookFor(p.productId));
  }

  /** FinOps: metered usage × pack cost table → per-tenant cost (micros) */
  attribute(events: UsageEvent[]): Map<string, { costMicros: number; byResource: Record<string, number> }> {
    const rates = new Map(this.pack.finops.resourceCosts.map((r) => [r.resource, r.unitCostMicros]));
    const out = new Map<string, { costMicros: number; byResource: Record<string, number> }>();
    for (const e of events) {
      const rate = rates.get(e.resource);
      if (rate === undefined) throw new Error(`no cost rate for resource '${e.resource}' — add it to the finops pack`);
      const cost = e.qty * rate;
      const t = out.get(e.tenantId) ?? { costMicros: 0, byResource: {} };
      t.costMicros += cost;
      t.byResource[e.resource] = (t.byResource[e.resource] ?? 0) + cost;
      out.set(e.tenantId, t);
    }
    return out;
  }

  /** unit economics: revenue vs attributed cost vs pack margin target */
  tenantUnitEconomics(tenantId: string, events: UsageEvent[], revenueMicros: number): { tenantId: string; costMicros: number; revenueMicros: number; marginPct: number; meetsTarget: boolean } {
    const attributed = this.attribute(events.filter((e) => e.tenantId === tenantId)).get(tenantId);
    const costMicros = attributed?.costMicros ?? 0;
    const marginPct = revenueMicros === 0 ? -100 : Math.round(((revenueMicros - costMicros) / revenueMicros) * 10000) / 100;
    return { tenantId, costMicros, revenueMicros, marginPct, meetsTarget: marginPct >= this.pack.finops.marginTargetPct };
  }
}

// ---------- Module-as-a-Product contract ----------
const opsCenterModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as OpsPack;
    const svc = new OpsCenterService(pack);
    const meter = (ev: string) => billing.meter(ev, 1);
    return {
      runDrill: (id: string, h: DrillHarness) => (meter('ops.drill.executed'), svc.runDrill(id, h)),
      listDrills: () => svc.listDrills(),
      runbookFor: (id: string) => (meter('ops.runbook.generated'), svc.runbookFor(id)),
      allRunbooks: () => svc.allRunbooks(),
      attribute: (ev: UsageEvent[]) => (meter('ops.finops.attributed'), svc.attribute(ev)),
      tenantUnitEconomics: (t: string, ev: UsageEvent[], rev: number) => svc.tenantUnitEconomics(t, ev, rev),
      __raw: svc,
    };
  },
};

export default opsCenterModule;
