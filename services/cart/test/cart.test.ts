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

test('add + get: totals computed, same offer merges with qty cap', async () => {
  const s = svc();
  let v = await s.add('c1', line('off_1', 16, 2));
  v = await s.add('c1', line('off_1', 16, 3));
  assert.equal(v.lines.length, 1);
  assert.equal(v.lines[0]!.qty, 5);
  assert.equal(v.total, 80);
  v = await s.add('c1', line('off_1', 16, 95));
  assert.equal(v.lines[0]!.qty, pack.policy.maxQtyPerLine); // capped at 99
});

test('update/remove/clear: qty 0 removes; cart isolated per customer', async () => {
  const s = svc();
  await s.add('c1', line('off_1', 10));
  await s.add('c1', line('off_2', 5));
  await s.add('c2', line('off_3', 7)); // other customer
  let v = await s.update('c1', 'off_1', 4);
  assert.equal(v.total, 4 * 10 + 5);
  v = await s.update('c1', 'off_1', 0); // qty 0 → removed
  assert.ok(!v.lines.some((l) => l.offerId === 'off_1'));
  v = await s.remove('c1', 'off_2');
  assert.equal(v.lines.length, 0);
  assert.equal((await s.get('c2')).lines.length, 1); // c2 untouched
  assert.equal((await s.clear('c2')).lines.length, 0);
});

test('pack caps enforced: maxLines, qty bounds', async () => {
  const s = svc();
  for (let i = 0; i < pack.policy.maxLines; i++) await s.add('c3', line(`off_${i}`, 1));
  await assert.rejects(async () => {await s.add('c3', line('off_over', 1))}, /cart full/);
  await assert.rejects(async () => {await s.add('c4', line('off_x', 1, 100));}, new RegExp(`qty cap is ${pack.policy.maxQtyPerLine}`));
  await assert.rejects(async () => {await s.add('c4', line('off_y', 1, 0))}, /qty must be >= 1/);
});

test('take: checkout consumes the cart (empties it)', async () => {
  const s = svc();
  await s.add('c5', line('off_1', 10));
  await s.add('c5', line('off_2', 5, 2));
  const lines = await s.take('c5');
  assert.equal(lines.length, 2);
  assert.equal((await s.get('c5')).lines.length, 0);
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
  const v = await (api['add'] as (c: string, l: Record<string, unknown>) => Promise<{ total: number }>)('c9', line('off_z', 3));
  assert.equal(v.total, 3);
  assert.deepEqual(events, ['cart.line.added']);
});

// ---------- distributed carts (cross-pod state on Storage SPI) ----------
test('STORE-BACKED carts: pod A adds, pod B sees + take() consumes across pods', async () => {
  const { SqlEngine } = await import('../../../kernel/storage-sql/src/index.ts');
  const path = `/tmp/aether-cart-${Date.now()}.db`;
  const a = new CartService(pack);
  a.attachStore(new SqlEngine(path));
  await a.add('cust_7', line('off_9', 12, 3));
  const b = new CartService(pack);
  b.attachStore(new SqlEngine(path));
  const view = await b.get('cust_7'); // cross-pod read
  assert.equal(view.total, 36);
  const taken = await b.take('cust_7');
  assert.equal(taken.length, 1);
  const after = await a.get('cust_7'); // consumption visible to pod A
  assert.equal(after.lines.length, 0);
});
