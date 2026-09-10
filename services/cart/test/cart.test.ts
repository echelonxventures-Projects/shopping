// Tests: cart — add/update/remove/get/clear/take, pack caps, totals (shopper flow).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CartService } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/cart-core.json'), 'utf8'));
const svc = () => new CartService(pack);

const line = (offerId: string, price: number, qty = 1, title = 'Demo Tee') => ({
  offerId, productId: `p_${offerId}`, title, sellerId: 's-2', price, qty,
});

test('add + get: totals computed, same offer merges with qty cap', () => {
  const s = svc();
  let v = s.add('c1', line('off_1', 16, 2));
  v = s.add('c1', line('off_1', 16, 3));
  assert.equal(v.lines.length, 1);
  assert.equal(v.lines[0]!.qty, 5);
  assert.equal(v.total, 80);
  v = s.add('c1', line('off_1', 16, 95));
  assert.equal(v.lines[0]!.qty, pack.policy.maxQtyPerLine); // capped at 99
});

test('update/remove/clear: qty 0 removes; cart isolated per customer', () => {
  const s = svc();
  s.add('c1', line('off_1', 10));
  s.add('c1', line('off_2', 5));
  s.add('c2', line('off_3', 7)); // other customer
  let v = s.update('c1', 'off_1', 4);
  assert.equal(v.total, 4 * 10 + 5);
  v = s.update('c1', 'off_1', 0); // qty 0 → removed
  assert.ok(!v.lines.some((l) => l.offerId === 'off_1'));
  v = s.remove('c1', 'off_2');
  assert.equal(v.lines.length, 0);
  assert.equal(s.get('c2').lines.length, 1); // c2 untouched
  assert.equal(s.clear('c2').lines.length, 0);
});

test('pack caps enforced: maxLines, qty bounds', () => {
  const s = svc();
  for (let i = 0; i < pack.policy.maxLines; i++) s.add('c3', line(`off_${i}`, 1));
  assert.throws(() => s.add('c3', line('off_over', 1)), /cart full/);
  assert.throws(() => s.add('c4', line('off_x', 1, 100)), new RegExp(`qty cap is ${pack.policy.maxQtyPerLine}`));
  assert.throws(() => s.add('c4', line('off_y', 1, 0)), /qty must be >= 1/);
});

test('take: checkout consumes the cart (empties it)', () => {
  const s = svc();
  s.add('c5', line('off_1', 10));
  s.add('c5', line('off_2', 5, 2));
  const lines = s.take('c5');
  assert.equal(lines.length, 2);
  assert.equal(s.get('c5').lines.length, 0);
});

test('module contract: default export AetherModule, metered adds', async () => {
  const mod = (await import('../src/index.ts')).default;
  assert.equal(mod.manifest.id, 'mod-cart');
  const events: string[] = [];
  const api = await mod.create(
    { tenantId: () => 't', storage: () => null, log: () => {} },
    { meter: (e: string) => events.push(e) },
    { 'cart-core': pack }
  );
  const v = (api['add'] as (c: string, l: Record<string, unknown>) => { total: number })('c9', line('off_z', 3));
  assert.equal(v.total, 3);
  assert.deepEqual(events, ['cart.line.added']);
});
