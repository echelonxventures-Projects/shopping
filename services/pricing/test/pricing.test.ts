// Tests: Pricing & Promotions — bitemporal point-in-time prices, market matrices,
// stacking policy (exclusive vs stackable + caps), bundles, B2B tiers,
// ML-price guardrails (P1-PRC-001/002, P4-AI-003).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PricingService, type PricingPack } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/pricing-core.json'), 'utf8')) as PricingPack;
const svc = new PricingService(pack);

test('bitemporal price reconstruction: amendment applies after June 1, base before (P1-PRC-001 acceptance)', () => {
  const before = svc.priceAt('TSHIRT-CLASSIC', { market: 'US' }, '2026-03-15T00:00:00Z');
  assert.equal(before!.amount, 25);
  assert.equal(before!.priceListId, 'pl_base_2026');

  const after = svc.priceAt('TSHIRT-CLASSIC', { market: 'US' }, '2026-07-15T00:00:00Z');
  assert.equal(after!.amount, 28); // amendment (higher priority, valid from June)
  assert.equal(after!.priceListId, 'pl_base_2026_amend1');

  // amendment not yet RECORDED at May 1 → reconstruction at that T still sees base
  const knownAt = svc.priceAt('TSHIRT-CLASSIC', { market: 'US' }, '2026-05-01T00:00:00Z');
  assert.equal(knownAt!.amount, 25);
});

test('market matrix: same SKU prices per market dimension, missing market → null (no fallback invented)', () => {
  const eu = svc.priceAt('TSHIRT-CLASSIC', { market: 'EU' }, '2026-03-15T00:00:00Z');
  assert.equal(eu!.amount, 24);
  assert.equal(eu!.currency, 'EUR');
  const inr = svc.priceAt('TSHIRT-CLASSIC', { market: 'IN' }, '2026-03-15T00:00:00Z');
  assert.equal(inr!.currency, 'INR');
  assert.equal(svc.priceAt('HOODIE-PREMIUM', { market: 'IN' }, '2026-03-15T00:00:00Z'), null);
});

test('stacking policy: stackables stack up to cap; exclusive promo suppresses the stack (P1-PRC-002)', () => {
  // July, loyalty audience, normal channel → summer10 + loyal5 stack
  const stacked = svc.applyPromotions(100, { market: 'US', audience: 'loyalty' }, '2026-06-15T00:00:00Z');
  assert.equal(stacked.applied.length, 2);
  assert.equal(stacked.discount, 15); // 10% + 5 flat

  // flash-sale channel during flash window → exclusive 20% wins alone
  const excl = svc.applyPromotions(100, { market: 'US', audience: 'loyalty', channel: 'flash-sale' }, '2026-07-01T12:00:00Z');
  assert.equal(excl.applied.length, 1);
  assert.equal(excl.applied[0]!.name, 'flash-20pct-exclusive');
  assert.equal(excl.discount, 20);
});

test('total discount clamped to policy cap (35%)', () => {
  // craft a scenario: loyalty flat 5 on a tiny price → percentage-wise huge
  const r = svc.applyPromotions(10, { market: 'US', audience: 'loyalty' }, '2026-06-15T00:00:00Z');
  // summer 10% = 1 + loyal flat 5 = 6 total → 60% of 10 → clamp to 3.5
  assert.equal(r.discount, 3.5);
  assert.ok(r.explain.some((e) => e.includes('clamped to policy cap')));
});

test('full quote: bundle + promo + B2B tier compose with explainability', () => {
  const q = svc.quote('HOODIE-PREMIUM', 50, ['TSHIRT-CLASSIC', 'HOODIE-PREMIUM'], { market: 'US' }, '2026-06-15T00:00:00Z');
  assert.equal(q.listPrice, 79);
  // summer10 → -7.9; bundle 15% of 79 → -11.85; then tier 8% on remainder
  assert.equal(q.appliedPromotions.length, 1);
  assert.equal(q.bundleDiscount, 11.85);
  assert.equal(q.tierDiscountPct, 8);
  const afterPromo = 79 - 7.9 - 11.85;
  const expected = Math.round((afterPromo - (afterPromo * 8) / 100) * 100) / 100;
  assert.equal(q.finalPrice, expected);
  assert.ok(q.explain.length >= 3);
});

test('B2B tier ladder from pack: 1→0%, 50→8%, 500→15%', () => {
  assert.equal(svc.tierPrice('TSHIRT-CLASSIC', 1), 0);
  assert.equal(svc.tierPrice('TSHIRT-CLASSIC', 49), 0);
  assert.equal(svc.tierPrice('TSHIRT-CLASSIC', 50), 8);
  assert.equal(svc.tierPrice('TSHIRT-CLASSIC', 5000), 15);
});

test('ML-price guardrails: floor/ceiling vs list + max daily move — algorithmic price is clamped, never trusted (P4-AI-003)', () => {
  const at = '2026-03-15T00:00:00Z'; // list = 25
  // proposes 10 → floor is 60% of 25 = 15
  const low = svc.guardrail('TSHIRT-CLASSIC', { market: 'US' }, 10, null, at);
  assert.equal(low.accepted, 15);
  assert.equal(low.clamped, true);

  // proposes 50 → ceiling 140% of 25 = 35
  const high = svc.guardrail('TSHIRT-CLASSIC', { market: 'US' }, 50, null, at);
  assert.equal(high.accepted, 35);

  // within band but moves >10% vs yesterday (24 → proposes 30; max move 2.4)
  const move = svc.guardrail('TSHIRT-CLASSIC', { market: 'US' }, 30, 24, at);
  assert.equal(move.accepted, 26.4);
  assert.ok(move.reasons.some((r) => r.includes('daily move')));

  // compliant proposal passes untouched
  const ok = svc.guardrail('TSHIRT-CLASSIC', { market: 'US' }, 26, 25, at);
  assert.equal(ok.accepted, 26);
  assert.equal(ok.clamped, false);
});

test('module contract: default export is an AetherModule with metered quote', async () => {
  const mod = (await import('../src/index.ts')).default;
  assert.equal(mod.manifest.id, 'mod-pricing');
  const events: string[] = [];
  const api = await mod.create(
    { tenantId: () => 't1', storage: () => null, log: () => {} },
    { meter: (e: string) => events.push(e) },
    { 'pricing-core': pack }
  );
  const q = (api['quote'] as (s: string, q: number, c: string[], ctx: { market: string }, at?: string) => { finalPrice: number })(
    'TSHIRT-CLASSIC', 1, [], { market: 'US' }, '2026-03-15T00:00:00Z'
  );
  assert.equal(q.finalPrice > 0, true);
  assert.deepEqual(events, ['pricing.quoted']);
});
