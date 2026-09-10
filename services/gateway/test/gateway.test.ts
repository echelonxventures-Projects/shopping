// Tests: API Gateway — model-driven routes from pack, api-key scopes, rate
// limits, JSON-path argument mapping, self-describing /health, mount contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewayService, resolveExpr, type GatewayPack, type GatewayRequestCtx } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/gateway-core.json'), 'utf8')) as GatewayPack;
const ADMIN = { 'x-api-key': 'demo-admin-key-0000' };
const SHOPPER = { 'x-api-key': 'demo-shopper-key-0000' };

function ctx(method: string, path: string, body: Record<string, unknown> = {}, headers: Record<string, string> = ADMIN, query: Record<string, string> = {}): GatewayRequestCtx {
  return { method, path, params: {}, query, body, headers };
}

test('routes are pack data: /health self-describes the entire surface', async () => {
  const gw = new GatewayService(pack);
  // the gateway mounts ITSELF for /health (self-describing surface)
  gw.mount('gateway', { routes: () => gw.listRoutes() });
  const r = await gw.handle(ctx('GET', '/health'), () => {});
  assert.equal(r.status, 200);
  const routes = (r.body as { data: Array<{ path: string; scope: string | null }> }).data;
  assert.ok(routes.length >= 10);
  assert.ok(routes.some((x) => x.path === '/tax/compute'));
  assert.ok(routes.some((x) => x.path === '/catalog/buybox/:id'));
});

test('auth: missing/invalid key → 401; valid key passes (demo keys are pack data)', async () => {
  const gw = new GatewayService(pack);
  gw.mount('mod-tax', { compute: () => ({ totalTax: 1 }) });
  const anon = await gw.handle(ctx('POST', '/tax/compute', { fact: { market: 'US' }, lines: [] }, {}), () => {});
  assert.equal(anon.status, 401);
  const bad = await gw.handle(ctx('POST', '/tax/compute', {}, { 'x-api-key': 'wrong' }), () => {});
  assert.equal(bad.status, 401);
  const ok = await gw.handle(ctx('POST', '/tax/compute', { fact: { market: 'US' }, lines: [{ lineId: 'l', netAmount: 100 }] }), () => {});
  assert.equal(ok.status, 200);
});

test('scopes: shopper key cannot write catalog (403), admin can', async () => {
  const gw = new GatewayService(pack);
  let created: unknown = null;
  gw.mount('mod-catalog', {
    createProduct: async (_t: string, attrs: Record<string, unknown>) => (created = attrs, { id: 'p1' }),
    listOffers: async () => [],
    addOffer: async () => ({ offerId: 'o1' }),
    buyBox: async () => null,
  });
  const forbidden = await gw.handle(ctx('POST', '/catalog/products', { title: 'X' }, SHOPPER), () => {});
  assert.equal(forbidden.status, 403);
  assert.ok(JSON.stringify(forbidden.body).includes('catalog:write'));
  const allowed = await gw.handle(ctx('POST', '/catalog/products', { title: 'Aether Tee' }, ADMIN), () => {});
  assert.equal(allowed.status, 200);
  assert.deepEqual(created, { title: 'Aether Tee' });
});

test('path params + JSON-path mapping: /catalog/buybox/:id maps $.params.id', async () => {
  const gw = new GatewayService(pack);
  let seenId: string | null = null;
  gw.mount('mod-catalog', { buyBox: async (t: string, p: string) => (seenId = p, { offerId: 'win' }) });
  const r = await gw.handle(ctx('GET', '/catalog/buybox/prod_12345'), () => {});
  assert.equal(r.status, 200);
  assert.equal(seenId, 'prod_12345');
});

test('query mapping + defaults: /search?q=tee&limit=5 → {tenantId, text, limit}', async () => {
  const gw = new GatewayService(pack);
  let q: unknown = null;
  gw.mount('mod-search', { search: (query: unknown) => (q = query, { hits: [] }), indexProduct: async () => {} });
  const r = await gw.handle(ctx('GET', '/search', {}, ADMIN, { q: 'tee', limit: '5' }), () => {});
  assert.equal(r.status, 200);
  assert.deepEqual(q, { tenantId: 'demo-tenant', text: 'tee', limit: 5 });
});

test('unknown route → 404 with hint; unmounted module → 503; handler errors → 422', async () => {
  const gw = new GatewayService(pack);
  const nf = await gw.handle(ctx('GET', '/nope'), () => {});
  assert.equal(nf.status, 404);
  const unmounted = await gw.handle(ctx('POST', '/tax/compute', {}), () => {});
  assert.equal(unmounted.status, 503);
  gw.mount('mod-tax', { compute: () => { throw new Error('pack data says no tax rule'); } });
  const boom = await gw.handle(ctx('POST', '/tax/compute', {}), () => {});
  assert.equal(boom.status, 422);
  assert.ok(JSON.stringify(boom.body).includes('no tax rule'));
});

test('rate limit: requestsPerMinute from pack enforced (429 beyond limit)', async () => {
  const gw = new GatewayService(pack);
  gw.mount('mod-tax', { compute: () => ({}) });
  const tiny: GatewayPack = { ...pack, rateLimits: { requestsPerMinute: 3, burst: 3 } };
  const gwTiny = new GatewayService(tiny);
  gwTiny.mount('mod-tax', { compute: () => ({}) });
  let last = 0;
  for (let i = 0; i < 5; i++) {
    const r = await gwTiny.handle(ctx('POST', '/tax/compute', {}), () => {});
    last = r.status;
  }
  assert.equal(last, 429);
});

test('resolveExpr: paths, fallbacks, literals (pure)', () => {
  const c: GatewayRequestCtx = { method: 'POST', path: '/x', params: { id: 'abc' }, query: { q: 'tee' }, body: { n: 7, s: 'x', arr: [1, 2] }, headers: {} };
  assert.equal(resolveExpr('$.params.id', c), 'abc');
  assert.equal(resolveExpr('$.query.q', c), 'tee');
  assert.equal(resolveExpr('$.body.n', c), 7);
  assert.deepEqual(resolveExpr('$.body.missing||[]', c), []);
  assert.equal(resolveExpr('"demo-tenant"', c), 'demo-tenant');
  assert.equal(resolveExpr('demo-tenant', c), 'demo-tenant'); // bare literal
  assert.equal(resolveExpr('$.query.limit||10', c), 10);
  assert.equal(resolveExpr('$.query.fuzzy||true', c), true);
});

test('module contract: default export AetherModule, metered requests, mountable', async () => {
  const mod = (await import('../src/index.ts')).default;
  assert.equal(mod.manifest.id, 'mod-gateway');
  const events: string[] = [];
  const api = await mod.create(
    { tenantId: () => 't', storage: () => null, log: () => {} },
    { meter: (e: string) => events.push(e) },
    { 'gateway-core': pack }
  );
  (api['mount'] as (id: string, a: Record<string, unknown>) => void)('mod-tax', { compute: () => ({ totalTax: 0 }) });
  const r = await (api['handle'] as (c: GatewayRequestCtx) => Promise<{ status: number }>)(
    ctx('POST', '/tax/compute', { fact: { market: 'US' }, lines: [] })
  );
  assert.equal(r.status, 200);
  assert.ok(events.includes('gateway.request'));
});

test('public route: /health answers WITHOUT any api key (auth:false from pack)', async () => {
  const gw = new GatewayService(pack);
  gw.mount('gateway', { routes: () => gw.listRoutes() });
  const r = await gw.handle(ctx('GET', '/health', {}, {}), () => {});
  assert.equal(r.status, 200);
});

test('OpenAPI 3.1 generated from the pack: every route present, params converted, security schemes', () => {
  const gw = new GatewayService(pack);
  const spec = gw.openapi() as { openapi: string; paths: Record<string, Record<string, unknown>>; components: { securitySchemes: Record<string, unknown> } };
  assert.equal(spec.openapi, '3.1.0');
  const paths = Object.keys(spec.paths);
  assert.ok(paths.includes('/catalog/buybox/{id}')); // :id -> {id}
  assert.ok(paths.includes('/tax/compute'));
  assert.ok((spec.components.securitySchemes as Record<string, unknown>)['apiKey']);
  // route count parity: every pack route appears in the spec
  assert.equal(paths.length, pack.routes.length);
  // scoped routes carry 403 doc; public ones don't
  const buybox = spec.paths['/catalog/buybox/{id}']!.get as { responses: Record<string, unknown> };
  assert.ok(buybox.responses['403']);
  const health = spec.paths['/health']!.get as { responses: Record<string, unknown> };
  assert.ok(!health.responses['403']);
});

test('shopper session routes: Bearer auth via mounted identity; $.session.customerId reaches the mapper', async () => {
  const gw = new GatewayService(pack);
  gw.mountIdentity((t) => (t === 'tok_valid' ? { customerId: 'cust_9', email: 'e@t.co' } : null));
  const cart: unknown[][] = [];
  gw.mount('mod-cart', {
    add: (c: string, l: unknown) => (cart.push([c, l]), { customerId: c, lines: [l], total: 0, currency: 'USD' }),
    get: (c: string) => ({ customerId: c, lines: [], total: 0, currency: 'USD' }),
    update: () => null, remove: () => null, clear: () => null, take: () => [],
  });
  // no token → 401 login required
  const anon = await gw.handle(ctx('POST', '/cart/add', { line: { offerId: 'x', qty: 1 } }, {}), () => {});
  assert.equal(anon.status, 401);
  assert.ok(JSON.stringify(anon.body).includes('login required'));
  // bad token → 401
  const bad = await gw.handle(ctx('POST', '/cart/add', { line: { offerId: 'x', qty: 1 } }, { authorization: 'Bearer wrong' }), () => {});
  assert.equal(bad.status, 401);
  // valid token → session resolves, customerId maps through
  const ok = await gw.handle(ctx('POST', '/cart/add', { line: { offerId: 'off_x', price: 5, qty: 2 } }, { authorization: 'Bearer tok_valid' }), () => {});
  assert.equal(ok.status, 200);
  assert.equal(cart[0]![0], 'cust_9'); // session.customerId
});

test('auth routes are public (register/login need no api key)', async () => {
  const gw = new GatewayService(pack);
  gw.mount('mod-identity', {
    register: () => ({ customer: { customerId: 'c1' }, session: { token: 't' } }),
    login: () => ({ customer: { customerId: 'c1' }, session: { token: 't' } }),
    me: () => null, logout: () => true,
  });
  const reg = await gw.handle(ctx('POST', '/auth/register', { email: 'a@b.co', password: 'pass1234' }, {}), () => {});
  assert.equal(reg.status, 200);
  const login = await gw.handle(ctx('POST', '/auth/login', {}, {}), () => {});
  assert.equal(login.status, 200);
});
