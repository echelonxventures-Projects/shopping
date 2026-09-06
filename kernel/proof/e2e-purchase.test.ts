// E2E PROOF — full purchase flow across all kernel-apps (P1 integration gate):
// catalog (pack-driven product + offers + buy-box) → inventory (atomic reserve) →
// checkout saga (idempotent, compensating) → payments (adapter SPI, SAQ-A) →
// ledger (double-entry, sum-to-zero) — the whole chain driven by PACKS only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CatalogService } from '../../services/catalog/src/index.ts';
import { InventoryService } from '../../services/inventory/src/index.ts';
import { PaymentsService } from '../../services/payments/src/index.ts';
import { Cart, CheckoutService, Ledger } from '../../services/checkout/src/index.ts';
import { MemoryEngine } from '../../kernel/storage/src/index.ts';
import type { PspAdapter } from '../../services/payments/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const marketplacePack = JSON.parse(readFileSync(join(here, '../../packs/marketplace-core/pack.json'), 'utf8'));
const flowsPack = JSON.parse(readFileSync(join(here, '../../packs/commerce-flows/pack.json'), 'utf8'));

function pspAdapter(name: string): PspAdapter {
  return {
    name,
    authorize: async (total: number) => ({ ok: true, pspRef: `ch_${total}_xyz` }),
    capture: async () => ({ ok: true }),
    refund: async () => ({ ok: true }),
  };
}

test('E2E: browse → buy-box → reserve → pay → ledger — zero domain code, all pack-driven', async () => {
  // 1) catalog from pack
  const catalog = new CatalogService(new MemoryEngine(), marketplacePack, 'marketplace-sku', 'offer-id');
  const { id: productId } = await catalog.createProduct('tenant-e2e', { title: 'Cotton Tee', hsCode: '6109.10', countryOfOrigin: 'IN' }, ['EAN-9998887776661']);

  // 2) two sellers offer; buy-box prefers platform-fulfilled (rule from pack)
  await catalog.addOffer('tenant-e2e', productId, { sellerId: 's-1', price: 15, currency: 'USD', fulfillmentMode: 'seller-fulfilled' });
  await catalog.addOffer('tenant-e2e', productId, { sellerId: 's-2', price: 16, currency: 'USD', fulfillmentMode: 'platform-fulfilled' });
  const bb = await catalog.buyBox('tenant-e2e', productId);
  assert.equal(bb!.sellerId, 's-2');

  // 3) inventory seeded for the winning offer
  const inventory = new InventoryService();
  inventory.setStock(bb!.offerId, 1);

  // 4) checkout with real inventory + payments
  const payments = new PaymentsService();
  payments.register(pspAdapter('stripe-class'));
  payments.route('stripe-class');

  const checkout = new CheckoutService(flowsPack.workflows[0], flowsPack.rules, flowsPack.idSchemes);
  const cart = new Cart();
  cart.add({ offerId: bb!.offerId, productId, sellerId: 's-2', price: 16, currency: 'USD', qty: 1 });

  let reservationIds: string[] = [];
  let capturedRef: string | null = null;
  const result = await checkout.checkout('tenant-e2e', cart, {
    authorizePayment: async (total, currency) => {
      const r = await payments.authorize(total, currency, 'tok_visa_e2e');
      return r.ok ? { ok: true, pspRef: r.pspRef } : { ok: false, reason: r.reason };
    },
    reserveInventory: async (lines) => {
      const r = inventory.reserve(lines);
      reservationIds = r.reservationIds ?? [];
      return { ok: r.ok, failed: r.failed };
    },
    capturePayment: async (ref) => {
      const r = await payments.capture(ref);
      if (r.ok) { capturedRef = ref; payments.recordCapture(ref, cart.totals.subtotal); }
      return r;
    },
    commitInventory: async () => inventory.commit(reservationIds),
    releaseInventory: async () => inventory.release(reservationIds),
    refund: async (ref) => { await payments.refund(ref, cart.totals.subtotal); },
    notify: async () => { /* async queue */ },
  }, 'e2e-key-1');

  assert.equal(result.authorized, true);
  assert.equal(result.subOrders.length, 1);
  assert.equal(result.subOrders[0]!.sellerId, 's-2');
  assert.equal(inventory.available(bb!.offerId), 0); // sold out correctly

  // 5) ledger: sum-to-zero across payment + split + commission
  const ledger = new Ledger();
  checkout.postToLedger(ledger, result.orderId, result as never);
  assert.equal(ledger.invariantsHold(), true);

  // 6) EU display config still resolves (context stack alive end-to-end)
  assert.equal((catalog.displayConfig({ market: 'EU' }) as { taxMode: string }).taxMode, 'inclusive');
});

test('E2E: inventory exhaustion blocks checkout BEFORE payment (no charge on oversell)', async () => {
  const catalog = new CatalogService(new MemoryEngine(), marketplacePack, 'marketplace-sku', 'offer-id');
  const { id: productId } = await catalog.createProduct('tenant-e2e', { title: 'Rare Item', hsCode: '9701.91', countryOfOrigin: 'US' });
  const offer = await catalog.addOffer('tenant-e2e', productId, { sellerId: 's-1', price: 100, currency: 'USD' });

  const inventory = new InventoryService();
  inventory.setStock(offer.offerId, 0); // sold out

  const payments = new PaymentsService();
  payments.register(pspAdapter('adyen-class'));
  payments.route('adyen-class');
  let authAttempts = 0;

  const checkout = new CheckoutService(flowsPack.workflows[0], flowsPack.rules, flowsPack.idSchemes);
  const cart = new Cart();
  cart.add({ offerId: offer.offerId, productId, sellerId: 's-1', price: 100, currency: 'USD', qty: 1 });

  const result = await checkout.checkout('tenant-e2e', cart, {
    authorizePayment: async (t, c) => { authAttempts++; return (await payments.authorize(t, c, 'tok')).ok ? { ok: true, pspRef: 'x' } : { ok: false }; },
    reserveInventory: async (lines) => inventory.reserve(lines),
    capturePayment: async () => ({ ok: true }),
    commitInventory: async () => {},
    releaseInventory: async () => {},
    refund: async () => {},
    notify: async () => {},
  }, 'e2e-key-2');

  assert.equal(result.authorized, false);
  assert.equal(authAttempts, 0); // payment NEVER attempted when stock=0
});
