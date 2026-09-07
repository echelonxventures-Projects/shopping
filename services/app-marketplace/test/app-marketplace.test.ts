// Tests: app marketplace — signed submissions, review pipeline, revenue split,
// sandbox quotas + TTL (P2-ECO-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppMarketplaceService } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/app-marketplace-core.json'), 'utf8'));
const svc = () => new AppMarketplaceService(pack);

function cleanApp() {
  const s = svc();
  const app = s.submit({ devId: 'dev-1', name: 'SEO Booster Pro', version: '1.0.0', category: 'marketing', price: { amount: 49, currency: 'USD' }, signed: true });
  return { s, app };
}

test('unsigned submissions rejected (signing policy is pack data)', () => {
  const s = svc();
  assert.throws(
    () => s.submit({ devId: 'dev-1', name: 'Evil App', version: '1', category: 'x', price: { amount: 10, currency: 'USD' }, signed: false }),
    /must be signed/
  );
});

test('review pipeline: clean scan → auto-approved → published; flagged → human review', () => {
  const { s, app } = cleanApp();
  s.runAutoScan(app.appId, []); // clean
  assert.equal(s.get(app.appId).status, 'approved');
  s.advance(app.appId, 'published', 'dev-published');
  assert.equal(s.published().length, 1);

  const s2 = svc();
  const flagged = s2.submit({ devId: 'dev-2', name: 'Sketchy', version: '1', category: 'x', price: { amount: 5, currency: 'USD' }, signed: true });
  s2.runAutoScan(flagged.appId, ['permission-audit: excessive scope']);
  assert.equal(s2.get(flagged.appId).status, 'human-review'); // pack trigger scan-flagged
  s2.advance(flagged.appId, 'rejected', 'reviewer-rejected');
  assert.throws(() => s2.install('tenant-1', flagged.appId), /not published/);
});

test('revenue split by tier from pack: standard 20% platform / strategic 10%', () => {
  const { s, app } = cleanApp();
  s.runAutoScan(app.appId, []);
  s.advance(app.appId, 'published', 'dev-published');
  const r1 = s.install('tenant-1', app.appId); // $49, standard tier
  assert.equal(r1.platformRevenue, 9.8); // 20%
  assert.equal(r1.devRevenue, 39.2);

  const s2 = svc();
  const strategic = s2.submit({ devId: 'd', name: 'ERP Connector', version: '1', category: 'b2b', price: { amount: 100, currency: 'USD' }, tier: 'strategic', signed: true });
  s2.runAutoScan(strategic.appId, []);
  s2.advance(strategic.appId, 'published', 'dev-published');
  const r2 = s2.install('tenant-2', strategic.appId);
  assert.equal(r2.platformRevenue, 10); // 10%
  assert.equal(r2.devRevenue, 90);
  assert.equal(s2.get(strategic.appId).installs, 1);
});

test('sandbox policy from pack: synthetic-only data policy, calls allowed within quota', () => {
  const s = svc();
  const sb = s.provisionSandbox('dev-3');
  assert.equal(sb.dataPolicy, 'synthetic-only'); // pack data policy
  const r = s.sandboxCall(sb.sandboxId);
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, 9999);
});

test('sandbox quota exhaustion at pack limit (10000/day)', () => {
  const s = svc();
  const sb = s.provisionSandbox('dev-4');
  let last;
  for (let i = 0; i < 10_000; i++) last = s.sandboxCall(sb.sandboxId);
  assert.equal(last!.allowed, true);
  assert.equal(last!.remaining, 0);
  const over = s.sandboxCall(sb.sandboxId);
  assert.equal(over.allowed, false);
});

test('sandbox expiry: TTL lapsed sandboxes refuse all calls', () => {
  const s = svc();
  const sb = s.provisionSandbox('dev-5');
  // simulate TTL lapse deterministically
  const internal = sb as unknown as { expiresAt: string };
  internal.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.throws(() => s.sandboxCall(sb.sandboxId), /expired/);
});

test('policy-violation suspension: published → suspended (pack workflow)', () => {
  const { s, app } = cleanApp();
  s.runAutoScan(app.appId, []);
  s.advance(app.appId, 'published', 'dev-published');
  s.advance(app.appId, 'suspended', 'policy-violation');
  assert.throws(() => s.install('tenant-9', app.appId), /not published/);
  assert.equal(s.published().length, 0);
});
