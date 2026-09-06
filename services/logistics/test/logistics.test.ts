// Tests: logistics — carrier registry rate shopping w/ capability filters, tracking
// events, RMA lifecycle w/ grading + returnless refunds + window enforcement (P1-LOG-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LogisticsService, LogisticsError } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../../../packs/logistics-core/pack.json'), 'utf8'));
const svc = () => new LogisticsService(pack);

test('rate shopping: capability filtering — dangerous goods only via DG-certified carrier', () => {
  const s = svc();
  const dg = s.rateOptions({ market: 'US', weightKg: 2, requiresDangerousGoods: true });
  assert.equal(dg.length, 1);
  assert.equal(dg[0]!.carrierId, 'car_dg_certified');
  // without the DG requirement, more carriers are eligible
  const normal = s.rateOptions({ market: 'US', weightKg: 2 });
  assert.ok(normal.length > dg.length);
});

test('rate shopping: cold chain routes to ColdChain/EuroPost carriers only', () => {
  const s = svc();
  const cold = s.rateOptions({ market: 'US', weightKg: 3, requiresColdChain: true });
  assert.ok(cold.every((o) => o.carrierId === 'car_cold_chain'));
});

test('rate shopping: market scoping — IN picks regional carrier with INR rates', () => {
  const s = svc();
  const inr = s.cheapest({ market: 'IN', weightKg: 1 });
  assert.ok(inr);
  const regional = s.rateOptions({ market: 'IN', weightKg: 1 }).filter((o) => o.carrierId === 'car_regional_in');
  assert.equal(regional.length, 2); // STD + SDD
  assert.equal(regional[0]!.price.currency, 'INR');
});

test('rate math: base + perKg from pack rate card', () => {
  const s = svc();
  const opt = s.rateOptions({ market: 'US', weightKg: 2 }).find((o) => o.carrierId === 'car_global_express' && o.serviceCode === 'STD')!;
  assert.ok(Math.abs(opt.price.amount - 7.39) < 0.001); // 4.99 + 1.20*2, rounded
});

test('COD requirement filters non-COD carriers (EU EuroPost lacks COD)', () => {
  const s = svc();
  const cod = s.rateOptions({ market: 'EU', weightKg: 1, requiresCod: true });
  assert.equal(cod.filter((o) => o.carrierId === 'car_regional_eu').length, 0);
});

test('tracking: shipment lifecycle events from pack definitions', () => {
  const s = svc();
  const opt = s.cheapest({ market: 'US', weightKg: 1 })!;
  const { trackingId } = s.createShipment('t1', opt);
  s.pushTracking('t1', trackingId, 'picked-up', 'Hub A');
  s.pushTracking('t1', trackingId, 'in-transit', 'Hub B');
  s.pushTracking('t1', trackingId, 'delivered', 'Doorstep');
  const hist = s.trackingHistory('t1', trackingId);
  assert.equal(hist.length, 4); // label-created + 3
  assert.equal(hist[3]!.progress, 100);
  assert.throws(() => s.pushTracking('t1', trackingId, 'teleported'), LogisticsError); // unknown event
});

test('RMA: within window → approved; outside window → rejected (policy data)', () => {
  const s = svc();
  const now = Date.now();
  const fresh = s.openRma({
    rmaId: 'r1', tenantId: 't1', orderId: 'o1',
    orderPlacedAt: new Date(now - 5 * 86_400_000).toISOString(),
    lineItem: { offerId: 'x', qty: 1, unitPrice: 40, currency: 'USD' }, orderValue: 40,
  });
  assert.equal(fresh.status, 'requested');
  s.advanceRma('t1', 'r1', 'approved', 'return-window-valid');
  s.advanceRma('t1', 'r1', 'in-transit', 'label-generated');
  s.advanceRma('t1', 'r1', 'received', 'carrier-scanned-inbound');
  const graded = s.gradeRma('t1', 'r1', 'sellable');
  assert.equal(graded.refundAmount, 40);
  s.advanceRma('t1', 'r1', 'refunded', 'grade-accepted');

  const stale = s.openRma({
    rmaId: 'r2', tenantId: 't1', orderId: 'o2',
    orderPlacedAt: new Date(now - 45 * 86_400_000).toISOString(), // > 30-day window
    lineItem: { offerId: 'x', qty: 1, unitPrice: 40, currency: 'USD' }, orderValue: 40,
  });
  assert.equal(stale.status, 'rejected');
});

test('RMA: returnless refund for low-value items (threshold from pack)', () => {
  const s = svc();
  const cheap = s.openRma({
    rmaId: 'r3', tenantId: 't1', orderId: 'o3',
    orderPlacedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    lineItem: { offerId: 'x', qty: 1, unitPrice: 4.5, currency: 'USD' }, orderValue: 4.5, // ≤ $5 threshold
  });
  assert.equal(cheap.status, 'refunded');
  assert.equal(cheap.refundAmount, 4.5);
  assert.ok(cheap.events.some((e) => e.trigger === 'returnless-refund'));
});

test('RMA grading factors: refurbished 85%, damaged 0% (pack data)', () => {
  const s = svc();
  s.openRma({
    rmaId: 'r4', tenantId: 't1', orderId: 'o4',
    orderPlacedAt: new Date(Date.now() - 1 * 86_400_000).toISOString(),
    lineItem: { offerId: 'x', qty: 1, unitPrice: 100, currency: 'USD' }, orderValue: 100,
  });
  s.advanceRma('t1', 'r4', 'approved', 'return-window-valid');
  s.advanceRma('t1', 'r4', 'in-transit', 'label-generated');
  s.advanceRma('t1', 'r4', 'received', 'carrier-scanned-inbound');
  const refurbed = s.gradeRma('t1', 'r4', 'refurbished');
  assert.equal(refurbed.refundAmount, 85);
  assert.equal(refurbed.restockFee, 5); // 5% restock per pack
  assert.throws(() => s.gradeRma('t1', 'r4', 'mystery-grade'), LogisticsError);
});

test('serial-returner detection: thresholds from pack flag abuse', () => {
  const s = svc();
  // service semantics: rate = returns / non-return orders; flagged when count ≥ 10 AND rate ≥ 0.6
  for (let i = 0; i < 15; i++) s.recordCustomerOrder('t1', 'cust-x', false); // 15 orders
  for (let i = 0; i < 12; i++) s.recordCustomerOrder('t1', 'cust-x', true); // 12 returns → 80% rate, count 12
  assert.equal(s.customerReturnProfile('t1', 'cust-x').flagged, true); // both thresholds met
  for (let i = 0; i < 5; i++) s.recordCustomerOrder('t1', 'cust-z', false); // 5 orders
  for (let i = 0; i < 4; i++) s.recordCustomerOrder('t1', 'cust-z', true); // 80% rate but count 4 < 10
  assert.equal(s.customerReturnProfile('t1', 'cust-z').flagged, false); // below count threshold
  for (let i = 0; i < 10; i++) s.recordCustomerOrder('t1', 'cust-w', false); // 10 orders
  for (let i = 0; i < 5; i++) s.recordCustomerOrder('t1', 'cust-w', true); // count 5 < 10
  assert.equal(s.customerReturnProfile('t1', 'cust-w').flagged, false); // below count threshold despite 50% rate
});
