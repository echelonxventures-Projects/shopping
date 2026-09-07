// Tests: SEO — sitemap sharding at scale, hreflang alternates, robots policies,
// schema.org JSON-LD, canonical URLs (P1-SEO-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SeoService } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/seo-core.json'), 'utf8'));
const svc = () => new SeoService(pack);

test('sitemap sharding: 120,001 products → 3 shards at 50k (pack urlsPerShard)', () => {
  const s = svc();
  const products = Array.from({ length: 120_001 }, (_, i) => ({ id: `p${i}`, updatedAt: '2026-09-06T00:00:00Z' }));
  const shards = s.shardSitemaps(products);
  assert.equal(shards.length, 3);
  assert.equal(shards[0]!.urls.length, 50_000);
  assert.equal(shards[1]!.urls.length, 50_000);
  assert.equal(shards[2]!.urls.length, 20_001); // 120,001 − 2×50,000
  assert.equal(shards[0]!.file, 'sitemap-products-1.xml');
  assert.equal(shards[0]!.urls[0]!.loc, '/product/p0');
  assert.equal(shards[0]!.urls[0]!.lastmod, '2026-09-06T00:00:00Z');
});

test('hreflang alternates: one product → all pack markets with correct base URLs', () => {
  const s = svc();
  const alts = s.hreflangAlternates('abc123');
  assert.equal(alts.length, 4);
  assert.deepEqual(alts.map((a) => a.hreflang), ['en-us', 'en-eu', 'fr-fr', 'hi-in']);
  assert.ok(alts[2]!.href === 'https://fr.store.example.com/product/abc123');
});

test('robots policies per tenant type from pack', () => {
  const s = svc();
  const def = s.robotsTxt('default');
  assert.match(def, /Disallow: \/admin/);
  assert.doesNotMatch(def, /\/compare/);
  const brand = s.robotsTxt('brand-store');
  assert.match(brand, /Disallow: \/compare/); // brand stores disallow compare
});

test('schema.org JSON-LD: Product + Offer + AggregateRating (pack toggles)', () => {
  const s = svc();
  const ld = s.productJsonLd({
    id: 'p1', title: 'Cotton Tee', description: 'Soft organic tee', brand: 'Acme',
    offers: [{ price: 20, currency: 'USD' }],
    rating: { value: 4.6, count: 128 },
  });
  assert.equal(ld['@type'], 'Product');
  assert.equal((ld as { name: string }).name, 'Cotton Tee');
  const offers = (ld as { offers: Array<{ price: number }> }).offers;
  assert.equal(offers[0]!.price, 20);
  assert.equal((ld as { aggregateRating: { ratingValue: number } }).aggregateRating.ratingValue, 4.6);
});

test('canonical URLs: stable U²ID-based per market; unknown market → null', () => {
  const s = svc();
  assert.equal(s.canonicalUrl('p-xyz', 'US'), 'https://store.example.com/product/p-xyz');
  assert.equal(s.canonicalUrl('p-xyz', 'XX'), null);
});
