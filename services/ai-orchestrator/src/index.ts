// @aether/service-ai-orchestrator — AI tool routing as CONFIG (Doctrine 1 + 5).
// Priority law, expressed in pack data: ALWAYS-FREE providers first; paid
// models unlock only for paying customers (billing-tier entitlement). Every
// variable — providers/prices/quality, per-task capability needs, routing
// directives per task/tenant/tier/customer, budgets + degrade-vs-reject,
// fallback chains, markup tiers, KMS credential POINTERS — is pack data,
// bitemporal (price changes reconstruct at any T). Model adapters are
// host-injected ports (Total Agnosticism): this kernel application never
// imports a provider SDK.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';
import type { RuleDef } from '@aether/kernel-primitives';
import { isCurrent } from '@aether/kernel-primitives';
import { RuleEngine, ruleDefToEvaluatable } from '@aether/kernel-runtime';

// ---------- pack shapes ----------
export interface ProviderDef {
  id: string;
  kind: string;
  freeTier: boolean;
  unitCosts: Record<string, number>; // per unit ('1k-tokens' | 'image' | …)
  quality: Record<string, number>; // per task + 'default'
  capabilities: string[];
  credentialRef: string | null; // KMS/Vault POINTER — never a secret
  rateLimitRpm: number;
  validFrom: string;
  validTo: string | null;
  recordedAt: string;
}

export interface TaskDef {
  id: string;
  requires: string[];
  unit: string;
  defaultUnits: number;
}

export interface AiOrchestratorPack {
  pack: { name: string; version: string };
  providers: ProviderDef[];
  tasks: TaskDef[];
  routingRules: RuleDef[];
  billingTiers: Record<string, { allowsPaidModels: boolean; markupPct: number; platformAbsorbs: boolean }>;
  fallback: { onRateLimit: string; maxCandidates: number; retryPerCandidate: number };
  attribution: { billToCustomerTasks: string[]; platformTasks: string[] };
}

export interface RouteContext {
  tenantId: string;
  customerTier: 'free' | 'growth' | 'enterprise';
  customerId?: string;
}

export interface RouteCandidate {
  providerId: string;
  model: string; // provider class is the model family — adapter maps it
  unitCostUsd: number;
  unit: string;
  quality: number;
  freeTier: boolean;
  credentialRef: string | null;
}

export interface RouteDecision {
  task: string;
  candidates: RouteCandidate[];
  primary: RouteCandidate;
  directive: Record<string, unknown>;
  degraded: boolean;
  estimatedCostUsd: number;
  estimatedBillableUsd: number;
  atTime: string;
}

export interface ModelAdapter {
  name: string;
  complete(candidate: RouteCandidate, task: string, input: string): Promise<{ output: string; units: number }>;
}

export interface UsageEntry {
  tenantId: string;
  task: string;
  providerId: string;
  units: number;
  costUsd: number;
  billableUsd: number;
  absorbedUsd: number;
  at: string;
}

export class AiBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiBudgetError';
  }
}

const round = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

export class AiOrchestratorService {
  private pack: AiOrchestratorPack;
  private rules: RuleEngine;
  private usage: UsageEntry[] = [];
  private spend = new Map<string, { period: string; usd: number }>(); // tenant → month window

  constructor(pack: AiOrchestratorPack) {
    this.pack = pack;
    this.rules = new RuleEngine(pack.routingRules.map(ruleDefToEvaluatable));
  }

  /** list providers valid at T (bitemporal: price/quality changes reconstruct at any time) */
  providers(at?: string): ProviderDef[] {
    const now = at ?? new Date().toISOString();
    return this.pack.providers.filter((p) => isCurrent(p as never, now));
  }

  billingTierOf(tier: string): { allowsPaidModels: boolean; markupPct: number; platformAbsorbs: boolean } | undefined {
    return this.pack.billingTiers[tier];
  }

  private directive(task: string, ctx: RouteContext, at: string): Record<string, unknown> {
    const hits = this.rules.evaluateAll(
      { fact: 'ai-route', task, tier: ctx.customerTier, tenant: ctx.tenantId, customerId: ctx.customerId ?? null },
      at
    );
    // merge priority ASC so the highest-priority rule's outputs win on conflict
    const merged: Record<string, unknown> = { allowPaid: false, prefer: 'cost', budgetUsdMonthly: 5, budgetAction: 'degrade' };
    for (const h of [...hits].sort((a, b) => a.priority - b.priority)) Object.assign(merged, h.outputs);
    // billing tier is the constitutional gate: free tier NEVER allows paid models
    const tierDef = this.pack.billingTiers[ctx.customerTier];
    if (!tierDef?.allowsPaidModels) merged['allowPaid'] = false;
    return merged;
  }

  /** routing decision: free-first ordering, capability match, entitlement gate, budget guard */
  select(task: string, ctx: RouteContext, at?: string): RouteDecision {
    const now = at ?? new Date().toISOString();
    const taskDef = this.pack.tasks.find((t) => t.id === task);
    if (!taskDef) throw new Error(`unknown AI task "${task}" — register it in the pack (data, not code)`);
    const dir = this.directive(task, ctx, now);
    const allowPaid = dir['allowPaid'] === true;
    const preferQuality = dir['prefer'] === 'quality';
    const unit = taskDef.unit;

    let candidates = this.providers(now)
      .filter((p) => taskDef.requires.every((c) => p.capabilities.includes(c)))
      .filter((p) => allowPaid || p.freeTier) // THE free-first law: non-paying never touches paid
      .map((p): RouteCandidate => ({
        providerId: p.id,
        model: p.id,
        unitCostUsd: p.unitCosts[unit] ?? 0,
        unit,
        quality: p.quality[task] ?? p.quality['default'] ?? 0,
        freeTier: p.freeTier,
        credentialRef: p.credentialRef,
      }))
      .sort((a, b) =>
        preferQuality
          ? b.quality - a.quality || a.unitCostUsd - b.unitCostUsd
          : a.unitCostUsd - b.unitCostUsd || b.quality - a.quality
      )
      .slice(0, this.pack.fallback.maxCandidates);

    if (candidates.length === 0) throw new Error(`no AI provider can serve task "${task}" under tier "${ctx.customerTier}" — add one to the pack`);

    const estimatedCostUsd = round(taskDef.defaultUnits * (candidates[0]?.unitCostUsd ?? 0));
    let degraded = false;
    // budget guard: when projected spend exceeds the monthly budget → degrade to free or reject (config)
    const remaining = this.remainingBudget(ctx, dir);
    if (estimatedCostUsd > remaining) {
      if (dir['budgetAction'] === 'reject') throw new AiBudgetError(`tenant ${ctx.tenantId} budget exhausted (remaining ${round(remaining)})`);
      const freeOnly = candidates.filter((c) => c.freeTier);
      if (freeOnly.length === 0) throw new AiBudgetError(`budget exhausted and no free fallback configured`);
      candidates = freeOnly;
      degraded = true;
    }

    const tierDef = this.pack.billingTiers[ctx.customerTier]!;
    const cost = round(estimatedCostUsd);
    return {
      task,
      candidates,
      primary: candidates[0]!,
      directive: dir,
      degraded,
      estimatedCostUsd: cost,
      estimatedBillableUsd: round(tierDef.platformAbsorbs ? 0 : cost * (1 + tierDef.markupPct / 100)),
      atTime: now,
    };
  }

  private remainingBudget(ctx: RouteContext, dir: Record<string, unknown>): number {
    const budget = Number(dir['budgetUsdMonthly'] ?? 0);
    if (budget <= 0) return Number.POSITIVE_INFINITY;
    const month = new Date().toISOString().slice(0, 7);
    const s = this.spend.get(ctx.tenantId);
    const used = s && s.period === month ? s.usd : 0;
    return budget - used;
  }

  estimate(task: string, ctx: RouteContext, at?: string): { costUsd: number; billableUsd: number } {
    const d = this.select(task, ctx, at);
    return { costUsd: d.estimatedCostUsd, billableUsd: d.estimatedBillableUsd };
  }

  /** execute through a host-injected adapter; falls back along the chain on rate limits */
  async execute(task: string, ctx: RouteContext, input: string, adapter: ModelAdapter, at?: string): Promise<RouteDecision & { output: string; units: number; costUsd: number; billableUsd: number; absorbedUsd: number; usedFallback: boolean }> {
    const decision = this.select(task, ctx, at);
    let lastErr: Error | null = null;
    for (let i = 0; i < decision.candidates.length; i++) {
      const c = decision.candidates[i]!;
      for (let r = 0; r < this.pack.fallback.retryPerCandidate; r++) {
        try {
          const res = await adapter.complete(c, task, input);
          const costUsd = round(res.units * c.unitCostUsd);
          const tierDef = this.pack.billingTiers[ctx.customerTier]!;
          const billableUsd = round(tierDef.platformAbsorbs ? 0 : costUsd * (1 + tierDef.markupPct / 100));
          const absorbedUsd = tierDef.platformAbsorbs ? costUsd : 0;
          const entry: UsageEntry = {
            tenantId: ctx.tenantId,
            task,
            providerId: c.providerId,
            units: res.units,
            costUsd,
            billableUsd,
            absorbedUsd: tierDef.platformAbsorbs ? costUsd : 0,
            at: new Date().toISOString(),
          };
          this.usage.push(entry);
          const month = new Date().toISOString().slice(0, 7);
          const prev = this.spend.get(ctx.tenantId);
          this.spend.set(ctx.tenantId, { period: month, usd: (prev?.period === month ? prev.usd : 0) + costUsd });
          return { ...decision, primary: c, output: res.output, units: res.units, costUsd, billableUsd, absorbedUsd, usedFallback: i > 0 };
        } catch (err) {
          lastErr = err as Error;
          const rateLimited = /rate.?limit/i.test(lastErr.message);
          if (!rateLimited) break; // non-rate errors don't retry the same candidate
        }
      }
      // onRateLimit: next-in-chain (pack policy) — loop continues to next candidate
    }
    throw new AiBudgetError(`all AI candidates failed for ${task} (provider ${decision.candidates.map((c) => c.providerId).join(', ')}): ${lastErr?.message ?? 'unknown'}`);
  }

  /** tenant usage report: raw cost, billable (markup), absorbed (platform) */
  usageReport(tenantId: string): { entries: UsageEntry[]; totals: { costUsd: number; billableUsd: number; absorbedUsd: number } } {
    const entries = this.usage.filter((u) => u.tenantId === tenantId);
    return {
      entries,
      totals: {
        costUsd: round(entries.reduce((s, e) => s + e.costUsd, 0)),
        billableUsd: round(entries.reduce((s, e) => s + e.billableUsd, 0)),
        absorbedUsd: round(entries.reduce((s, e) => s + e.absorbedUsd, 0)),
      },
    };
  }
}

// ---------- Module-as-a-Product contract ----------
const aiOrchestratorModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as AiOrchestratorPack;
    const svc = new AiOrchestratorService(pack);
    const meter = (ev: string) => billing.meter(ev, 1);
    return {
      select: (t: string, ctx: RouteContext, at?: string) => (meter('ai.route.selected'), svc.select(t, ctx, at)),
      execute: (t: string, ctx: RouteContext, input: string, adapter: ModelAdapter, at?: string) =>
        (meter('ai.task.executed'), svc.execute(t, ctx, input, adapter, at).then((r) => (meter('ai.usage.metered'), r))),
      estimate: (t: string, ctx: RouteContext, at?: string) => svc.estimate(t, ctx, at),
      usageReport: (tenantId: string) => svc.usageReport(tenantId),
      providers: (at?: string) => svc.providers(at),
      billingTierOf: (tier: string) => svc.billingTierOf(tier),
      __raw: svc,
    };
  },
};

export default aiOrchestratorModule;
