// Tests: EVERYTHING IS A PRODUCT — all services listed as sellable products,
// monetization wiring generated, product-conformance enforced (P0-KRN-016).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProductRegistry, defaultServicesDir } from '../src/index.ts';

test('every service in services/ is listed as a product — no exceptions', () => {
  const reg = new ProductRegistry();
  const n = reg.scanDirectory(defaultServicesDir);
  assert.ok(n >= 12, `expected >=12 products, found ${n}`);
  const ids = reg.list().map((p) => p.productId).sort();
  assert.ok(ids.includes('mod-tax'));
  assert.ok(ids.includes('mod-logistics'));
  assert.ok(ids.includes('mod-support'));
  assert.ok(ids.includes('mod-product-master'));
});

test('each product carries offer metadata (pricing, meterable resources, API surface, packs)', () => {
  const reg = new ProductRegistry();
  reg.scanDirectory(defaultServicesDir);
  const tax = reg.get('mod-tax');
  assert.equal(tax.displayName, 'Tax Engine v2');
  assert.equal(tax.offer.pricingModel, 'usage');
  assert.ok(tax.offer.meterableResources.length > 0);
  assert.ok(tax.apiSurface.includes('compute'));
  assert.deepEqual(tax.bundledPacks, ['packs/tax-core.json']);
});

test('monetization sync: products generate billable resources + offers for the Monetization Stack', () => {
  const reg = new ProductRegistry();
  reg.scanDirectory(defaultServicesDir);
  const sync = reg.monetizationSyncPayload();
  assert.ok(sync.billableResources.length >= 15);
  assert.ok(sync.billableResources.some((r) => r.name === 'tax_computed'));
  assert.ok(sync.productOffers.length >= 12);
  const logistics = sync.productOffers.find((p) => p.id === 'mod-logistics')!;
  assert.equal(logistics.suggestedRate!.perUnit, 'label');
});

test('unknown product rejected — registry is the only source of product truth', () => {
  const reg = new ProductRegistry();
  assert.throws(() => reg.get('mod-nonexistent'), /must be registered/);
});
