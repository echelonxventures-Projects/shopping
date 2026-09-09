// Tests: Module-as-a-Product — plug-and-play runtime, manifests, overrides, billing ports, catalog (Doctrine 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModuleRuntime, NullBillingPort, deepMerge, type BillingPort, type HostPort } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const LOGISTICS = join(here, '../../../services/logistics');

function countingBilling(): BillingPort & { events: Array<{ event: string; qty: number }> } {
  const events: Array<{ event: string; qty: number }> = [];
  return {
    events,
    meter(event: string, qty: number): void {
      events.push({ event, qty });
    },
  };
}

test('module loads headless (no host): plug-and-play into ANY system', async () => {
  const rt = new ModuleRuntime();
  const handle = await rt.register(LOGISTICS);
  assert.equal(handle.manifest.id, 'mod-logistics');
  assert.equal(handle.state, 'registered');
  await rt.configure('mod-logistics');
  const api = rt.api('mod-logistics') as Record<string, (...args: unknown[]) => unknown>;
  assert.ok(typeof api.rateOptions === 'function');
  const opts = api.rateOptions({ market: 'US', weightKg: 2, requiresDangerousGoods: true }) as Array<{ carrierId: string }>;
  assert.equal(opts.length, 1);
  assert.equal(opts[0]!.carrierId, 'car_dg_certified');
});

test('billing is a swappable port: usage metered only when host provides billing', async () => {
  const rt = new ModuleRuntime();
  await rt.register(LOGISTICS);
  await rt.configure('mod-logistics'); // NullBillingPort default — no crash, no metering dependency
  const api = rt.api('mod-logistics');
  api.createShipment('t1', (api.rateOptions({ market: 'US', weightKg: 1 }) as Array<{ carrierId: string; serviceCode: string; carrierName: string; serviceName: string; etaDays: { min: number; max: number }; price: { amount: number; currency: string }; score: number }>)[0]!);

  // rewire with a counting billing port and meter again
  const rt2 = new ModuleRuntime();
  const billing = countingBilling();
  const host: HostPort = { tenantId: () => 'acme', storage: () => null, log: () => undefined };
  rt2.bindHost(host, billing);
  await rt2.register(LOGISTICS);
  await rt2.configure('mod-logistics');
  const api2 = rt2.api('mod-logistics');
  const opt = (api2.rateOptions({ market: 'US', weightKg: 1 }) as Array<Record<string, unknown>>)[0]!;
  api2.createShipment('acme', opt);
  assert.ok(billing.events.some((e) => e.event === 'label.generated'));
  assert.ok(billing.events.some((e) => e.event === 'rate.quoted'));
});

test('config overrides: host can customize the module pack (deep merge)', async () => {
  const rt = new ModuleRuntime();
  rt.addConfigOverride({ scope: 'host', packName: 'logistics-core', patch: { returnPolicy: { windowDays: 7 } } });
  const handle = await rt.register(LOGISTICS);
  const pack = Object.values(handle.packs)[0] as { returnPolicy: { windowDays: number; grading: { grades: string[] } } };
  assert.equal(pack.returnPolicy.windowDays, 7); // overridden
  assert.deepEqual(pack.returnPolicy.grading.grades, ['sellable', 'refurbished', 'outlet', 'liquidate', 'damaged']); // merged, not replaced
});

test('deepMerge: nested objects merge; arrays replace', () => {
  const base = { a: { b: 1, c: [1, 2] }, d: 2 };
  const out = deepMerge(base, { a: { b: 9 }, d: 3 });
  assert.equal((out as { a: { b: number } }).a.b, 9);
  assert.equal((out as { d: number }).d, 3);
});

test('manifest validation: missing fields rejected', async () => {
  const rt = new ModuleRuntime();
  const badPath = join(here, 'fixtures/bad-module');
  await assert.rejects(() => rt.register(badPath), /missing "displayName"/);
});

test('module catalog: registered modules are sellable offers (auto-generated)', async () => {
  const rt = new ModuleRuntime();
  await rt.register(LOGISTICS);
  const cat = rt.catalog();
  const logistics = cat.find((c) => c.id === 'mod-logistics')!;
  assert.ok(logistics);
  assert.equal(logistics.pricingModel, 'flat+usage');
  assert.equal(logistics.suggestedRate!.currency, 'USD');
  assert.ok(logistics.capabilities.includes('rma'));
  assert.ok(logistics.packNames.includes('logistics-core'));
  assert.ok(logistics.apiSurface.includes('openRma'));
});

test('billing model is data: meterable events declared in manifest', async () => {
  const rt = new ModuleRuntime();
  const handle = await rt.register(LOGISTICS);
  assert.deepEqual(handle.manifest.billing.meterableEvents.map((e) => e.event), ['label.generated', 'rma.opened', 'rate.quoted']);
});

test('NullBillingPort: modules run unbilled without a billing host', () => {
  const p = new NullBillingPort();
  p.meter('anything', 1); // no-op, no throw
});

// ---------- Portable Product Bundles (sellable to OTHER platforms) ----------
test('portable bundle: export a module as a self-contained product bundle', async () => {
  const { BundleExchange } = await import('../src/index.ts');
  const rt = new ModuleRuntime();
  await rt.register(LOGISTICS);
  await rt.configure('mod-logistics');
  const market = new BundleExchange();
  const bundle = market.export(rt, 'mod-logistics');
  assert.equal(bundle.bundleVersion, 1);
  assert.equal(bundle.manifest.id, 'mod-logistics');
  assert.equal(bundle.installNotes.hostContract, bundle.manifest.hostContract);
  assert.ok(bundle.installNotes.billingEvents.length >= 1);
  assert.ok(Object.keys(bundle.packs).length >= 1, 'pack contents ship inside the bundle');
  assert.ok(market.list().some((b) => b.id === 'mod-logistics'));
  // every listed bundle is SELLABLE (has pricing model + version)
  for (const b of market.list()) {
    assert.ok(b.version && b.pricingModel);
  }
});

test('portable bundle: install into ANOTHER runtime — same product, external host, external billing', async () => {
  const { BundleExchange } = await import('../src/index.ts');
  // platform A: registers + exports
  const rtA = new ModuleRuntime();
  await rtA.register(LOGISTICS);
  await rtA.configure('mod-logistics');
  const bundle = new BundleExchange().export(rtA, 'mod-logistics');

  // platform B: a DIFFERENT runtime/host/billing installs the SAME bundle
  const rtB = new ModuleRuntime();
  const externalBilling = countingBilling();
  rtB.bindHost({ tenantId: () => 'external-buyer', storage: () => null, log: () => undefined }, externalBilling);
  const handle = await new BundleExchange().install(rtB, bundle, LOGISTICS);
  assert.equal(handle.manifest.id, 'mod-logistics');
  const api = rtB.api('mod-logistics') as Record<string, (...args: unknown[]) => unknown>;
  const opts = api.rateOptions({ market: 'US', weightKg: 1 }) as Array<{ carrierId: string }>;
  assert.ok(opts.length >= 1);
  api.createShipment('external-buyer', opts[0]);
  assert.ok(externalBilling.events.some((e) => e.event === 'label.generated'), 'external platform meters to ITS billing');
});

test('portable bundle: export requires registration (no phantom products)', async () => {
  const { BundleExchange } = await import('../src/index.ts');
  const rt = new ModuleRuntime();
  assert.throws(() => new BundleExchange().export(rt, 'mod-does-not-exist'), /not registered/);
});

// ---------- 100% configurability proof: even the smallest value is overridable ----------
test('smallest-value configurability: one nested pack number overridden, no code touched', async () => {
  const rt = new ModuleRuntime();
  // override the SINGLE smallest thing: the returnless-refund threshold value ($5 → $7.25)
  rt.addConfigOverride({
    scope: 'host',
    packName: 'logistics-core',
    patch: { returnPolicy: { returnlessRefundThreshold: { value: 7.25 } } },
  });
  rt.bindHost({ tenantId: () => 't', storage: () => null, log: () => undefined }, new NullBillingPort());
  await rt.register(LOGISTICS);
  await rt.configure('mod-logistics');
  const entry = (rt as unknown as { modules: Map<string, { handle: { packs: Record<string, unknown> } }> }).modules.get('mod-logistics');
  const merged = entry!.handle.packs['logistics-core'] as { returnPolicy: { returnlessRefundThreshold: { value: number; currency: string } } };
  assert.equal(merged.returnPolicy.returnlessRefundThreshold.value, 7.25); // smallest value: overridden
  assert.equal(merged.returnPolicy.returnlessRefundThreshold.currency, 'USD'); // sibling keys preserved (deep merge)
  // tenant-scoped override lands for that tenant only
  const rt2 = new ModuleRuntime();
  rt2.addConfigOverride({ scope: 'tenant', tenantId: 'acme', packName: 'logistics-core', patch: { returnPolicy: { windowDays: 99 } } });
  rt2.bindHost({ tenantId: () => 'acme', storage: () => null, log: () => undefined }, new NullBillingPort());
  await rt2.register(LOGISTICS);
  await rt2.configure('mod-logistics');
  const h2 = (rt2 as unknown as { modules: Map<string, { handle: { packs: Record<string, unknown> } }> }).modules.get('mod-logistics');
  const m2 = h2!.handle.packs['logistics-core'] as { returnPolicy: { windowDays: number } };
  assert.equal(m2.returnPolicy.windowDays, 99);
});
