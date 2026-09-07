// @aether/service-b2b — RFQ/quotes, PO approval chains, net-terms credit,
// contract pricing tiers (P1-B2B). Module-as-a-Product: workflows, thresholds,
// credit grades, volume discounts are ALL pack data.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkflowEngine } from '@aether/kernel-runtime/src/index.ts';
import type { WorkflowDef } from '@aether/kernel-primitives';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface B2BPack {
  workflows: WorkflowDef[];
  approvalThresholds: { managerLimit: number; financeLimit: number };
  netTerms: {
    grades: Array<{ grade: string; creditScoreMin: number; interestFreeDays: number }>;
    defaultGrade: string;
  };
  contractPricing: Array<{ tier: string; minAnnualVolume: number; discountPct: number }>;
  quoteValidityDays: number;
}

export interface Quote {
  quoteId: string;
  tenantId: string;
  buyerOrgId: string;
  sellerId: string;
  items: Array<{ productId: string; qty: number; unitPrice: number }>;
  status: string;
  total: number;
  discountPct: number;
  validUntil: string;
  createdAt: string;
}

export interface PurchaseOrder {
  poId: string;
  tenantId: string;
  buyerOrgId: string;
  quoteId?: string;
  amount: number;
  status: string;
  netTermGrade: string;
  approvalTrail: Array<{ at: string; from: string; to: string; trigger: string; approver?: string }>;
}

export class B2BService {
  private quoteWf: WorkflowEngine;
  private poWf: WorkflowEngine;
  private pack: B2BPack;
  private quotes = new Map<string, Quote>();
  private pos = new Map<string, PurchaseOrder>();
  private seq = 0;

  constructor(pack: B2BPack) {
    this.pack = pack;
    this.quoteWf = new WorkflowEngine(pack.workflows.filter((w) => w.name === 'quote-lifecycle'));
    this.poWf = new WorkflowEngine(pack.workflows.filter((w) => w.name === 'po-approval'));
  }

  // ---- quotes (RFQ) ----
  requestQuote(tenantId: string, buyerOrgId: string, sellerId: string, items: Array<{ productId: string; qty: number; unitPrice: number }>, buyerAnnualVolume = 0): Quote {
    const initial = this.quoteWf.initial('quote-lifecycle') ?? 'requested';
    const discountPct = this.contractDiscount(buyerAnnualVolume);
    const total = Math.round(items.reduce((s, i) => s + i.qty * i.unitPrice, 0) * (1 - discountPct / 100) * 100) / 100;
    const q: Quote = {
      quoteId: `qt-${++this.seq}`, tenantId, buyerOrgId, sellerId, items,
      status: initial, total, discountPct,
      validUntil: new Date(Date.now() + this.pack.quoteValidityDays * 86_400_000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    this.quotes.set(`${tenantId}:${q.quoteId}`, q);
    return q;
  }

  /** volume-tier discount from pack contract pricing */
  contractDiscount(annualVolume: number): number {
    const eligible = this.pack.contractPricing.filter((t) => annualVolume >= t.minAnnualVolume);
    return eligible.length ? eligible[eligible.length - 1]!.discountPct : 0;
  }

  quoteTransition(tenantId: string, quoteId: string, to: string, trigger: string): Quote {
    const q = this.getQuote(tenantId, quoteId);
    if (!this.quoteWf.canTransition('quote-lifecycle', q.status, to)) {
      throw new Error(`illegal quote transition ${q.status} → ${to}`);
    }
    q.status = to;
    return q;
  }

  getQuote(tenantId: string, quoteId: string): Quote {
    const q = this.quotes.get(`${tenantId}:${quoteId}`);
    if (!q) throw new Error(`quote ${quoteId} not found`);
    return q;
  }

  // ---- net terms (credit grades from pack) ----
  netTermGrade(creditScore: number): string {
    const eligible = this.pack.netTerms.grades.filter((g) => creditScore >= g.creditScoreMin);
    return eligible.length ? eligible[0]!.grade : this.pack.netTerms.defaultGrade;
  }

  // ---- purchase orders + approval chain ----
  submitPo(tenantId: string, buyerOrgId: string, amount: number, creditScore: number, quoteId?: string): PurchaseOrder {
    const initial = this.poWf.initial('po-approval') ?? 'submitted';
    const po: PurchaseOrder = {
      poId: `po-${++this.seq}`, tenantId, buyerOrgId, quoteId, amount,
      status: initial, netTermGrade: this.netTermGrade(creditScore),
      approvalTrail: [],
    };
    this.pos.set(`${tenantId}:${po.poId}`, po);
    this.poAdvance(tenantId, po.poId, 'manager-review', 'auto-route');
    return po;
  }

  poAdvance(tenantId: string, poId: string, to: string, trigger: string, approver?: string): PurchaseOrder {
    const po = this.getPo(tenantId, poId);
    // guards from pack: amounts over the manager limit MUST route through finance;
    // amounts within it may be approved by the manager directly
    const fact = {
      'guard:amount-over-manager-limit': po.amount > this.pack.approvalThresholds.managerLimit,
      'guard:amount-within-manager-limit': po.amount <= this.pack.approvalThresholds.managerLimit,
    };
    if (!this.poWf.canTransition('po-approval', po.status, to, fact)) {
      throw new Error(`illegal PO transition ${po.status} → ${to} (amount=${po.amount}, managerLimit=${this.pack.approvalThresholds.managerLimit})`);
    }
    if (po.amount > this.pack.approvalThresholds.financeLimit) {
      throw new Error(`PO ${poId} amount ${po.amount} exceeds finance limit ${this.pack.approvalThresholds.financeLimit} — requires procurement committee (pack policy)`);
    }
    po.approvalTrail.push({ at: new Date().toISOString(), from: po.status, to, trigger, approver });
    po.status = to;
    return po;
  }

  getPo(tenantId: string, poId: string): PurchaseOrder {
    const p = this.pos.get(`${tenantId}:${poId}`);
    if (!p) throw new Error(`PO ${poId} not found`);
    return p;
  }
}

const b2bModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as B2BPack;
    const svc = new B2BService(pack);
    const meter = (ev: string) => billing.meter(ev);
    return {
      requestQuote: (t: string, b: string, s: string, i: Array<{ productId: string; qty: number; unitPrice: number }>, v?: number) => (meter('quote.requested'), svc.requestQuote(t, b, s, i, v)),
      contractDiscount: (v: number) => svc.contractDiscount(v),
      quoteTransition: (t: string, q: string, to: string, trig: string) => (meter('quote.transitioned'), svc.quoteTransition(t, q, to, trig)),
      getQuote: (t: string, q: string) => svc.getQuote(t, q),
      netTermGrade: (c: number) => svc.netTermGrade(c),
      submitPo: (t: string, b: string, a: number, c: number, q?: string) => (meter('po.submitted'), svc.submitPo(t, b, a, c, q)),
      poAdvance: (t: string, p: string, to: string, trig: string, ap?: string) => svc.poAdvance(t, p, to, trig, ap),
      getPo: (t: string, p: string) => svc.getPo(t, p),
      __raw: svc,
    };
  },
};

export default b2bModule;
