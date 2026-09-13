// Tests: search — engine-agnostic SPI, facets, fuzzy, tenant isolation, conformance admission (P1-SRC-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemorySearchEngine, SearchService, admitSearchEngine } from '../src/index.ts';

test('conformance matrix admits the reference engine', async () => {
  const r = await admitSearchEngine(new MemorySearchEngine());
  assert.equal(r.admitted, true, r.failures.map((f) => `${f.id}: ${f.error}`).join('; '));
});

test('full-text search ranks and returns hits', async () => {
  const svc = new SearchService(new MemorySearchEngine());
  await svc.indexProduct('t1', { id: 'p1', title: 'Cotton Tee', attributes: { color: 'navy', category: 'apparel' } });
  await svc.indexProduct('t1', { id: 'p2', title: 'Wool Sweater', attributes: { color: 'red', category: 'apparel' } });
  const r = await svc.search({ tenantId: 't1', text: 'cotton' });
  assert.equal(r.total, 1);
  assert.equal(r.hits[0]!.id, 'p1');
});

test('faceted search aggregates attribute values', async () => {
  const svc = new SearchService(new MemorySearchEngine());
  await svc.indexProduct('t2', { id: 'a1', title: 'Item A', attributes: { color: 'red', size: 'M' } });
  await svc.indexProduct('t2', { id: 'a2', title: 'Item B', attributes: { color: 'red', size: 'L' } });
  await svc.indexProduct('t2', { id: 'a3', title: 'Item C', attributes: { color: 'blue', size: 'M' } });
  const r = await svc.search({ tenantId: 't2', facets: ['color', 'size'] });
  assert.deepEqual(r.facets['color'], { red: 2, blue: 1 });
  assert.deepEqual(r.facets['size'], { M: 2, L: 1 });
});

test('filters narrow results before faceting', async () => {
  const svc = new SearchService(new MemorySearchEngine());
  await svc.indexProduct('t3', { id: 'a1', title: 'Item A', attributes: { color: 'red', size: 'M' } });
  await svc.indexProduct('t3', { id: 'a2', title: 'Item B', attributes: { color: 'blue', size: 'M' } });
  const r = await svc.search({ tenantId: 't3', filters: { color: 'red' }, facets: ['size'] });
  assert.equal(r.total, 1);
  assert.deepEqual(r.facets['size'], { M: 1 });
});

test('fuzzy search tolerates 1-edit typos', async () => {
  const svc = new SearchService(new MemorySearchEngine());
  await svc.indexProduct('t4', { id: 'z1', title: 'Sweater Weather', attributes: {} });
  const r = await svc.search({ tenantId: 't4', text: 'sweter' });
  assert.equal(r.total, 1); // fuzzy 1-edit match
});

test('tenant isolation: no cross-tenant hits', async () => {
  const svc = new SearchService(new MemorySearchEngine());
  await svc.indexProduct('tenantA', { id: 'iso1', title: 'Exclusive Product', attributes: {} });
  const r = await svc.search({ tenantId: 'tenantB', text: 'exclusive' });
  assert.equal(r.total, 0);
});

test('deindex removes documents (stale-offer cleanup)', async () => {
  const engine = new MemorySearchEngine();
  const svc = new SearchService(engine);
  await svc.indexProduct('t5', { id: 'gone', title: 'Discontinued', attributes: {} });
  await engine.remove('gone', 't5');
  const r = await svc.search({ tenantId: 't5', text: 'discontinued' });
  assert.equal(r.total, 0);
});

// ---------- durable search (Storage SPI) ----------
test('StorageSearchEngine: writes mirror to durable store and REHYDRATE on a fresh instance (cross-pod)', async () => {
  const { StorageSearchEngine } = await import('../src/index.ts');
  const { SqlEngine } = await import('../../../kernel/storage-sql/src/index.ts');
  const path = `/tmp/aether-search-${Date.now()}.db`;
  const a = new StorageSearchEngine(new SqlEngine(path));
  await a.index({ id: 'tee-1', tenantId: 't9', typeId: 'et_product', title: 'Navy Cotton Tee', attributes: { color: 'navy' }, text: 'navy cotton tee', keywords: ['tee'] });
  await a.index({ id: 'hood-1', tenantId: 't9', typeId: 'et_product', title: 'Grey Fleece Hoodie', attributes: { color: 'grey' }, text: 'grey fleece hoodie', keywords: ['hoodie'] });
  // pod B: brand-new instance on the same database → hydrates full index
  const b = new StorageSearchEngine(new SqlEngine(path));
  const all = await b.query({ tenantId: 't9' });
  assert.equal(all.total, 2); // FULL index rehydrated on pod B (not just last-written)
  const r = await b.query({ tenantId: 't9', text: 'tee' });
  assert.equal(r.hits[0]!.id, 'tee-1');
  // remove() is durable too
  await b.remove('hood-1', 't9');
  const c = new StorageSearchEngine(new SqlEngine(path));
  assert.equal((await c.query({ tenantId: 't9' })).total, 1); // removal durable
});
