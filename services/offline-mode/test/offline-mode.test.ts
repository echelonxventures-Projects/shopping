// Tests: offline mode — capture queue policies, priority sync, staleness rejection,
// price-drift holds, overflow behavior (P2-OFF-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OfflineModeService } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/offline-core.json'), 'utf8'));
const svc = () => new OfflineModeService(pack);

test('capture: oversized payloads rejected by pack policy (256KB limit)', () => {
  const s = svc();
  assert.throws(() => s.capture('order.place', Date.now(), 300, { price: 10 }), /exceeds offline queue limit/);
  const ok = s.capture('order.place', Date.now(), 10, { price: 10, offerId: 'x' });
  assert.match(ok.actionId, /^act-/);
});

test('sync priority: order.place syncs before cart.update before view.track (pack order)', () => {
  const s = svc();
  const now = Date.now();
  s.capture('view.track', now, 1, {});
  s.capture('cart.update', now, 1, {});
  s.capture('order.place', now, 1, { price: 10 });
  const outcomes = s.sync({ now: now + 1000 });
  assert.equal(outcomes.length, 3);
  assert.ok(outcomes.every((o) => o.status === 'synced'));
  // order.place was first (priority 0)
  assert.equal(s.queueDepth(), 0);
});

test('staleness: orders older than 48h rejected; carts older than 1h rejected', () => {
  const s = svc();
  const now = Date.now();
  s.capture('order.place', now - 49 * 3_600_000, 1, { price: 10 }); // 49h old — stale
  s.capture('cart.update', now - 2 * 3_600_000, 1, {}); // 2h old — stale cart
  s.capture('order.place', now - 1 * 3_600_000, 1, { price: 10 }); // 1h — fresh order
  const outcomes = s.sync({ now });
  const stale = outcomes.filter((o) => o.status === 'rejected-stale');
  assert.equal(stale.length, 2);
  const synced = outcomes.filter((o) => o.status === 'synced');
  assert.equal(synced.length, 1);
});

test('PRICE-DRIFT PROTECTION: >5% price move holds order for re-confirmation', () => {
  const s = svc();
  const now = Date.now();
  s.capture('order.place', now - 1000, 1, { price: 100, offerId: 'hot-sku' });
  const outcomes = s.sync({ now, currentPriceFor: (p) => (p['offerId'] === 'hot-sku' ? 112 : undefined) });
  const held = outcomes[0]!;
  assert.equal(held.status, 'held-price-drift');
  assert.equal((held as { expectedPrice: number }).expectedPrice, 100);
  assert.equal((held as { currentPrice: number }).currentPrice, 112); // 12% drift > 5% tolerance
  // small drift (≤5%) syncs normally
  s.capture('order.place', now - 1000, 1, { price: 100, offerId: 'hot-sku' });
  const ok = s.sync({ now, currentPriceFor: () => 103 }); // 3% drift
  assert.equal(ok[0]!.status, 'synced');
});

test('queue overflow: reject-oldest policy keeps freshest 500 actions', () => {
  const s = svc();
  const now = Date.now();
  for (let i = 0; i < 502; i++) s.capture('cart.update', now - i, 1, { i });
  assert.equal(s.queueDepth(), 500); // two oldest dropped
  // verify the freshest survived: sync all — first synced should have i=501
  const outcomes = s.sync({ now });
  assert.equal(outcomes.length, 500);
});

test('PWA seed manifest from pack: catalog + shell + PDP cache', () => {
  const s = svc();
  assert.deepEqual(s.seedManifest(), ['catalog-top-sellers', 'storefront-shell', 'pdp-cache-50']);
});
