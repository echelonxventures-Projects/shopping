// Tests: catalog kernel-app — pack-driven product/offer/buy-box/display (P1-CAT-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogService } from '../src/index.ts';
import { MemoryEngine } from '@aether/kernel-storage/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../../../packs/marketplace-core/pack.json'), 'utf8'));

test('product created via pack schema + U²ID', async () => {
  const engine = new MemoryEngine();
  const svc = new CatalogService(engine, pack, 'marketplace-sku', 'offer-id');
  const { id } = await svc.createProduct('tenant-1', { title: 'Organic Cotton Tee', hsCode: '6109.10', countryOfOrigin: 'IN' }, ['EAN-1234567890123']);
  assert.match(id, /^[A-HJKMNP-Z2-9]{10}$/);
  const p = await engine.get(id, 'tenant-1');
  assert.equal(p!.attributes.title, 'Organic Cotton Tee');
});

test('offers + rule-driven buy-box (platform-fulfilled preferred over lower price)', async () => {
  const engine = new MemoryEngine();
  const svc = new CatalogService(engine, pack, 'marketplace-sku', 'offer-id');
  const { id } = await svc.createProduct('tenant-2', { title: 'Tee', hsCode: '6109.10', countryOfOrigin: 'IN' });
  await svc.addOffer('tenant-2', id, { sellerId: 's-cheap', price: 9.99, currency: 'USD', fulfillmentMode: 'seller-fulfilled' });
  await svc.addOffer('tenant-2', id, { sellerId: 's-ff', price: 10.49, currency: 'USD', fulfillmentMode: 'platform-fulfilled' });
  const bb = await svc.buyBox('tenant-2', id);
  assert.equal(bb!.sellerId, 's-ff');
  assert.ok(bb!.explain.some((e) => e.includes('prefer-platform-fulfilled')));
});

test('market-scoped price display (EU inclusive vs default exclusive)', () => {
  const engine = new MemoryEngine();
  const svc = new CatalogService(engine, pack, 'marketplace-sku', 'offer-id');
  assert.equal((svc.displayConfig({ market: 'EU' }) as { taxMode: string }).taxMode, 'inclusive');
  assert.equal((svc.displayConfig({ market: null }) as { taxMode: string }).taxMode, 'exclusive');
});

test('schema validation enforced from pack (required hsCode)', async () => {
  const engine = new MemoryEngine();
  const svc = new CatalogService(engine, pack, 'marketplace-sku', 'offer-id');
  await assert.rejects(
    () => svc.createProduct('tenant-3', { title: 'No HS code' }),
    /hsCode/
  );
});
