// Tests: orders — pack-driven state machine, durable transitions, lifecycle history (P1-ORD-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { OrdersService, OrderStateError } from '../src/index.ts';
import { MemoryEngine, FileEngine } from '@aether/kernel-storage/src/index.ts';
import type { WorkflowDef } from '@aether/kernel-primitives';

const here = dirname(fileURLToPath(import.meta.url));
const flows = JSON.parse(readFileSync(join(here, '../../../packs/commerce-flows/pack.json'), 'utf8'));
const wf = flows.workflows[0] as WorkflowDef;

function order(orderId = 'ord-1', tenantId = 't-1'): Parameters<OrdersService['place']>[0] {
  return {
    orderId, tenantId, customerId: 'cust-1',
    lines: [{ offerId: 'off-1', productId: 'p-1', sellerId: 's-1', qty: 1, unitPrice: 10 }],
    currency: 'USD', status: 'created', placedAt: new Date().toISOString(),
  };
}

for (const [label, mkEngine] of [
  ['memory', () => new MemoryEngine()],
  ['file (durable)', () => new FileEngine(join(tmpdir(), `orders-${Date.now()}-${Math.random()}.jsonl`))],
] as const) {
  test(`${label}: place → initial status from pack workflow`, async () => {
    const svc = new OrdersService(wf, mkEngine());
    const placed = await svc.place(order());
    assert.equal(placed.status, 'created');
    const got = await svc.get('t-1', 'ord-1');
    assert.equal(got!.status, 'created');
  });

  test(`${label}: legal lifecycle path created→confirmed→shipped→delivered→closed`, async () => {
    const svc = new OrdersService(wf, mkEngine());
    await svc.place(order('ord-2'));
    for (const [to, trigger] of [
      ['confirmed', 'payment-captured'],
      ['shipped', 'carrier-pickedup'],
      ['delivered', 'carrier-delivered'],
      ['closed', 'return-window-elapsed'],
    ] as const) {
      const ev = await svc.transition('t-1', 'ord-2', to, trigger);
      assert.equal(ev.to, to);
      assert.equal(ev.trigger, trigger);
    }
    assert.equal((await svc.get('t-1', 'ord-2'))!.status, 'closed');
  });

  test(`${label}: illegal transition rejected (created → delivered skips states)`, async () => {
    const svc = new OrdersService(wf, mkEngine());
    await svc.place(order('ord-3'));
    await assert.rejects(() => svc.transition('t-1', 'ord-3', 'delivered', 'carrier-delivered'), OrderStateError);
    assert.equal((await svc.get('t-1', 'ord-3'))!.status, 'created'); // unchanged
  });

  test(`${label}: bitemporal lifecycle history (all windows retrievable)`, async () => {
    const svc = new OrdersService(wf, mkEngine());
    await svc.place(order('ord-4'));
    await new Promise((r) => setTimeout(r, 2));
    await svc.transition('t-1', 'ord-4', 'confirmed', 'payment-captured');
    await new Promise((r) => setTimeout(r, 2));
    await svc.transition('t-1', 'ord-4', 'shipped', 'carrier-pickedup');
    const hist = await svc.history('t-1', 'ord-4');
    assert.equal(hist.length, 3); // created, confirmed, shipped windows
    const statuses = hist.map((h) => (h.attributes as { status: string }).status);
    assert.deepEqual(statuses, ['created', 'confirmed', 'shipped']);
  });
}

test('returned flow via delivered→returned (pack RMA path)', async () => {
  const svc = new OrdersService(wf, new MemoryEngine());
  await svc.place(order('ord-5'));
  await svc.transition('t-1', 'ord-5', 'confirmed', 'payment-captured');
  await svc.transition('t-1', 'ord-5', 'shipped', 'carrier-pickedup');
  await svc.transition('t-1', 'ord-5', 'delivered', 'carrier-delivered');
  const ev = await svc.transition('t-1', 'ord-5', 'returned', 'rma-approved');
  assert.equal(ev.to, 'returned');
});
