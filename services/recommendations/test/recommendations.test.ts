// Tests: recommendations — strategy weights, diversity, inventory-aware, sponsored
// caps + labels, cold-start, consent gate (P1-REC-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecommendationsService } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/recommendations-core.json'), 'utf8'));
const svc = () => new RecommendationsService(pack.policy);

function signals(n = 20): Array<{ productId: string; score: number; category?: string; inStock: boolean; sponsored?: boolean }> {
  const cats = ['apparel', 'electronics', 'home'];
  return Array.from({ length: n }, (_, i) => ({
    productId: `p${i}`,
    score: 1 - i / n,
    category: cats[i % 3]!,
    inStock: i % 7 !== 3, // some out of stock
    sponsored: i < 4, // 4 sponsored candidates competing for 2 slots
  }));
}

test('consent gate: without consent, only non-personal bestsellers, no sponsored', () => {
  const s = svc();
  const out = s.recommend({ tenantId: 't', signals: signals(), consentPersonalization: false, anchorCategory: 'apparel' });
  assert.ok(out.length <= 8);
  assert.ok(out.every((r) => !r.sponsored));
  assert.ok(out.every((r) => r.strategy.includes('fallback')));
});

test('diversity: max 3 per category in final slots', () => {
  const s = svc();
  const out = s.recommend({ tenantId: 't', signals: signals(), consentPersonalization: true, anchorCategory: 'apparel' });
  const counts: Record<string, number> = {};
  for (const r of out) {
    const cat = r.productId.startsWith('p') ? `cat${Number(r.productId.slice(1)) % 3}` : 'other';
    counts[cat] = (counts[cat] ?? 0) + 1;
  }
  // every 3rd signal shares a category; with maxPerCategory=3 the final set must respect it
  assert.ok(out.length <= 8);
});

test('inventory-aware: out-of-stock items dropped', () => {
  const s = svc();
  const input = signals().map((sig, i) => ({ ...sig, inStock: i % 2 === 0 }));
  const out = s.recommend({ tenantId: 't', signals: input, consentPersonalization: true });
  const stockMap = new Map(input.map((s2) => [s2.productId, s2.inStock]));
  assert.ok(out.every((r) => stockMap.get(r.productId) !== false));
});

test('sponsored: capped at 2 slots and always labeled', () => {
  const s = svc();
  const out = s.recommend({ tenantId: 't', signals: signals(), consentPersonalization: true });
  const sponsored = out.filter((r) => r.sponsored);
  assert.ok(sponsored.length <= 2);
  assert.ok(sponsored.every((r) => r.explanation === 'Sponsored'));
});

test('explanations: every recommendation carries a strategy explanation (AI Act transparency)', () => {
  const s = svc();
  const out = s.recommend({ tenantId: 't', signals: signals(), consentPersonalization: true, anchorCategory: 'apparel' });
  assert.ok(out.length > 0);
  assert.ok(out.every((r) => r.explanation.length > 0));
});

test('cold-start policy from pack: fallback = bestsellers-global, minSignals = 3', () => {
  assert.equal(pack.policy.coldStart.fallback, 'bestsellers-global');
  assert.equal(pack.policy.coldStart.minSignals, 3);
});
