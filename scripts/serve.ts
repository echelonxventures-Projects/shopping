#!/usr/bin/env node
// LOCAL SERVER — boots the platform as modules + mounts them behind the
// model-driven HTTP gateway. All dummies (in-memory storage, demo PSP,
// demo billing). Demo credentials ship in the gateway pack (swap for
// KMS-backed packs in production).
// Usage: npm run serve   →  http://127.0.0.1:8080
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { ModuleRuntime, type BillingPort } from '../kernel/module/src/index.ts';
import { GatewayService, type GatewayPack } from '../services/gateway/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const log = (m: string) => console.log(m);

const demoBilling: BillingPort = {
  ledger: [] as string[],
  meter(event: string) { (this.ledger as string[]).push(event); },
};

const rt = new ModuleRuntime();
rt.bindHost(
  { tenantId: () => 'demo-tenant', storage: () => null, log: () => undefined },
  demoBilling
);

const MOUNT = ['catalog', 'inventory', 'search', 'tax', 'pricing', 'geo', 'payments', 'ai-commerce', 'orders', 'checkout', 'monetization'];
log('🚀 booting modules…');
for (const s of MOUNT) {
  const h = await rt.register(join(ROOT, 'services', s));
  await rt.configure(h.manifest.id);
}

// demo PSP (pack data declares routing; adapter here is the dummy)
const pay = rt.api('mod-payments') as Record<string, (...a: unknown[]) => unknown>;
pay.register({
  name: 'demo-psp',
  authorize: async (total: number) => ({ ok: true, pspRef: `demo_ch_${total}` }),
  capture: async () => ({ ok: true }),
  refund: async () => ({ ok: true }),
});
pay.route('demo-psp');

// seed search with a couple of demo products
const search = rt.api('mod-search') as Record<string, (...a: unknown[]) => unknown>;
await search.indexProduct('demo-tenant', { id: 'demo-tee-1', title: 'Navy Cotton Tee', attributes: { color: 'navy', size: 'm' } });
await search.indexProduct('demo-tenant', { id: 'demo-hoodie-1', title: 'Fleece Hoodie', attributes: { color: 'grey' } });

const gwPack = JSON.parse(readFileSync(join(ROOT, 'services/gateway/packs/gateway-core.json'), 'utf8')) as GatewayPack;
const gw = new GatewayService(gwPack);
for (const s of MOUNT) {
  const id = (JSON.parse(readFileSync(join(ROOT, 'services', s, 'module.json'), 'utf8')) as { id: string }).id;
  gw.mount(id, rt.api(id));
}
gw.mount('gateway', { routes: () => gw.listRoutes(), openapi: () => gw.openapi() });

// ---- demo saga adapter: checkout with dummy PSP + in-memory stock ----
const payApi = rt.api('mod-payments') as Record<string, (...a: unknown[]) => Promise<unknown>>;
const invApi = rt.api('mod-inventory') as Record<string, (...a: unknown[]) => unknown>;
const checkoutApi = rt.api('mod-checkout') as Record<string, (...a: unknown[]) => Promise<unknown>>;
const sagaStock = new Map<string, number>(); // demo stock for saga lines
gw.mountDemoSaga(async (args: Record<string, unknown>) => {
  type Line = { offerId: string; productId: string; sellerId: string; price: number; currency: string; qty: number };
  const lines = (args['cartLines'] as Line[]) ?? [];
  const idem = (args['idem'] as string) === 'auto' ? `idem-${Date.now()}` : (args['idem'] as string);
  // auto-seed demo stock if absent (demo behavior — production uses real inventory)
  for (const l of lines) if (!sagaStock.has(l.offerId)) { sagaStock.set(l.offerId, 50); invApi.setStock(l.offerId, 50); }
  const hooks = {
    authorizePayment: async (total: number, currency: string) => {
      const r = (await payApi.authorize(total, currency, 'tok_demo_saga')) as { ok: boolean; pspRef?: string };
      return r.ok ? { ok: true, pspRef: r.pspRef } : { ok: false, reason: 'denied' };
    },
    reserveInventory: async (ls: Line[]) => invApi.reserve(ls) as { ok: boolean; failed?: string[] },
    capturePayment: async (pspRef: string) => (await payApi.capture(pspRef)) as { ok: boolean },
    commitInventory: async (ls: Line[]) => { void invApi.commit([]); },
    releaseInventory: async (ls: Line[]) => { void invApi.release([]); },
    refund: async (pspRef: string, amount: number) => { void (await payApi.refund(pspRef, amount)); },
    notify: async (orderId: string) => { log(`   📬 saga notify: order ${orderId} confirmed`); },
  };
  const CartCtor = (await import(join(ROOT, 'services/checkout/src/index.ts'))) as { Cart: new () => { add(l: Line): void } };
  const cart = new CartCtor.Cart();
  for (const l of lines) cart.add(l);
  return checkoutApi.checkout(String(args['tenantId'] ?? 'demo-tenant'), cart, hooks, idem);
});

const srv = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const cors = { 'access-control-allow-origin': gwPack.cors.allowOrigins[0]!, 'content-type': 'application/json' };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors, 'access-control-allow-methods': gwPack.cors.allowMethods.join(', '), 'access-control-allow-headers': 'content-type,x-api-key' });
    return res.end();
  }
  let body: Record<string, unknown> = {};
  if (req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { body = {}; }
  }
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const { status, body: out } = await gw.handle(
    { method: req.method ?? 'GET', path: url.pathname, params: {}, query: Object.fromEntries(url.searchParams), body, headers },
    () => {}
  );
  res.writeHead(status, cors);
  res.end(JSON.stringify(out));
});

const { host, port } = gwPack.server;
srv.listen(port, host, () => {
  log(`\n🌐 AetherCommerce local API — http://${host}:${port}`);
  log('   GET  /health                     (no auth) — self-describing route list');
  log('   Auth header:  x-api-key: demo-admin-key-0000    (full access)');
  log('                x-api-key: demo-shopper-key-0000  (read-only + ai)');
  log('   Try:');
  log(`     curl http://${host}:${port}/health`);
  log(`     curl -H 'x-api-key: demo-shopper-key-0000' '${gwPack.server.publicBaseUrl}/search?q=tee'`);
  log(`     curl -H 'x-api-key: demo-admin-key-0000' -X POST -d '{"fact":{"market":"US","region":"CA"},"lines":[{"lineId":"l1","netAmount":100}]}' ${gwPack.server.publicBaseUrl}/tax/compute`);
  log('   Rate limit: 600 req/min (pack data). Ctrl-C to stop.\n');
});
