// @aether/service-seo — sitemap sharding at scale, hreflang alternates,
// schema.org output, per-tenant robots, canonical URLs on U²ID (P1-SEO-001).
// Module-as-a-Product: shard size, market maps, robots policies are PACK DATA.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface SeoPack {
  pack: { name: string };
  sitemap: { urlsPerShard: number; shardPrefix: string; includeLastmod: boolean };
  markets: Array<{ market: string; locale: string; baseUrl: string; hreflang: string }>;
  robotsPolicies: Array<{ tenantType: string; disallow: string[] }>;
  schemaOrg: Record<string, boolean>;
}

export class SeoService {
  private pack: SeoPack;
  constructor(pack: SeoPack) {
    this.pack = pack;
  }

  /** shard a product-url stream into sitemap files (10M+ SKUs: 200 shards at 50k) */
  shardSitemaps(products: Array<{ id: string; updatedAt?: string }>): Array<{ file: string; urls: Array<{ loc: string; lastmod?: string }> }> {
    const { urlsPerShard, shardPrefix, includeLastmod } = this.pack.sitemap;
    const shards: Array<{ file: string; urls: Array<{ loc: string; lastmod?: string }> }> = [];
    let current: { file: string; urls: Array<{ loc: string; lastmod?: string }> } | null = null;
    for (const p of products) {
      if (!current || current.urls.length >= urlsPerShard) {
        current = { file: `${shardPrefix}-${shards.length + 1}.xml`, urls: [] };
        shards.push(current);
      }
      current.urls.push({ loc: `/product/${p.id}`, lastmod: includeLastmod ? p.updatedAt : undefined });
    }
    return shards;
  }

  /** hreflang alternates for a product across ALL configured markets (pack data) */
  hreflangAlternates(productId: string): Array<{ hreflang: string; href: string }> {
    return this.pack.markets.map((m) => ({ hreflang: m.hreflang, href: `${m.baseUrl}/product/${productId}` }));
  }

  /** per-tenant robots.txt from policy pack */
  robotsTxt(tenantType = 'default'): string {
    const policy = this.pack.robotsPolicies.find((p) => p.tenantType === tenantType) ?? this.pack.robotsPolicies[0]!;
    return ['User-agent: *', ...policy.disallow.map((d) => `Disallow: ${d}`), ''].join('\n');
  }

  /** schema.org Product/Offer JSON-LD (pack toggles which blocks emit) */
  productJsonLd(input: {
    id: string; title: string; description?: string; brand?: string;
    offers: Array<{ price: number; currency: string; availability?: string }>;
    rating?: { value: number; count: number };
  }): Record<string, unknown> {
    const out: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: input.title,
      sku: input.id,
      description: input.description,
      brand: input.brand ? { '@type': 'Brand', name: input.brand } : undefined,
    };
    if (this.pack.schemaOrg.offer) {
      out['offers'] = input.offers.map((o) => ({
        '@type': 'Offer',
        price: o.price,
        priceCurrency: o.currency,
        availability: o.availability ?? 'https://schema.org/InStock',
      }));
    }
    if (this.pack.schemaOrg.aggregateRating && input.rating) {
      out['aggregateRating'] = {
        '@type': 'AggregateRating',
        ratingValue: input.rating.value,
        reviewCount: input.rating.count,
      };
    }
    return out;
  }

  /** canonical URL built on U²ID (stable across schema epochs) */
  canonicalUrl(productId: string, market: string): string | null {
    const m = this.pack.markets.find((x) => x.market === market);
    return m ? `${m.baseUrl}/product/${productId}` : null;
  }
}

const seoModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as SeoPack;
    const svc = new SeoService(pack);
    const meter = (ev: string) => billing.meter(ev);
    return {
      shardSitemaps: (p: Array<{ id: string; updatedAt?: string }>) => (meter('sitemap.sharded'), svc.shardSitemaps(p)),
      hreflangAlternates: (id: string) => (meter('hreflang.generated'), svc.hreflangAlternates(id)),
      robotsTxt: (t?: string) => svc.robotsTxt(t),
      productJsonLd: (i: Parameters<SeoService['productJsonLd']>[0]) => (meter('jsonld.generated'), svc.productJsonLd(i)),
      canonicalUrl: (id: string, m: string) => svc.canonicalUrl(id, m),
      __raw: svc,
    };
  },
};

export default seoModule;
