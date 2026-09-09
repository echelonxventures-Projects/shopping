// @aether/service-pricing — bitemporal price lists + market matrices +
// promotions + bundles + B2B tiers + ML-price guardrails (P1-PRC-001/002,
// P4-AI-003 guardrail leg). Module-as-a-Product: every price list, promo,
// stacking policy, tier ladder, and guardrail bound is PACK DATA. Markets are
// matrix dimension values (arrays of {market: ...}), never code branches.
// Bitemporal law: a price at any historical transaction time T is exactly
// reconstructable — amendments are new rows, never mutations.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

// ---------- pack shapes ----------
export interface PriceMatrixCell {
  market: string;
  currency: string;
  amount: number;
  [dim: string]: unknown; // unlimited dimensions (channel, audience, region, ...)
}

export interface PriceList {
  id: string;
  name: string;
  priority: number;
  validFrom: string;
  validTo: string | null;
  recordedAt: string;
  entries: Array<{ sku: string; matrix: PriceMatrixCell[] }>;
}

export interface Promotion {
  id: string;
  name: string;
  kind: 'percent-off' | 'amount-off';
  value: number;
  stacking: 'stackable' | 'exclusive';
  priority: number;
  conditions: Array<{ field: string; equals?: unknown; in?: unknown[] }>;
  validFrom: string;
  validTo: string | null;
  recordedAt: string;
}

export interface PricingPack {
  pack: { name: string };
  priceLists: PriceList[];
  promotions: Promotion[];
  stackingPolicy: { maxStacked: number; maxTotalDiscountPct: number; exclusiveWinsBy: string };
  bundles: Array<{
    id: string;
    name: string;
    skus: string[];
    pricing: { kind: string; value: number };
    validFrom: string;
    validTo: string | null;
  }>;
  b2bTiers: Array<{ id: string; appliesTo: string; tiers: Array<{ minQty: number; discountPct: number }> }>;
  mlGuardrails: { floorPctOfList: number; ceilingPctOfList: number; maxDailyMovePct: number };
}

export interface PriceContext {
  market: string;
  channel?: string;
  audience?: string;
  [dim: string]: unknown;
}

export interface Quote {
  sku: string;
  currency: string;
  listPrice: number;
  appliedPromotions: Array<{ id: string; name: string; discount: number }>;
  bundleDiscount: number;
  tierDiscountPct: number;
  finalPrice: number;
  priceListId: string;
  atTime: string;
  explain: string[];
}

const current = (validFrom: string, validTo: string | null, recordedAt: string, at: string): boolean =>
  validFrom <= at && (validTo === null || validTo > at) && recordedAt <= at;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export class PricingService {
  private pack: PricingPack;

  constructor(pack: PricingPack) {
    this.pack = pack;
  }

  /** bitemporal point-in-time list price: highest-priority current list that carries the SKU for this context */
  priceAt(sku: string, ctx: PriceContext, at: string): { amount: number; currency: string; priceListId: string } | null {
    const lists = this.pack.priceLists
      .filter((pl) => current(pl.validFrom, pl.validTo, pl.recordedAt, at))
      .sort((a, b) => b.priority - a.priority);
    for (const pl of lists) {
      const entry = pl.entries.find((e) => e.sku === sku);
      if (!entry) continue;
      const cell = entry.matrix.find((c) => c.market === ctx.market);
      if (cell) return { amount: cell.amount, currency: cell.currency, priceListId: pl.id };
    }
    return null;
  }

  private promoMatches(p: Promotion, ctx: PriceContext): boolean {
    return p.conditions.every((c) => {
      const v = ctx[c.field];
      if (c.equals !== undefined) return v === c.equals;
      if (c.in !== undefined) return c.in.includes(v);
      return true;
    });
  }

  /** promotions with pack stacking policy: exclusive winner-takes-all by priority, else stack capped */
  applyPromotions(listPrice: number, ctx: PriceContext, at: string): { discount: number; applied: Array<{ id: string; name: string; discount: number }>; explain: string[] } {
    const policy = this.pack.stackingPolicy;
    const live = this.pack.promotions
      .filter((p) => current(p.validFrom, p.validTo, p.recordedAt, at))
      .filter((p) => this.promoMatches(p, ctx))
      .sort((a, b) => b.priority - a.priority);

    const explain: string[] = [];
    const discountOf = (p: Promotion): number =>
      p.kind === 'percent-off' ? round2((listPrice * p.value) / 100) : Math.min(p.value, listPrice);

    const exclusive = live.find((p) => p.stacking === 'exclusive');
    let chosen: Promotion[];
    if (exclusive) {
      chosen = [exclusive];
      explain.push(`exclusive promo ${exclusive.name} wins by ${policy.exclusiveWinsBy} — stack suppressed`);
    } else {
      chosen = live.filter((p) => p.stacking === 'stackable').slice(0, policy.maxStacked);
      if (live.length > chosen.length) explain.push(`stack capped at ${policy.maxStacked} (policy)`);
    }

    const applied = chosen.map((p) => ({ id: p.id, name: p.name, discount: discountOf(p) }));
    let discount = round2(applied.reduce((s, a) => s + a.discount, 0));
    const cap = round2((listPrice * policy.maxTotalDiscountPct) / 100);
    if (discount > cap) {
      explain.push(`total discount ${discount} clamped to policy cap ${policy.maxTotalDiscountPct}% = ${cap}`);
      discount = cap;
    }
    for (const a of applied) explain.push(`applied ${a.name}: -${a.discount}`);
    return { discount, applied, explain };
  }

  /** B2B quantity-tier discount pct for qty (ladder from pack) */
  tierPrice(sku: string, qty: number): number {
    const ladder = this.pack.b2bTiers.find((t) => t.appliesTo === sku) ?? this.pack.b2bTiers.find((t) => t.appliesTo === '*');
    if (!ladder) return 0;
    const tier = [...ladder.tiers].sort((a, b) => b.minQty - a.minQty).find((t) => qty >= t.minQty);
    return tier?.discountPct ?? 0;
  }

  /** bundle discount when the cart covers a bundle's SKU set at time T */
  bundleDiscountFor(skus: string[], totalOfBundleSkus: number, at: string): { discount: number; bundleId: string | null } {
    for (const b of this.pack.bundles) {
      if (!(b.validFrom <= at && (b.validTo === null || b.validTo > at))) continue;
      if (b.skus.every((s) => skus.includes(s))) {
        if (b.pricing.kind === 'percent-off-total') {
          return { discount: round2((totalOfBundleSkus * b.pricing.value) / 100), bundleId: b.id };
        }
      }
    }
    return { discount: 0, bundleId: null };
  }

  /** ML-price guardrail (P4-AI-003): clamp an algorithmic price to constitutional bounds */
  guardrail(sku: string, ctx: PriceContext, proposed: number, previousPrice: number | null, at: string): { accepted: number; clamped: boolean; reasons: string[] } {
    const g = this.pack.mlGuardrails;
    const list = this.priceAt(sku, ctx, at);
    const reasons: string[] = [];
    let out = proposed;
    if (list) {
      const floor = round2((list.amount * g.floorPctOfList) / 100);
      const ceiling = round2((list.amount * g.ceilingPctOfList) / 100);
      if (out < floor) { reasons.push(`below floor ${g.floorPctOfList}% of list (${floor})`); out = floor; }
      if (out > ceiling) { reasons.push(`above ceiling ${g.ceilingPctOfList}% of list (${ceiling})`); out = ceiling; }
    }
    if (previousPrice !== null && previousPrice > 0) {
      const maxMove = round2((previousPrice * g.maxDailyMovePct) / 100);
      if (Math.abs(out - previousPrice) > maxMove) {
        const clampedTo = out > previousPrice ? previousPrice + maxMove : previousPrice - maxMove;
        reasons.push(`daily move exceeds ${g.maxDailyMovePct}% — clamped ${out} → ${round2(clampedTo)}`);
        out = round2(clampedTo);
      }
    }
    return { accepted: round2(out), clamped: reasons.length > 0, reasons };
  }

  /** full quote: list price at T → promos (stacking) → bundle → B2B tier */
  quote(sku: string, qty: number, cartSkus: string[], ctx: PriceContext, atTime?: string): Quote {
    const at = atTime ?? new Date().toISOString();
    const lp = this.priceAt(sku, ctx, at);
    if (!lp) {
      return { sku, currency: '', listPrice: 0, appliedPromotions: [], bundleDiscount: 0, tierDiscountPct: 0, finalPrice: 0, priceListId: '', atTime: at, explain: [`no price for ${sku} in market ${ctx.market} at ${at}`] };
    }
    const explain: string[] = [`list ${lp.amount} ${lp.currency} from ${lp.priceListId} as-of ${at}`];
    const promo = this.applyPromotions(lp.amount, ctx, at);
    explain.push(...promo.explain);
    const bundle = this.bundleDiscountFor(cartSkus, lp.amount, at);
    if (bundle.bundleId) explain.push(`bundle ${bundle.bundleId}: -${bundle.discount}`);
    const tierPct = this.tierPrice(sku, qty);
    const afterPromo = Math.max(0, lp.amount - promo.discount - bundle.discount);
    const tierDiscount = round2((afterPromo * tierPct) / 100);
    if (tierPct > 0) explain.push(`b2b tier qty=${qty}: -${tierPct}% (${tierDiscount})`);
    return {
      sku,
      currency: lp.currency,
      listPrice: lp.amount,
      appliedPromotions: promo.applied,
      bundleDiscount: bundle.discount,
      tierDiscountPct: tierPct,
      finalPrice: round2(Math.max(0, afterPromo - tierDiscount)),
      priceListId: lp.priceListId,
      atTime: at,
      explain,
    };
  }
}

// ---------- Module-as-a-Product contract ----------
const pricingModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as PricingPack;
    const svc = new PricingService(pack);
    const meter = (ev: string) => billing.meter(ev, 1);
    return {
      priceAt: (sku: string, ctx: PriceContext, at: string) => svc.priceAt(sku, ctx, at),
      quote: (sku: string, qty: number, cart: string[], ctx: PriceContext, at?: string) => (meter('pricing.quoted'), svc.quote(sku, qty, cart, ctx, at)),
      applyPromotions: (list: number, ctx: PriceContext, at: string) => (meter('pricing.promo.applied'), svc.applyPromotions(list, ctx, at)),
      tierPrice: (sku: string, qty: number) => svc.tierPrice(sku, qty),
      guardrail: (sku: string, ctx: PriceContext, proposed: number, prev: number | null, at: string) => svc.guardrail(sku, ctx, proposed, prev, at),
      __raw: svc,
    };
  },
};

export default pricingModule;
