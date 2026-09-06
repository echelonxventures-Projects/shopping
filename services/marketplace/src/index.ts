// @aether/service-marketplace — seller onboarding (KYC/AML workflow), scorecards,
// enforcement ladder, payout reserves (P1-MKT-001). Kernel application: the
// onboarding state machine, scorecard weights/tiers, and reserve policies are
// ALL pack data. Tier effects (commission discounts, buy-box boosts) feed the
// Commission Engine and buy-box rules via outputs — no hardcoded seller logic.

import { WorkflowEngine } from '@aether/kernel-runtime/src/index.ts';
import type { WorkflowDef } from '@aether/kernel-primitives';

export interface SellerPack {
  workflows: WorkflowDef[];
  scorecard: {
    metrics: string[];
    weights: Record<string, number>;
    tiers: Array<{ name: string; minScore: number; effects: Record<string, number | boolean> }>;
  };
  policies: {
    rollingReservePct: Record<string, number>;
    maxListings: Record<string, number>;
  };
}

export interface Seller {
  sellerId: string;
  tenantId: string;
  status: string;
  metrics: Record<string, number>; // defect_rate, cancellation_rate, sla_adherence, fraud_flags
  tier?: string;
  onboardedAt?: string;
}

export interface OnboardingDecision {
  from: string;
  to: string;
  trigger: string;
  guards: Record<string, boolean>;
  at: string;
}

export class OnboardingError extends Error {
  constructor(sellerId: string, msg: string) {
    super(`Seller ${sellerId}: ${msg}`);
    this.name = 'OnboardingError';
  }
}

export class MarketplaceService {
  private wf: WorkflowEngine;
  private pack: SellerPack;
  private sellers = new Map<string, Seller>();

  constructor(pack: SellerPack) {
    this.pack = pack;
    this.wf = new WorkflowEngine(pack.workflows);
  }

  apply(tenantId: string, sellerId: string): Seller {
    const initial = this.wf.initial('seller-onboarding');
    if (!initial) throw new Error('seller-onboarding workflow missing from pack');
    const s: Seller = { sellerId, tenantId, status: initial, metrics: { defect_rate: 0, cancellation_rate: 0, sla_adherence: 1, fraud_flags: 0 } };
    this.sellers.set(`${tenantId}:${sellerId}`, s);
    return s;
  }

  get(tenantId: string, sellerId: string): Seller {
    const s = this.sellers.get(`${tenantId}:${sellerId}`);
    if (!s) throw new OnboardingError(sellerId, 'not found');
    return s;
  }

  /** workflow transition with guard facts (e.g. identity-verified from KYC provider adapter) */
  advance(tenantId: string, sellerId: string, to: string, trigger: string, guards: Record<string, boolean> = {}): OnboardingDecision {
    const s = this.get(tenantId, sellerId);
    const fact: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(guards)) fact[`guard:${k}`] = v;
    if (!this.wf.canTransition('seller-onboarding', s.status, to, fact)) {
      throw new OnboardingError(sellerId, `illegal transition ${s.status} → ${to}`);
    }
    s.status = to;
    if (to === 'approved') s.onboardedAt = new Date().toISOString();
    return { from: this.wf.def('seller-onboarding')!.name, to, trigger, guards, at: new Date().toISOString() };
  }

  /** scorecard: weighted metrics → tier (weights/tiers from pack) */
  score(tenantId: string, sellerId: string, overrides: Partial<Record<string, number>> = {}): { score: number; tier: string; effects: Record<string, number | boolean> } {
    const s = this.get(tenantId, sellerId);
    s.metrics = { ...s.metrics, ...overrides };
    // higher = worse for defect/cancellation/fraud; sla_adherence higher = better
    const w = this.pack.scorecard.weights;
    const score =
      (1 - (s.metrics['defect_rate'] ?? 0)) * (w['defect_rate'] ?? 0) +
      (1 - (s.metrics['cancellation_rate'] ?? 0)) * (w['cancellation_rate'] ?? 0) +
      (s.metrics['sla_adherence'] ?? 1) * (w['sla_adherence'] ?? 0) +
      (1 - Math.min(1, (s.metrics['fraud_flags'] ?? 0))) * (w['fraud_flags'] ?? 0);
    // highest qualifying tier wins (pack order is descending by minScore)
    const tier = this.pack.scorecard.tiers.find((t) => score >= t.minScore) ?? this.pack.scorecard.tiers[this.pack.scorecard.tiers.length - 1]!;
    s.tier = tier.name;
    return { score, tier: tier.name, effects: tier.effects };
  }

  /** enforcement ladder: recompute tier; suspension is a pack effect, not code */
  enforce(tenantId: string, sellerId: string): { action: string; tier: string } {
    const s = this.get(tenantId, sellerId);
    const { tier, effects } = this.score(tenantId, sellerId);
    if (effects['suspend'] === true && s.status === 'approved') {
      this.advance(tenantId, sellerId, 'suspended', 'enforcement-action');
      return { action: 'suspended', tier };
    }
    return { action: effects['commissionDiscount'] ? `commission-discount:${effects['commissionDiscount']}` : 'none', tier };
  }

  /** rolling reserve % by tier (pack policy) */
  rollingReservePct(tenantId: string, sellerId: string): number {
    const s = this.get(tenantId, sellerId);
    const tier = s.tier ?? 'standard';
    return this.pack.policies.rollingReservePct[tier] ?? 0;
  }

  maxListings(tenantId: string, sellerId: string): number {
    const s = this.get(tenantId, sellerId);
    const tier = s.tier ?? 'standard';
    return this.pack.policies.maxListings[tier] ?? 0;
  }

  /** commission-adjusted rate input for the Commission Engine (tier effect as data) */
  commissionAdjust(tenantId: string, sellerId: string): number {
    const { effects } = this.score(tenantId, sellerId);
    return Number(effects['commissionDiscount'] ?? 0);
  }
}
