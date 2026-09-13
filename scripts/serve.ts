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
import { createServer as createTlsServer } from 'node:https';
import { ModuleRuntime, type BillingPort } from '../kernel/module/src/index.ts';
import { GatewayService, type GatewayPack } from '../services/gateway/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const log = (m: string) => console.log(m);

const demoBilling: BillingPort = {
  ledger: [] as string[],
  meter(event: string) { (this.ledger as string[]).push(event); },
};

// ---- STATE MODE: distributed (postgres-wire class) or single-pod in-memory ----
const pgDsn = process.env.AETHER_PG_DSN;
let stateEngine: import('../kernel/storage/src/index.ts').StorageEngine | null = null;
if (pgDsn) {
  const { PgEngine } = await import('../kernel/storage-pg/src/index.ts');
  const engine = new PgEngine({ connectionString: pgDsn, tablePrefix: 'platform_' });
  await engine.init();
  stateEngine = engine;
}
const rt = new ModuleRuntime();
rt.bindHost(
  { tenantId: () => 'demo-tenant', storage: () => stateEngine, log: () => undefined },
  demoBilling
);
log(stateEngine ? '   STATE: distributed (postgres-wire engine — sessions, carts, search, rate limits shared across pods)' : '   STATE: in-memory (single-pod dev mode)');

const MOUNT = ['catalog', 'inventory', 'search', 'tax', 'pricing', 'geo', 'payments', 'ai-commerce', 'orders', 'checkout', 'monetization', 'identity', 'cart'];
log('🚀 booting modules…');
for (const s of MOUNT) {
  const h = await rt.register(join(ROOT, 'services', s));
  await rt.configure(h.manifest.id);
}

if (stateEngine) {
  const ident = rt.api('mod-identity') as Record<string, unknown>;
  (ident['__raw'] as { attachStore: (e: unknown) => void }).attachStore(stateEngine);
  const cart = rt.api('mod-cart') as Record<string, unknown>;
  (cart['__raw'] as { attachStore: (e: unknown) => void }).attachStore(stateEngine);
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

const gwPack = JSON.parse(readFileSync(join(ROOT, 'services/gateway/packs/gateway-core.json'), 'utf8')) as GatewayPack;
const gw = new GatewayService(gwPack);
for (const s of MOUNT) {
  const id = (JSON.parse(readFileSync(join(ROOT, 'services', s, 'module.json'), 'utf8')) as { id: string }).id;
  gw.mount(id, rt.api(id));
}
gw.mount('gateway', { routes: () => gw.listRoutes(), openapi: () => gw.openapi() });
if (pgDsn) {
  const { PostgresRateLimiter } = await import('../kernel/storage-pg/src/index.ts');
  const limiter = new PostgresRateLimiter({ connectionString: pgDsn, tablePrefix: 'platform_' });
  gw.mountRateStore(limiter);
}

// ---- shopper flow: identity sessions + cart consumption ----
const identityApi = rt.api('mod-identity') as Record<string, (...a: unknown[]) => unknown>;
const cartApi = rt.api('mod-cart') as Record<string, (...a: unknown[]) => unknown>;
gw.mountIdentity((token: string) => identityApi['me'] as (t: string) => { customerId: string; email: string } | null ? (identityApi['me'] as (t: string) => { customerId: string; email: string } | null)(token) : null);
gw.mountCartConsume((customerId: string) => (cartApi['take'] as (c: string) => Array<Record<string, unknown>>)(customerId));


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

// ---- seed demo catalog: 3 products with offers + stock (shopper-ready) ----
const catalogApi = rt.api('mod-catalog') as Record<string, (...a: unknown[]) => Promise<unknown>>;
const seeded: Array<{ title: string; hs: string; price: number; seller: string; mode: string }> = [
  { title: 'Aether Classic Tee', hs: '6109.10', price: 25, seller: 'seller-1', mode: 'seller-fulfilled' },
  { title: 'Aether Fleece Hoodie', hs: '6110.20', price: 79, seller: 'seller-2', mode: 'platform-fulfilled' },
  { title: 'Aether Cap', hs: '6505.00', price: 19, seller: 'seller-1', mode: 'seller-fulfilled' },
];
const demoOffers: Array<{ productId: string; offerId: string; title: string; price: number; sellerId: string }> = [];
for (const s of seeded) {
  const p = (await catalogApi.createProduct('demo-tenant', { title: s.title, hsCode: s.hs, countryOfOrigin: 'IN' }, [])) as { id: string };
  const o = (await catalogApi.addOffer('demo-tenant', p.id, { sellerId: s.seller, price: s.price, currency: 'USD', fulfillmentMode: s.mode })) as { offerId: string };
  invApi.setStock(o.offerId, 50);
  demoOffers.push({ productId: p.id, offerId: o.offerId, title: s.title, price: s.price, sellerId: s.seller });
  await search.indexProduct('demo-tenant', { id: p.id, title: s.title, attributes: { category: 'apparel' } });
}
log(`🛍️  seeded ${demoOffers.length} shoppable products (${demoOffers.map((d) => `${d.title} @ $${d.price} [${d.offerId}]`).join(' · ')})`);
(gw as unknown as { demoOffers?: unknown }).demoOffers = demoOffers;

const tlsCfg = gwPack.server['tls'] as { envCert: string; envKey: string; hstsMaxAgeSeconds: number } | undefined;
const certFile = tlsCfg ? process.env[tlsCfg.envCert] : undefined;
const keyFile = tlsCfg ? process.env[tlsCfg.envKey] : undefined;
const tlsEnabled = Boolean(certFile && keyFile);

const srv = (tlsEnabled
  ? createTlsServer({ cert: readFileSync(certFile!), key: readFileSync(keyFile!) }, handler)
  : createServer(handler)) as import('node:http').Server;

async function handler(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const cors: Record<string, string> = { 'access-control-allow-origin': gwPack.cors.allowOrigins[0]!, 'content-type': 'application/json' };
  if (tlsEnabled && tlsCfg) cors['strict-transport-security'] = `max-age=${tlsCfg.hstsMaxAgeSeconds}; includeSubDomains`;
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
}

const { host, port } = gwPack.server;
// container deployments override the pack default via env (pack stays source of truth locally)
const bindHost = process.env.AETHER_BIND_HOST ?? host;
const bindPort = Number(process.env.AETHER_BIND_PORT ?? port);
srv.listen(bindPort, bindHost, () => {
  const scheme = tlsEnabled ? 'https' : 'http';
  log(`\n🌐 AetherCommerce local API — ${scheme}://${host}:${port}${tlsEnabled ? ' (TLS + HSTS from pack config)' : ''}`);
  log(`   GET  /health                     (no auth) — self-describing route list`);
  log(`   STATE: ${stateEngine ? 'distributed (postgres-wire)' : 'in-memory demo'}`);
  log('   Auth header:  x-api-key: demo-admin-key-0000    (full access)');
  log('                x-api-key: demo-shopper-key-0000  (read-only + ai)');
  log('   Try:');
  log(`     curl ${tlsEnabled ? '-k ' : ''}${scheme}://${host}:${port}/health`);
  log(`     curl -H 'x-api-key: demo-shopper-key-0000' '${gwPack.server.publicBaseUrl}/search?q=tee'`);
  log(`     curl -H 'x-api-key: demo-admin-key-0000' -X POST -d '{"fact":{"market":"US","region":"CA"},"lines":[{"lineId":"l1","netAmount":100}]}' ${gwPack.server.publicBaseUrl}/tax/compute`);
  log('   Rate limit: 600 req/min (pack data). Ctrl-C to stop.\n');
});
