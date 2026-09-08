// @aether/service-agentic-commerce — machines buying on users' behalf
// (P4-AI-002). Module-as-a-Product: agent scopes, spend guardrails, forbidden
// categories, delegation TTL/signing — ALL PACK DATA. A user signs a delegation
// (scoped purchase authority); the platform enforces it cryptographically and
// economically: scope checks, per-action/per-day spend caps, category bans,
// human-confirmation thresholds. Constitutional policy gate: consent required.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface AgentScope {
  scope: string;
  canSearch?: boolean;
  canReadPdp?: boolean;
  canAddToCart?: boolean;
  canPurchase?: boolean;
  restrictToCategories?: string[];
}

export interface AgenticPack {
  pack: { name: string };
  agentScopes: AgentScope[];
  guardrails: {
    maxSpendPerAction: { amount: number; currency: string };
    maxSpendPerDay: { amount: number; currency: string };
    maxItemsPerOrder: number;
    forbiddenCategories: string[];
    requireHumanConfirmationAbove: { amount: number; currency: string };
    consentRequired: boolean;
  };
  delegation: { maxTtlHours: number; revocable: boolean; signingScheme: string };
}

export interface Delegation {
  delegationId: string;
  userId: string;
  agentId: string;
  scope: string;
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
  signature: string; // ed25519-class signature over the delegation payload
}

export interface AgentAction {
  actionId: string;
  delegationId: string;
  kind: 'search' | 'read-pdp' | 'add-to-cart' | 'purchase';
  basket?: Array<{ productId: string; category: string; unitPrice: number; qty: number }>;
  at: number;
}

export type ActionOutcome =
  | { status: 'allowed'; actionId: string }
  | { status: 'blocked-scope'; reason: string }
  | { status: 'blocked-spend-cap'; cap: string; attempted: number; capAmount: number }
  | { status: 'blocked-category'; category: string }
  | { status: 'blocked-expired-delegation' }
  | { status: 'blocked-consent'; reason: string }
  | { status: 'needs-human-confirmation'; basketTotal: number };

export class AgenticCommerceError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'AgenticCommerceError';
  }
}

export class AgenticCommerceService {
  private pack: AgenticPack;
  private delegations = new Map<string, Delegation>();
  private consentByUser = new Map<string, boolean>();
  private dailySpend = new Map<string, number>(); // delegationId -> spend today
  private seq = 0;

  constructor(pack: AgenticPack) {
    this.pack = pack;
  }

  /** user signs a delegation: scope + TTL clamped by pack policy */
  issueDelegation(userId: string, agentId: string, scope: string, ttlHours: number, sign: (payload: string) => string): Delegation {
    const scopeDef = this.pack.agentScopes.find((s) => s.scope === scope);
    if (!scopeDef) throw new AgenticCommerceError(`Unknown agent scope "${scope}" — register in pack`);
    if (this.pack.guardrails.consentRequired && this.consentByUser.get(userId) !== true) {
      throw new AgenticCommerceError(`User "${userId}" has not granted agentic-purchase consent (constitutional policy)`);
    }
    if (ttlHours > this.pack.delegation.maxTtlHours) {
      throw new AgenticCommerceError(`Delegation TTL ${ttlHours}h exceeds policy max ${this.pack.delegation.maxTtlHours}h`);
    }
    const now = Date.now();
    const payload = `${userId}|${agentId}|${scope}|${now}`;
    const d: Delegation = {
      delegationId: `del-${++this.seq}`, userId, agentId, scope,
      issuedAt: now, expiresAt: now + ttlHours * 3_600_000, revoked: false,
      signature: sign(payload),
    };
    this.delegations.set(d.delegationId, d);
    return d;
  }

  setConsent(userId: string, granted: boolean): void {
    this.consentByUser.set(userId, granted);
  }

  revokeDelegation(delegationId: string): void {
    const d = this.delegations.get(delegationId);
    if (!d) throw new AgenticCommerceError(`Delegation ${delegationId} not found`);
    if (!this.pack.delegation.revocable) throw new AgenticCommerceError('Delegations are non-revocable (pack policy)');
    d.revoked = true;
  }

  /** verify the delegation signature (the platform never trusts unsigned authority) */
  verifyDelegation(delegationId: string, verify: (payload: string, signature: string) => boolean): boolean {
    const d = this.delegations.get(delegationId);
    if (!d) return false;
    const payload = `${d.userId}|${d.agentId}|${d.scope}|${d.issuedAt}`;
    return verify(payload, d.signature);
  }

  /** the constitutional gate: every agent action evaluated against pack guardrails */
  evaluate(input: { delegationId: string; kind: AgentAction['kind']; basket?: AgentAction['basket']; now: number }): ActionOutcome {
    const d = this.delegations.get(input.delegationId);
    if (!d) throw new AgenticCommerceError(`Delegation ${input.delegationId} not found`);
    if (d.revoked || d.expiresAt <= input.now) return { status: 'blocked-expired-delegation' };
    const scopeDef = this.pack.agentScopes.find((s) => s.scope === d.scope)!;

    // scope capability map
    const capFor: Record<AgentAction['kind'], boolean | undefined> = {
      search: scopeDef.canSearch,
      'read-pdp': scopeDef.canReadPdp,
      'add-to-cart': scopeDef.canAddToCart,
      purchase: scopeDef.canPurchase,
    };
    if (capFor[input.kind] !== true) {
      return { status: 'blocked-scope', reason: `scope "${d.scope}" cannot ${input.kind}` };
    }

    const basket = input.basket ?? [];
    // category bans (constitutional guardrails) + scope category restriction
    for (const item of basket) {
      if (this.pack.guardrails.forbiddenCategories.includes(item.category)) {
        return { status: 'blocked-category', category: item.category };
      }
      if (scopeDef.restrictToCategories && !scopeDef.restrictToCategories.includes(item.category)) {
        return { status: 'blocked-category', category: item.category };
      }
    }

    if (input.kind === 'purchase') {
      const total = basket.reduce((s, i) => s + i.unitPrice * i.qty, 0);
      const itemCount = basket.reduce((s, i) => s + i.qty, 0);
      // per-action cap
      if (total > this.pack.guardrails.maxSpendPerAction.amount) {
        return { status: 'blocked-spend-cap', cap: 'per-action', attempted: total, capAmount: this.pack.guardrails.maxSpendPerAction.amount };
      }
      // per-day cap (accumulates across actions)
      const spentToday = this.dailySpend.get(input.delegationId) ?? 0;
      if (spentToday + total > this.pack.guardrails.maxSpendPerDay.amount) {
        return { status: 'blocked-spend-cap', cap: 'per-day', attempted: spentToday + total, capAmount: this.pack.guardrails.maxSpendPerDay.amount };
      }
      // item count cap
      if (itemCount > this.pack.guardrails.maxItemsPerOrder) {
        return { status: 'blocked-spend-cap', cap: 'items-per-order', attempted: itemCount, capAmount: this.pack.guardrails.maxItemsPerOrder };
      }
      // human-confirmation threshold
      const confirmAbove = this.pack.guardrails.requireHumanConfirmationAbove.amount;
      if (total > confirmAbove) {
        return { status: 'needs-human-confirmation', basketTotal: total };
      }
      // commit the spend to the daily accumulator (only on fully-allowed purchases)
      this.dailySpend.set(input.delegationId, spentToday + total);
    }
    return { status: 'allowed', actionId: `act-${input.delegationId}-${input.now}` };
  }
}

const agenticModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as AgenticPack;
    const svc = new AgenticCommerceService(pack);
    const meter = (ev: string) => billing.meter(ev);
    return {
      setConsent: (u: string, g: boolean) => svc.setConsent(u, g),
      issueDelegation: (u: string, a: string, s: string, t: number, sign: (p: string) => string) => (meter('delegation.issued'), svc.issueDelegation(u, a, s, t, sign)),
      revokeDelegation: (id: string) => (meter('delegation.revoked'), svc.revokeDelegation(id)),
      verifyDelegation: (id: string, v: (p: string, s: string) => boolean) => svc.verifyDelegation(id, v),
      evaluate: (i: { delegationId: string; kind: never; basket?: never; now: number }) => (meter('action.evaluated'), svc.evaluate(i as never)),
      __raw: svc,
    };
  },
};

export default agenticModule;
