// ALL-MODULES PROOF — the entire platform as plug-and-play modules:
// every service loads headless via ModuleRuntime (no platform wiring), runs its
// pack-bundled configuration, meters through a swappable BillingPort, and lists
// in the sellable module catalog. This is the Module-as-a-Product doctrine gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModuleRuntime, type BillingPort, type HostPort } from '@aether/kernel-module/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '../..');
const SERVICES = ['catalog', 'checkout', 'orders', 'tax', 'search', 'monetization', 'marketplace', 'product-master', 'payments', 'inventory', 'logistics', 'world' === 'never' ? '' : 'logistics'];

function countingBilling(): BillingPort & { events: string[] } {
  const events: string[] = [];
  return { events, meter(event: string): void { events.push(event); } };
}

test('EVERY service is a module: all load headless + configure + expose API', async () => {
  const rt = new ModuleRuntime();
  const dirs = ['catalog', 'checkout', 'orders', 'tax', 'search', 'monetization', 'marketplace', 'product-master', 'payments', 'inventory', 'logistics'];
  const ids: string[] = [];
  for (const d of dirs) {
    const handle = await rt.register(join(ROOT, 'services', d));
    ids.push(handle.manifest.id);
    await rt.configure(handle.manifest.id);
    const api = rt.api(handle.manifest.id);
    assert.ok(Object.keys(api).length > 1, `${d} module API is empty`);
  }
  assert.equal(ids.length, 11);
});

test('module catalog: 11 sellable module offers with pricing + API surface', async () => {
  const rt = new ModuleRuntime();
  for (const d of ['catalog', 'checkout', 'orders', 'tax', 'search', 'monetization', 'marketplace', 'product-master', 'payments', 'inventory', 'logistics']) {
    await rt.register(join(ROOT, 'services', d));
  }
  const catalog = rt.catalog();
  assert.equal(catalog.length, 11);
  const paid = catalog.filter((c) => c.pricingModel !== 'free');
  assert.ok(paid.length >= 10);
  assert.ok(catalog.every((c) => c.apiSurface.length > 0));
  assert.ok(catalog.some((c) => c.id === 'mod-tax' && c.capabilities.includes('facilitator-mode')));
  assert.ok(catalog.some((c) => c.id === 'mod-logistics' && c.capabilities.includes('rma')));
});

test('billing is swappable per module: metered usage flows to host billing', async () => {
  const billing = countingBilling();
  const host: HostPort = { tenantId: () => 'acme', storage: () => null, log: () => undefined };
  const rt = new ModuleRuntime();
  rt.bindHost(host, billing);

  // tax module meters tax.computed
  await rt.register(join(ROOT, 'services', 'tax'));
  await rt.configure('mod-tax');
  const tax = rt.api('mod-tax') as { compute: (f: unknown, l: unknown[]) => unknown };
  tax.compute({ market: 'EU' }, [{ lineId: 'l1', netAmount: 120 }]);
  assert.ok(billing.events.includes('tax.computed'));

  // search module meters search.query
  await rt.register(join(ROOT, 'services', 'search'));
  await rt.configure('mod-search');
  const search = rt.api('mod-search') as { indexProduct: (t: string, p: unknown) => Promise<void>; search: (q: unknown) => Promise<unknown> };
  await search.indexProduct('acme', { id: 'p1', title: 'Cotton Tee', attributes: { color: 'navy' } });
  await search.search({ tenantId: 'acme', text: 'cotton' });
  assert.ok(billing.events.includes('search.query'));
});

test('module config overrides customize ANY module without code', async () => {
  const rt = new ModuleRuntime();
  rt.addConfigOverride({ scope: 'host', packName: 'logistics-core', patch: { returnPolicy: { windowDays: 14 } } });
  const handle = await rt.register(join(ROOT, 'services', 'logistics'));
  const pack = Object.values(handle.packs)[0] as { returnPolicy: { windowDays: number; grading: { grades: string[] } } };
  assert.equal(pack.returnPolicy.windowDays, 14);
  assert.equal(pack.returnPolicy.grading.grades.length, 5); // deep-merged, not replaced
});

test('full commerce chain across modules: catalog → inventory → checkout → orders → tax → ledger', async () => {
  const billing = countingBilling();
  const host: HostPort = { tenantId: () => 'acme', storage: () => null, log: () => undefined };
  const rt = new ModuleRuntime();
  rt.bindHost(host, billing);

  for (const d of ['catalog', 'checkout', 'orders', 'tax', 'search', 'monetization', 'marketplace', 'product-master', 'payments', 'inventory', 'logistics']) {
    await rt.register(join(ROOT, 'services', d));
    await rt.configure(`mod-${d === 'product-master' ? 'product-master' : d}`);
  }

  const catalog = rt.api('mod-catalog') as {
    createProduct: (t: string, a: Record<string, unknown>) => Promise<{ id: string }>;
    addOffer: (t: string, p: string, o: { sellerId: string; price: number; currency: string; fulfillmentMode?: string }) => Promise<unknown>;
    buyBox: (t: string, p: string) => Promise<{ offerId: string; sellerId: string; price: number } | undefined>;
  };
  const inventory = rt.api('mod-inventory') as {
    setStock: (o: string, q: number) => void;
    reserve: (l: Array<{ offerId: string; qty: number }>) => { ok: boolean; reservationIds?: string[] };
    commit: (ids: string[]) => void;
  };
  const checkout = rt.api('mod-checkout') as {
    checkout: (t: string, cart: { lines: unknown[]; totals: { subtotal: number; currency: string } }, hooks: unknown, idem: string) => Promise<unknown>;
    postToLedger: (l: unknown, id: string, r: unknown) => void;
  };
  const tax = rt.api('mod-tax') as { compute: (f: { market: string }, l: Array<{ lineId: string; netAmount: number }>) => { totalTax: number; totalGross: number } };

  // 1) product + offers + buy-box
  const { id: pid } = await catalog.createProduct('acme', { title: 'Cotton Tee', hsCode: '6109.10', countryOfOrigin: 'IN' });
  await catalog.addOffer('acme', pid, { sellerId: 's-ff', price: 20, currency: 'USD', fulfillmentMode: 'platform-fulfilled' });
  await catalog.addOffer('acme', pid, { sellerId: 's-cheap', price: 19, currency: 'USD', fulfillmentMode: 'seller-fulfilled' });
  const bb = await catalog.buyBox('acme', pid);
  assert.equal(bb!.sellerId, 's-ff'); // rule prefers platform-fulfilled

  // 2) tax on the winning offer (EU inclusive: 20 gross → 16.67 net + 3.33 VAT)
  const taxResult = tax.compute({ market: 'EU' }, [{ lineId: 'l1', netAmount: bb!.price }]);
  assert.equal(taxResult.totalGross, 20); // gross preserved in inclusive mode
  assert.equal(taxResult.totalTax, 3.33);

  // 3) inventory + checkout saga
  inventory.setStock(bb!.offerId, 1);
  const { Cart, Ledger } = await import(join(ROOT, 'services/checkout/src/index.ts'));
  const cart = new Cart();
  cart.add({ offerId: bb!.offerId, productId: pid, sellerId: 's-ff', price: bb!.price, currency: 'USD', qty: 1 });
  let resIds: string[] = [];
  const result = (await checkout.checkout('acme', cart, {
    authorizePayment: async () => ({ ok: true, pspRef: 'ch_test_1' }),
    reserveInventory: async (lines) => { const r = inventory.reserve(lines as Array<{ offerId: string; qty: number }>); resIds = r.reservationIds ?? []; return r; },
    capturePayment: async () => ({ ok: true }),
    commitInventory: async () => inventory.commit(resIds),
    releaseInventory: async () => {},
    refund: async () => {},
    notify: async () => {},
  }, 'module-e2e-1')) as { authorized: boolean; orderId: string; subOrders: Array<{ sellerId: string; amount: number }> };
  assert.equal(result.authorized, true);

  // 4) ledger through the checkout module
  const ledger = new Ledger();
  checkout.postToLedger(ledger, result.orderId, result);
  assert.equal((ledger as unknown as { invariantsHold(): boolean }).invariantsHold(), true);

  // 5) billing saw the chain (checkout saga + tax metered through the BillingPort)
  assert.ok(billing.events.includes('order.placed'));
  assert.ok(billing.events.includes('tax.computed'));
});
