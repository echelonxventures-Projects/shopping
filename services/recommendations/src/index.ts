// @aether/service-recommendations — retrieval → ranking → business re-rank
// (P1-REC-001). Module-as-a-Product: strategy weights, re-rank policies,
// cold-start, explanations, consent gating are ALL pack data. Recs explain
// themselves (EU AI Act transparency) and never run without consent.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface RecInput {
  tenantId: string;
  anchorProductId?: string;
  anchorCategory?: string;
  signals: Array<{ productId: string; score: number; category?: string; inStock: boolean; sponsored?: boolean }>;
  consentPersonalization: boolean;
}

export interface RecItem {
  productId: string;
  strategy: string;
  score: number;
  explanation: string;
  sponsored: boolean;
}

export interface RecsPolicy {
  candidates: number;
  finalSlots: number;
  strategies: Array<{ name: string; weight: number; source: string }>;
  reRank: {
    diversity: { enabled: boolean; maxPerCategory: number };
    inventoryAware: { enabled: boolean; dropOutOfStock: boolean };
    sponsored: { enabled: boolean; maxSlots: number; label: string; boost: number };
  };
  coldStart: { fallback: string; minSignals: number };
  consentRequired: boolean;
  explanationTemplates?: Record<string, string>;
}

export class RecommendationsService {
  private policy: RecsPolicy;
  constructor(policy: RecsPolicy) {
    this.policy = policy;
  }

  recommend(input: RecInput): RecItem[] {
    // consent gate (constitutional): without consent, only non-personal fallback
    if (this.policy.consentRequired && !input.consentPersonalization) {
      return input.signals
        .filter((s) => s.inStock)
        .slice(0, this.policy.finalSlots)
        .map((s) => ({
          productId: s.productId,
          strategy: 'coldStart/fallback:bestsellers',
          score: s.score,
          explanation: this.policy.explanationTemplates?.['trending']?.replace('{category}', input.anchorCategory ?? 'store') ?? 'Trending',
          sponsored: false,
        }));
    }

    // 1) retrieval: score by strategy weights
    let pool = input.signals.map((s) => {
      // anchor-similarity heuristics: same category boosts 'similar-items' weight
      const sameCat = !!input.anchorCategory && s.category === input.anchorCategory;
      const w = this.policy.strategies[0]!.weight * (sameCat ? 1.8 : 1);
      return { ...s, strategy: sameCat ? 'similar-items' : 'also-bought', weighted: s.score * w };
    });

    // 2) inventory-aware re-rank (pack policy)
    if (this.policy.reRank.inventoryAware.dropOutOfStock) pool = pool.filter((s) => s.inStock);

    // 3) sort by weighted score, sponsored boost applies within maxSlots
    const sponsoredBoost = this.policy.reRank.sponsored.enabled ? this.policy.reRank.sponsored.boost : 1;
    pool.sort((a, b) => b.weighted * (b.sponsored ? sponsoredBoost : 1) - a.weighted * (a.sponsored ? sponsoredBoost : 1));

    // 4) diversity re-rank (max per category) + sponsored slot cap
    const perCat = new Map<string, number>();
    let sponsoredSlots = 0;
    const out: RecItem[] = [];
    for (const p of pool) {
      if (out.length >= this.policy.finalSlots) break;
      const cat = p.category ?? '_';
      if (this.policy.reRank.diversity.enabled && (perCat.get(cat) ?? 0) >= this.policy.reRank.diversity.maxPerCategory) continue;
      if (p.sponsored) {
        if (sponsoredSlots >= this.policy.reRank.sponsored.maxSlots) continue;
        sponsoredSlots++;
      }
      perCat.set(cat, (perCat.get(cat) ?? 0) + 1);
      out.push({
        productId: p.productId,
        strategy: p.sponsored ? 'sponsored' : p.strategy,
        score: Math.round(p.weighted * 100) / 100,
        sponsored: p.sponsored,
        explanation: p.sponsored
          ? this.policy.explanationTemplates?.['sponsored'] ?? 'Sponsored'
          : (this.policy.explanationTemplates?.[p.strategy] ?? 'Recommended for you')
              .replace('{productTitle}', p.productId)
              .replace('{category}', p.category ?? 'store'),
      });
    }
    return out;
  }
}

const recommendationsModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const policy = (Object.values(packs)[0] as { policy: RecsPolicy }).policy;
    const svc = new RecommendationsService(policy);
    const meter = (ev: string) => billing.meter(ev);
    return {
      recommend: (input: RecInput) => (meter('recs.served'), svc.recommend(input)),
      __raw: svc,
    };
  },
};

export default recommendationsModule;
