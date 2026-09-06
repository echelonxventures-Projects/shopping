// Tests: checkout saga + ledger invariants + commission rules from pack (P1-CRT-001, P1-ORD-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cart, CheckoutService, Ledger } from '../src/index.ts';
import type { SagaHooks } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../../../packs/commerce-flows/pack.json'), 'utf8'));

function makeCart(): Cart {
  const cart = new Cart();
  cart.add({ offerId: 'off-1', productId: 'p-1', sellerId: 'seller-a', price: 20, currency: 'USD', qty: 2 });
  cart.add({ offerId: 'off-2', productId: 'p-2', sellerId: 'seller-b', price: 5, currency: 'USD', qty: 1 });
  return cart;
}

function hooks(overrides: Partial<SagaHooks> = {}): SagaHooks {
  const state = { released: false, committed: false, refunded: false, notified: false };
  const base: SagaHooks & { state: typeof state } = {
    state,
    authorizePayment: async (total: number) => ({ ok: true, pspRef: `psp-${total}` }),
    reserveInventory: async () => ({ ok: true }),
    capturePayment: async (ref: string) => ({ ok: true, pspRef: ref }),
    commitInventory: async () => {
      base.state.committed = true;
    },
    releaseInventory: async () => {
      base.state.released = true;
    },
    refund: async () => {
      base.state.refunded = true;
    },
    notify: async () => {
      base.state.notified = true;
    },
    ...overrides,
  };
  return base;
}

test('multi-vendor checkout: split, commissions, ledger invariants all green', async () => {
  const svc = new CheckoutService(pack.workflows[0], pack.rules, pack.idSchemes);
  const cart = makeCart(); // seller-a: 40, seller-b: 5, total 45
  const h = hooks();
  const result = await svc.checkout('tenant-1', cart, h, 'idem-1');
  assert.equal(result.authorized, true);
  assert.equal(result.subOrders.length, 2);
  assert.deepEqual(result.subOrders.map((s) => s.sellerId).sort(), ['seller-a', 'seller-b']);

  // post exact subOrders through the ledger; verify double-entry invariants + commissions
  const feeA = svc.commissionFor('seller-a', 40).fee;
  const feeB = svc.commissionFor('seller-b', 5).fee;
  const ledger = new Ledger();
  svc.postToLedger(ledger, result.orderId, { ...result, subOrders: [
    { sellerId: 'seller-a', amount: 40, fee: feeA, status: 'created' },
    { sellerId: 'seller-b', amount: 5, fee: feeB, status: 'created' },
  ] } as never);
  assert.equal(ledger.invariantsHold(), true);
  const commissionCredits = ledger.all().filter((e) => e.account === 'revenue:commission').reduce((s, e) => s + e.credit, 0);
  assert.ok(commissionCredits > 0);
  assert.equal(commissionCredits, feeA + feeB);
});

test('payment-auth failure → inventory released, order not authorized', async () => {
  const svc = new CheckoutService(pack.workflows[0], pack.rules, pack.idSchemes);
  const h = hooks({ authorizePayment: async () => ({ ok: false, reason: 'card-declined' }) });
  const result = await svc.checkout('tenant-1', makeCart(), h, 'idem-2');
  assert.equal(result.authorized, false);
  assert.deepEqual(result.compensations, ['inventory-released']);
  assert.ok(result.trace.some((t) => t.step === 'authorize-payment' && !t.ok));
});

test('capture failure → compensate + auto-cancel', async () => {
  const svc = new CheckoutService(pack.workflows[0], pack.rules, pack.idSchemes);
  const h = hooks({ capturePayment: async () => ({ ok: false, reason: 'psp-timeout' }) });
  const result = await svc.checkout('tenant-1', makeCart(), h, 'idem-3');
  assert.equal(result.authorized, true); // was authorized
  assert.ok(result.compensations.includes('order-cancelled'));
});

test('inventory shortage blocks checkout before payment', async () => {
  const svc = new CheckoutService(pack.workflows[0], pack.rules, pack.idSchemes);
  const h = hooks({ reserveInventory: async () => ({ ok: false, failed: ['off-2'] }) });
  const result = await svc.checkout('tenant-1', makeCart(), h, 'idem-4');
  assert.equal(result.authorized, false);
  assert.equal(result.trace[0]!.step, 'reserve-inventory');
  assert.ok(!result.trace.some((t) => t.step === 'authorize-payment'));
});

test('idempotency: same key returns same order, no double-charge', async () => {
  const svc = new CheckoutService(pack.workflows[0], pack.rules, pack.idSchemes);
  let authCalls = 0;
  const h = hooks({ authorizePayment: async (t: number) => { authCalls++; return { ok: true, pspRef: `p-${t}` }; } });
  const r1 = await svc.checkout('t', makeCart(), h, 'idem-5');
  const r2 = await svc.checkout('t', makeCart(), h, 'idem-5');
  assert.equal(r1.orderId, r2.orderId);
  assert.equal(authCalls, 1);
});

test('notification failure never blocks checkout (graceful degradation)', async () => {
  const svc = new CheckoutService(pack.workflows[0], pack.rules, pack.idSchemes);
  const h = hooks({ notify: async () => { throw new Error('smtp down'); } });
  const result = await svc.checkout('tenant-1', makeCart(), h, 'idem-6');
  assert.equal(result.authorized, true);
  assert.ok(result.trace.some((t) => t.step === 'notify' && !t.ok && t.detail === 'async-retry-queued'));
});

test('commission rules from pack: premium seller gets 5%, others 10%', () => {
  const svc = new CheckoutService(pack.workflows[0], pack.rules, pack.idSchemes);
  assert.equal(svc.commissionFor('seller-premium', 100).rate, 0.05);
  assert.equal(svc.commissionFor('seller-a', 100).rate, 0.1);
});

test('ledger invariant violation is REJECTED (kernel math)', () => {
  const ledger = new Ledger();
  assert.throws(
    () => ledger.post('tx-bad', [{ account: 'a', debit: 10 }]),
    /Ledger invariant violated/
  );
});
