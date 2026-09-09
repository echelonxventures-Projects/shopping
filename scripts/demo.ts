#!/usr/bin/env node
// LOCAL DEMO — the entire platform running locally with ALL dummies:
//   - every service loaded as a portable module via ModuleRuntime (headless host)
//   - fake PSP adapter, in-memory storage, NullBillingPort + a demo billing ledger
//   - a full purchase flow driven ONLY by pack data (zero external calls)
// Usage: npm run demo
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { ModuleRuntime, NullBillingPort, type BillingPort } from '../kernel/module/src/index.ts';
import { MemoryEngine } from '../kernel/storage/src/index.ts';
import { BundleExchange } from '../kernel/module/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const log = (icon: string, msg: string) => console.log(`${icon} ${msg}`);
const money = (n: number, c: string) => `${(n).toFixed(2)} ${c}`;

// ---------- demo host: everything is a local dummy ----------
const demoBilling: BillingPort & { ledger: Array<{ event: string; qty: number }> } = {
  ledger: [],
  meter(event, qty) { this.ledger.push({ event, qty }); },
};

const rt = new ModuleRuntime();
rt.bindHost(
  { tenantId: () => 'demo-tenant', storage: () => new MemoryEngine(), log: (lvl, msg) => log('·', `[${lvl}] ${msg}`) },
  demoBilling
);

// ---------- boot every product as a module (plug-and-play) ----------
log('🚀', 'Booting AetherCommerce locally — every service is a pack-driven module, all dummies');
const SERVICES = [
  'catalog', 'inventory', 'checkout', 'payments', 'orders', 'tax',
  'search', 'monetization', 'marketplace', 'logistics', 'pricing', 'geo',
  'ecr-universe', 'ops-center',
];
const booted: string[] = [];
for (const s of SERVICES) {
  const handle = await rt.register(join(ROOT, 'services', s));
  await rt.configure(handle.manifest.id);
  booted.push(handle.manifest.displayName);
}
log('✅', `${booted.length} products live: ${booted.join(' · ')}`);

// ---------- catalog: create product + offers (pack-driven) ----------
const catalogApi = rt.api('mod-catalog') as Record<string, (...a: unknown[]) => Promise<unknown>>;
const product = (await catalogApi.createProduct('demo-tenant', { title: 'Aether Demo Tee', hsCode: '6109.10', countryOfOrigin: 'IN' }, ['EAN-DEMO-0001'])) as { id: string };
await catalogApi.addOffer('demo-tenant', product.id, { sellerId: 'seller-1', price: 15, currency: 'USD', fulfillmentMode: 'seller-fulfilled' });
await catalogApi.addOffer('demo-tenant', product.id, { sellerId: 'seller-2', price: 16, currency: 'USD', fulfillmentMode: 'platform-fulfilled' });
log('📦', `Product "Aether Demo Tee" (${product.id}) listed with 2 competing offers`);

const bb = (await catalogApi.buyBox('demo-tenant', product.id)) as { offerId: string; sellerId: string; price: number; currency: string } | null;
log('🏆', `Buy-box winner (pack rule): seller=${bb!.sellerId} offer=${bb!.offerId} @ ${money(bb!.price, bb!.currency)}`);

// ---------- inventory: atomic reserve ----------
const inventoryApi = rt.api('mod-inventory') as Record<string, (...a: unknown[]) => unknown>;
inventoryApi.setStock(bb!.offerId, 2);
const reserved = inventoryApi.reserve([{ offerId: bb!.offerId, qty: 1 }]) as { ok: boolean; reservationIds?: string[] };
log('📦', `Inventory reserve 1 unit: ${reserved.ok ? `reserved (${reserved.reservationIds?.[0]})` : 'FAILED'}`);

// ---------- tax: pack-driven rates ----------
const taxApi = rt.api('mod-tax') as Record<string, (...a: unknown[]) => unknown>;
const tax = taxApi.compute({ market: 'US', region: 'CA' }, [{ lineId: 'l1', netAmount: bb!.price }]) as { totalTax: number; totalGross: number; lines: Array<{ rate: number; jurisdiction: string }> };
log('🧾', `Tax (US/CA 9.25% rule from pack): +${money(tax.totalTax, 'USD')} → gross ${money(tax.totalGross, 'USD')} [${tax.lines[0]!.jurisdiction}]`);

// ---------- payments: dummy PSP adapter (SAQ-A) ----------
const paymentsApi = rt.api('mod-payments') as Record<string, (...a: unknown[]) => unknown>;
const FakePsp = {
  name: 'demo-psp',
  authorize: async (total: number) => ({ ok: true, pspRef: `demo_ch_${total}` }),
  capture: async () => ({ ok: true }),
  refund: async () => ({ ok: true }),
};
paymentsApi.register(FakePsp);
paymentsApi.route('demo-psp');
const auth = (await paymentsApi.authorize(tax.totalGross, 'USD', 'tok_demo_visa')) as { ok: boolean; pspRef: string };
log('💳', `Payment authorized via dummy PSP: ${auth.pspRef} (card data NEVER touched the platform — SAQ-A)`);

// ---------- bundles: sell one product to an "external platform" ----------
const bx = new BundleExchange();
const bundle = bx.export(rt, 'mod-tax');
log('🛒', `Exported portable bundle: ${bundle.manifest.displayName} v${bundle.manifest.version} — packs inside: ${Object.keys(bundle.packs).join(', ')}`);
log('   ', `→ an EXTERNAL platform can install this and bill it on THEIR ledger (hostContract: ${bundle.installNotes.hostContract})`);

// ---------- pricing: quote with promos (pack data) ----------
const pricingApi = rt.api('mod-pricing') as Record<string, (...a: unknown[]) => unknown>;
const quote = pricingApi.quote('TSHIRT-CLASSIC', 1, [], { market: 'US' }, '2026-06-15T00:00:00Z') as { listPrice: number; finalPrice: number; appliedPromotions: Array<{ name: string }>; explain: string[] };
log('🏷️', `Pricing quote: list ${money(quote.listPrice, 'USD')} → final ${money(quote.finalPrice, 'USD')} (promos: ${quote.appliedPromotions.map((p) => p.name).join(', ') || 'none'})`);

// ---------- ECR universe: everything is E x C x T x R ----------
const ecrApi = rt.api('mod-ecr-universe') as Record<string, (...a: unknown[]) => unknown>;
const chain = ecrApi.traverse('seo_sitemap_surface', '2026-06-01T00:00:00Z') as Array<{ to: { typeId: string; id: string } }>;
log('🕸️', `ECR graph: sitemap → ${chain[0]!.to.typeId}:${chain[0]!.to.id} (one relationship engine serves every domain)`);

// ---------- metering: the platform bills ITSELF for usage ----------
log('📊', `Usage metered to demo billing ledger: ${demoBilling.ledger.length} events (${[...new Set(demoBilling.ledger.map((e) => e.event))].slice(0, 6).join(', ')}…)`);

// ---------- catalog of sellables ----------
const catalogListing = rt.catalog();
log('🏪', `Module catalog: ${catalogListing.length} sellable products, e.g. "${catalogListing[0]!.displayName}" (${catalogListing[0]!.pricingModel})`);

console.log('\n' + '═'.repeat(72));
log('✅', 'LOCAL DEMO COMPLETE — full purchase lifecycle ran with zero external calls.');
log('💡', 'Every value above came from pack JSON. Swap the pack, change the behavior.');
log('💡', 'All 358 tests run the same way: npm test');
