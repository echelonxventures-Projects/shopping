// Tests: inventory — atomic reservations, oversell=0, TTL reaping, commit/release (P1-INV-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InventoryService } from '../src/index.ts';

test('atomic all-or-nothing reserve across lines', () => {
  const inv = new InventoryService();
  inv.setStock('a', 5);
  inv.setStock('b', 1);
  const ok = inv.reserve([{ offerId: 'a', qty: 2 }, { offerId: 'b', qty: 2 }]);
  assert.equal(ok.ok, false);
  assert.deepEqual(ok.failed, ['b']);
  assert.equal(inv.available('a'), 5); // nothing reserved (all-or-nothing)
});

test('oversell impossible under sequential + concurrent-style reservations', () => {
  const inv = new InventoryService();
  inv.setStock('hot', 3);
  const r1 = inv.reserve([{ offerId: 'hot', qty: 2 }]);
  const r2 = inv.reserve([{ offerId: 'hot', qty: 2 }]);
  assert.ok(r1.ok);
  assert.equal(r2.ok, false); // only 1 left
  const r3 = inv.reserve([{ offerId: 'hot', qty: 1 }]);
  assert.ok(r3.ok);
  assert.equal(inv.available('hot'), 0);
});

test('commit deducts stock; release returns availability; TTL expiry auto-releases', async () => {
  const inv = new InventoryService({ ttlMs: 5 });
  inv.setStock('x', 10);
  const r1 = inv.reserve([{ offerId: 'x', qty: 3 }]);
  inv.commit(r1.reservationIds!);
  assert.equal(inv.available('x'), 7);
  assert.equal(inv.stock.get('x'), 7);

  const r2 = inv.reserve([{ offerId: 'x', qty: 2 }]);
  assert.equal(inv.available('x'), 5);
  inv.release(r2.reservationIds!);
  assert.equal(inv.available('x'), 7);

  const r3 = inv.reserve([{ offerId: 'x', qty: 4 }]);
  assert.equal(inv.available('x'), 3);
  await new Promise((res) => setTimeout(res, 10));
  inv.reappear(); // reaper run
  assert.equal(inv.available('x'), 7); // expired reservation returned
});

test('policy limits: qty cap from config', () => {
  const inv = new InventoryService({ maxQtyPerLine: 2 });
  inv.setStock('y', 100);
  assert.equal(inv.reserve([{ offerId: 'y', qty: 3 }]).ok, false);
  assert.equal(inv.reserve([{ offerId: 'y', qty: 2 }]).ok, true);
});
