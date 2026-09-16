// Tests: unified commerce / POS — register sessions + float reconciliation,
// pack-defined RFID/barcode scan formats, tender/change rules, BOPIS hold
// windows + high-value ID check, offline queue + price-drift protection
// (P1-UCA-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PosService, PosError, type PosPack, type PosLine } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/pos-core.json'), 'utf8')) as PosPack;
const svc = () => new PosService(pack);
const line = (sku: string, price: number, qty = 1): PosLine => ({ sku, qty, unitPrice: price, currency: 'USD' });

test('register session: float declaration required by policy; per-store session cap enforced', () => {
  const s = svc();
  assert.throws(() => s.openSession('store-1', 'reg-1', 'cashier-1'), /float must be declared/);
  const a = s.openSession('store-1', 'reg-1', 'cashier-1', 200);
  assert.equal(a.status, 'open');
  assert.equal(a.openingFloat, 200);
  for (let i = 2; i <= pack.registerPolicy.maxOpenSessionsPerStore; i++) s.openSession('store-1', `reg-${i}`, 'cashier-1', 100);
  assert.throws(() => s.openSession('store-1', 'reg-over', 'cashier-1', 100), /policy cap/);
});

test('scan: RFID EPC + barcode formats resolved from pack; unknown format rejected', () => {
  const s = svc();
  const rfid = s.scan('E28011700000020F5C4A9B12');
  assert.equal(rfid.formatId, 'rfid-epc');
  assert.equal(rfid.kind, 'rfid');
  assert.equal(rfid.value, 'E28011700000020F5C4A9B12');
  const gtin = s.scan('4006381333931');
  assert.equal(gtin.formatId, 'ean13');
  assert.equal(gtin.payload, 'gtin');
  const badge = s.scan('stf-cashier-77');
  assert.equal(badge.formatId, 'staff-badge');
  assert.equal(badge.payload, 'badge');
  assert.throws(() => s.scan('@@NOPE@@'), /matches no registered format/);
});

test('scan: duplicate suppression window from pack (same code twice = duplicate)', () => {
  const s = svc();
  const t0 = 1_700_000_000_000;
  const first = s.scan('E28011700000020F5C4A9B12', t0);
  const again = s.scan('E28011700000020F5C4A9B12', t0 + 500);
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  const later = s.scan('E28011700000020F5C4A9B12', t0 + pack.scanPolicy.dedupeWithinSeconds * 1000 + 1);
  assert.equal(later.duplicate, false);
});

test('tender: cash overpay returns change; card-only overpay refused; auth required for card', () => {
  const s = svc();
  const sess = s.openSession('store-2', 'reg-1', 'c1', 100);
  const lines = [line('SKU-A', 20, 2)]; // 40.00
  const cash = s.tender(sess.sessionId, lines, [{ type: 'cash', amount: 50 }]);
  assert.equal(cash.total, 40);
  assert.equal(cash.tenders[0]!.change, 10);
  assert.match(cash.receiptNo, /^POS-store-2-reg-1-000001$/);
  assert.throws(() => s.tender(sess.sessionId, lines, [{ type: 'card', amount: 45, authRef: 'auth-1' }]), /cannot be returned/);
  assert.throws(() => s.tender(sess.sessionId, lines, [{ type: 'card', amount: 40 }]), /requires an auth reference/);
  assert.throws(() => s.tender(sess.sessionId, lines, [{ type: 'crypto-magic', amount: 40 }]), /unknown tender type/);
});

test('closeSession: cash drawer reconciled against pack variance tolerance', () => {
  const s = svc();
  const sess = s.openSession('store-3', 'reg-1', 'c1', 200);
  s.tender(sess.sessionId, [line('SKU-A', 30)], [{ type: 'cash', amount: 30 }]);
  const ok = s.closeSession(sess.sessionId, 230); // 200 float + 30 cash
  assert.equal(ok.expectedCash, 230);
  assert.equal(ok.variance, 0);
  assert.equal(ok.withinTolerance, true);
  assert.equal(ok.reviewRequired, false);

  const s2 = svc();
  const sess2 = s2.openSession('store-3', 'reg-2', 'c1', 200);
  const short = s2.closeSession(sess2.sessionId, 195); // -5.00 beyond 0.50 tolerance
  assert.equal(short.variance, -5);
  assert.equal(short.withinTolerance, false);
  assert.equal(short.reviewRequired, true);
  assert.throws(() => s2.tender(sess2.sessionId, [line('SKU-A', 1)], [{ type: 'cash', amount: 1 }]), /is closed/);
});

test('BOPIS: hold window + pickup code + high-value ID verification from pack', () => {
  const s = svc();
  const t0 = '2026-09-16T10:00:00Z';
  const hold = s.holdForPickup('store-4', 'order-9', [line('SKU-B', 25, 2)], t0); // value 50
  assert.equal(hold.status, 'held');
  assert.equal(hold.code.length, pack.bopisPolicy.pickupCodeLength);
  assert.throws(() => s.confirmPickup(hold.holdId, 'WRONG1', false, t0), /code does not match/);
  const picked = s.confirmPickup(hold.holdId, hold.code, false, '2026-09-16T12:00:00Z');
  assert.equal(picked.status, 'picked-up');
  assert.throws(() => s.confirmPickup(hold.holdId, hold.code, true, '2026-09-16T12:00:00Z'), /already completed/);

  // expiry path
  const stale = s.holdForPickup('store-4', 'order-10', [line('SKU-C', 10)], t0);
  assert.throws(() => s.confirmPickup(stale.holdId, stale.code, false, '2026-09-20T10:00:00Z'), /expired/);

  // high-value requires ID
  const big = s.holdForPickup('store-4', 'order-11', [line('SKU-D', 600)], t0);
  assert.throws(() => s.confirmPickup(big.holdId, big.code, false, t0), /requires ID verification/);
  assert.equal(s.confirmPickup(big.holdId, big.code, true, t0).status, 'picked-up');
});

test('offline: queue cap, priority sync order, price-drift HOLDS the action (conflict strategy)', () => {
  const s = svc();
  const sess = s.openSession('store-5', 'reg-1', 'c1', 50);
  s.tender(sess.sessionId, [line('SKU-A', 100)], [{ type: 'cash', amount: 100 }], 'USD', true); // queued as sale
  s.captureOffline('stock-count', { sku: 'SKU-A', counted: 9 });
  s.captureOffline('refund', { saleId: 'sale-1', amount: 20 });
  const depth = s.queueDepth();
  assert.equal(depth.total, 3);
  assert.equal(depth.byKind['sale'], 1);

  // price moved 20% on the queued sale → HELD, not posted
  const out = s.syncQueue({ livePriceFor: (p) => (p['receiptNo'] ? 120 : undefined) });
  assert.equal(out.replayed, 2); // stock-count + refund (no price check)
  assert.equal(out.held.length, 1);
  assert.match(out.held[0]!.reason, /price drift 20% exceeds tolerance 2%/);
  assert.equal(s.queueDepth().total, 1);

  // within tolerance → replays
  const ok = s.syncQueue({ livePriceFor: () => 101 });
  assert.equal(ok.replayed, 1);
  assert.equal(ok.held.length, 0);
  assert.equal(s.queueDepth().total, 0);
});

test('offline: queue cap is pack data', () => {
  const s = new PosService({ ...pack, offlinePolicy: { ...pack.offlinePolicy, maxQueuedActions: 2 } });
  s.captureOffline('sale', { a: 1 });
  s.captureOffline('sale', { a: 2 });
  assert.throws(() => s.captureOffline('sale', { a: 3 }), /offline queue full/);
});

test('session report: sales + total per register session', () => {
  const s = svc();
  const sess = s.openSession('store-6', 'reg-1', 'c1', 100);
  s.tender(sess.sessionId, [line('SKU-A', 10, 2)], [{ type: 'cash', amount: 20 }]);
  s.tender(sess.sessionId, [line('SKU-B', 5)], [{ type: 'gift-card', amount: 5 }]);
  const r = s.sessionReport(sess.sessionId);
  assert.equal(r.sales.length, 2);
  assert.equal(r.total, 25);
  assert.equal(r.session.receiptSeq, 2);
});

test('module contract: default export AetherModule, metered sale/pickup/session-close', async () => {
  const mod = (await import('../src/index.ts')).default;
  assert.equal(mod.manifest.id, 'mod-pos');
  const events: string[] = [];
  const api = await mod.create(
    { tenantId: () => 't', storage: () => null, log: () => {} },
    { meter: (e: string) => events.push(e) },
    { 'pos-core': pack }
  );
  const sess = (api['openSession'] as (s: string, r: string, c: string, f: number) => { sessionId: string })('store-9', 'reg-1', 'c1', 100);
  (api['tender'] as (sid: string, l: PosLine[], t: Array<{ type: string; amount: number }>) => unknown)(sess.sessionId, [line('SKU-A', 5)], [{ type: 'cash', amount: 5 }]);
  const hold = (api['holdForPickup'] as (s: string, o: string, l: PosLine[]) => { holdId: string; code: string })('store-9', 'o-1', [line('SKU-A', 5)]);
  (api['confirmPickup'] as (h: string, c: string, v: boolean) => unknown)(hold.holdId, hold.code, false);
  (api['closeSession'] as (sid: string, c: number) => unknown)(sess.sessionId, 105);
  assert.deepEqual(events, ['pos.sale.completed', 'pos.pickup.confirmed', 'pos.session.closed']);
});