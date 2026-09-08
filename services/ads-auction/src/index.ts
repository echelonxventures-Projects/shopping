// @aether/service-ads-auction — sponsored-product CPC auction (P4-ECO-001).
// Module-as-a-Product: second-price mechanics, slot count, quality weights,
// min bids/quality, budget policies, labeling — ALL PACK DATA. Rank = bid ×
// qualityScore (pack weights over CTR/relevance/sellerRating); winner pays
// second-price (runner-up's bid × own quality ratio, min floor). Budgets
// deplete and stop. EU AI Act: sponsored results ALWAYS labeled (pack policy).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface AdsPack {
  pack: { name: string };
  auction: {
    pricingModel: string;
    slots: number;
    minBid: { amount: number; currency: string };
    minQualityScore: number;
    qualityScoreWeights: { ctr: number; relevance: number; sellerRating: number };
  };
  budgets: { dailyDefault: { amount: number; currency: string }; stopWhenExhausted: boolean; carryOver: boolean };
  labeling: { required: boolean; label: string };
}

export interface AdCandidate {
  adId: string;
  sellerId: string;
  productId: string;
  bid: number; // CPC bid
  metrics: { ctr: number; relevance: number; sellerRating: number };
  dailyBudget: number;
  spentToday: number;
}

export interface AuctionWinner {
  slot: number;
  adId: string;
  sellerId: string;
  productId: string;
  cpc: number; // actual charged CPC (second-price)
  qualityScore: number;
  rankScore: number;
  label: string; // transparency (EU AI Act) — always from pack
}

export class AdsAuctionError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'AdsAuctionError';
  }
}

export class AdsAuctionService {
  private pack: AdsPack;
  private spent = new Map<string, number>(); // adId → spend today
  private clickSeq = 0;

  constructor(pack: AdsPack) {
    this.pack = pack;
  }

  /** quality score from pack weights — the formula is DATA */
  qualityScore(c: AdCandidate): number {
    const w = this.pack.auction.qualityScoreWeights;
    return Math.round((c.metrics.ctr * w.ctr + c.metrics.relevance * w.relevance + c.metrics.sellerRating * w.sellerRating) * 1000) / 1000;
  }

  /** run the auction: eligible candidates ranked; slots per pack; second-price CPC */
  runAuction(candidates: AdCandidate[]): AuctionWinner[] {
    const a = this.pack.auction;
    const eligible = candidates.filter((c) => {
      if (c.bid < a.minBid.amount) return false;
      if (this.qualityScore(c) < a.minQualityScore) return false;
      const spend = this.spent.get(c.adId) ?? c.spentToday;
      if (this.pack.budgets.stopWhenExhausted && spend >= c.dailyBudget) return false;
      return true;
    });
    const scored = eligible
      .map((c) => ({ c, q: this.qualityScore(c), rank: c.bid * this.qualityScore(c) }))
      .sort((x, y) => y.rank - x.rank);
    const winners: AuctionWinner[] = [];
    for (let i = 0; i < Math.min(a.slots, scored.length); i++) {
      const { c, q, rank } = scored[i]!;
      // second-price: pay just enough to beat the next-ranked ad's rank score,
      // expressed as CPC against own quality; floor at min bid
      const nextRank = scored[i + 1]?.rank ?? a.minBid.amount * a.minQualityScore;
      const cpc = Math.max(a.minBid.amount, Math.round((nextRank / (q || 1)) * 10000) / 10000);
      winners.push({
        slot: i + 1,
        adId: c.adId, sellerId: c.sellerId, productId: c.productId,
        cpc, qualityScore: q, rankScore: Math.round(rank * 10000) / 10000,
        label: this.pack.labeling.required ? this.pack.labeling.label : '',
      });
    }
    return winners;
  }

  /** a click lands on a winning slot: charge the actual CPC against budget */
  chargeClick(ad: AdCandidate, cpc: number): { charged: number; budgetExhausted: boolean } {
    const charged = Math.round(cpc * 10000) / 10000;
    const prev = Math.round((this.spent.get(ad.adId) ?? ad.spentToday) * 10000) / 10000;
    const now = Math.round((prev + charged) * 10000) / 10000;
    this.spent.set(ad.adId, now);
    const budget = ad.dailyBudget || this.pack.budgets.dailyDefault.amount;
    return { charged, budgetExhausted: this.pack.budgets.stopWhenExhausted && now >= budget };
  }

  /** budget state for an ad (stops serving when exhausted — pack policy) */
  budgetState(ad: AdCandidate): { spent: number; remaining: number; exhausted: boolean } {
    const spent = Math.round((this.spent.get(ad.adId) ?? ad.spentToday) * 10000) / 10000;
    const budget = ad.dailyBudget || this.pack.budgets.dailyDefault.amount;
    return { spent, remaining: Math.round(Math.max(0, budget - spent) * 10000) / 10000, exhausted: this.pack.budgets.stopWhenExhausted && spent >= budget };
  }

  clickCount(): number {
    return this.clickSeq;
  }

  recordClick(): number {
    return ++this.clickSeq;
  }
}

const adsAuctionModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as AdsPack;
    const svc = new AdsAuctionService(pack);
    const meter = (ev: string) => billing.meter(ev);
    return {
      qualityScore: (c: AdCandidate) => svc.qualityScore(c),
      runAuction: (c: AdCandidate[]) => (meter('auction.run'), svc.runAuction(c)),
      chargeClick: (ad: AdCandidate, cpc: number) => (meter('click.charged'), svc.chargeClick(ad, cpc)),
      budgetState: (a: AdCandidate) => svc.budgetState(a),
      __raw: svc,
    };
  },
};

export default adsAuctionModule;
