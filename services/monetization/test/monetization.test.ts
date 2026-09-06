// Tests: monetization — resource registry, metering, tiered/per-unit/%-GMV rating,
// entitlements (plan + addon + free default), invoicing (P1-MON-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MonetizationService, MonetizationError } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../../../packs/monetization-core/pack.json'), 'utf8'));

function svc(): MonetizationService {
  return new MonetizationService(pack);
}

test('billable resources + unknown resource rejected (registry is the door)', () => {
  const m = svc();
  m.meter({ tenantId: 't', resource: 'orders', qty: 1, at: new Date().toISOString() });
  assert.throws(() => m.meter({ tenantId: 't', resource: 'quantum-compute', qty: 1, at: new Date().toISOString() }), MonetizationError);
});

test('tiered rating: Starter plan — 1500 orders → 1000 free + 500 × $0.10', () => {
  const m = svc();
  m.subscribe('t1', 'plan_starter');
  const r = m.rate('t1', 'orders', 1500);
  assert.equal(r.amount, 50); // 500 × 0.10
  assert.ok(r.explain.some((e) => e.includes('tiered')));
});

test('per-unit rating with included quota: Growth emails 50k included, then 10k × 0.0005', () => {
  const m = svc();
  m.subscribe('t2', 'plan_growth');
  const r = m.rate('t2', 'emails', 60000);
  assert.equal(r.amount, 5); // 10,000 × 0.0005
});

test('percent-of-GMV rating: Enterprise orders 0.5% with minimum', () => {
  const m = svc();
  m.subscribe('t3', 'plan_enterprise');
  const small = m.rate('t3', 'orders', 10000); // GMV $10k → $50, below min
  assert.equal(small.amount, 500); // minimum applies
  const large = m.rate('t3', 'orders', 1000000); // GMV $1M → $5000
  assert.equal(large.amount, 5000);
});

test('entitlements: plan grants, add-on grants, default-free floor', () => {
  const m = svc();
  m.subscribe('t4', 'plan_starter');
  assert.equal(m.entitlement('t4', 'feature:marketplace').granted, false); // Starter excludes
  m.subscribe('t5', 'plan_growth');
  assert.equal(m.entitlement('t5', 'feature:marketplace').granted, true);
  m.subscribe('t6', 'plan_starter');
  m.grantAddon('t6', 'feature:marketplace');
  assert.equal(m.entitlement('t6', 'feature:marketplace').granted, true);
  assert.equal(m.entitlement('t7', 'feature:brand_new_thing').source, 'default-free'); // never accidentally paywalled
});

test('invoice: periodic fee + rated usage, bitemporal plan data', () => {
  const m = svc();
  m.subscribe('t8', 'plan_starter');
  m.meter({ tenantId: 't8', resource: 'orders', qty: 1200, at: '2026-09-01T00:00:00Z' });
  m.meter({ tenantId: 't8', resource: 'emails', qty: 5000, at: '2026-09-01T00:00:00Z' });
  const inv = m.invoice('t8', '2026-09-01T00:00:00Z', '2026-09-30T00:00:00Z');
  assert.equal(inv.periodicFee, 29);
  // orders: 200 × 0.10 = 20; emails: 5000 within included → 0
  assert.equal(inv.total, 49);
  assert.equal(inv.currency, 'USD');
});

test('usage accumulates across events; invoice reflects totals', () => {
  const m = svc();
  m.subscribe('t9', 'plan_starter');
  for (let i = 0; i < 3; i++) m.meter({ tenantId: 't9', resource: 'orders', qty: 400, at: '2026-09-02T00:00:00Z' });
  assert.equal(m.usage('t9', 'orders'), 1200);
  const inv = m.invoice('t9', '2026-09-01', '2026-09-30');
  const ordersLine = inv.rated.find((l) => l.resource === 'orders')!;
  assert.equal(ordersLine.amount, 20); // 200 billable × 0.10
});
