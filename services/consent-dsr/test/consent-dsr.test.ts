// Tests: consent + DSR — purpose gating, per-regulation SLAs, legal-hold erasure
// exemptions, retention on export, consent revocation (P2-MKT-003).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConsentService } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/consent-dsr-core.json'), 'utf8'));
const svc = () => new ConsentService(pack);

test('consent gating: essential always allowed; personalization requires opt-in', () => {
  const s = svc();
  assert.equal(s.hasConsent('t', 'user-1', 'essential'), true); // no consent needed
  assert.equal(s.hasConsent('t', 'user-1', 'personalization'), false); // default deny
  s.setConsent('t', 'user-1', 'personalization', true, 'EU');
  assert.equal(s.hasConsent('t', 'user-1', 'personalization'), true);
  assert.throws(() => s.setConsent('t', 'user-1', 'essential', false, 'EU'), /essential — consent cannot be withheld/);
  assert.throws(() => s.hasConsent('t', 'user-1', 'dark-purpose'), /Unknown consent purpose/);
});

test('per-regulation DSR rights + SLA clocks from pack (LGPD 15d < GDPR 30d < CCPA 45d)', () => {
  const s = svc();
  const gdpr = s.openDsr('t', 'u', 'EU', 'erasure');
  const lgpd = s.openDsr('t', 'u', 'BR', 'erasure');
  const ccpa = s.openDsr('t', 'u', 'US', 'erasure');
  const days = (d: string) => (Date.parse(d) - Date.now()) / 86_400_000;
  assert.ok(Math.abs(days(gdpr.dueAt) - 30) < 1);
  assert.ok(Math.abs(days(lgpd.dueAt) - 15) < 1);
  assert.ok(Math.abs(days(ccpa.dueAt) - 45) < 1);
  // opt-out-sale exists only under CCPA
  assert.throws(() => s.openDsr('t', 'u', 'EU', 'opt-out-sale'), /not granted under GDPR/);
  const optOut = s.openDsr('t', 'u', 'US', 'opt-out-sale');
  assert.equal(optOut.right, 'opt-out-sale');
  assert.throws(() => s.openDsr('t', 'u', 'ZZ', 'access'), /No privacy regulation/);
});

test('erasure honors legal holds: order-records survive (tax law), marketing profiles erased', () => {
  const s = svc();
  s.storeData('t', 'u-1', 'order-records', { orders: ['o1', 'o2'] });
  s.storeData('t', 'u-1', 'marketing-profiles', { segments: ['shoe-lover'] });
  s.storeData('t', 'u-1', 'behavioral-analytics', { events: 42 });
  s.setConsent('t', 'u-1', 'marketing', true, 'EU');

  const dsr = s.openDsr('t', 'u-1', 'EU', 'erasure');
  const done = s.fulfil(dsr.dsrId);
  assert.equal(done.status, 'completed');
  assert.match(done.outcome!, /erased 2 data classes/); // marketing + analytics
  assert.match(done.outcome!, /retained 1 under legal hold/);
  assert.match(done.outcome!, /order-records/); // legal-obligation basis survives
  // consents revoked on erasure
  assert.equal(s.hasConsent('t', 'u-1', 'marketing'), false);
});

test('access/portability export respects retention windows (stale classes excluded)', () => {
  const s = svc();
  const fresh = new Date().toISOString();
  const stale = new Date(Date.now() - 500 * 86_400_000).toISOString(); // > 400d analytics retention
  s.storeData('t', 'u-2', 'order-records', { orders: ['o1'] }, fresh);
  s.storeData('t', 'u-2', 'behavioral-analytics', { events: 1 }, stale); // beyond retention → excluded
  const dsr = s.openDsr('t', 'u-2', 'EU', 'portability');
  const done = s.fulfil(dsr.dsrId);
  assert.ok(done.dataExport!['order-records']);
  assert.equal(done.dataExport!['behavioral-analytics'], undefined); // expired
});

test('object-profiling revokes profiling + related consents', () => {
  const s = svc();
  s.setConsent('t', 'u-3', 'profiling', true, 'EU');
  s.setConsent('t', 'u-3', 'analytics', true, 'EU');
  s.setConsent('t', 'u-3', 'marketing', true, 'EU');
  const dsr = s.openDsr('t', 'u-3', 'EU', 'object-profiling');
  const done = s.fulfil(dsr.dsrId);
  assert.match(done.outcome!, /revoked/);
  assert.equal(s.hasConsent('t', 'u-3', 'profiling'), false);
  assert.equal(s.hasConsent('t', 'u-3', 'analytics'), false);
  assert.equal(s.hasConsent('t', 'u-3', 'marketing'), false);
  assert.equal(s.hasConsent('t', 'u-3', 'essential'), true); // untouched
});

test('SLA breach detection: unfulfilled past-due requests flagged', () => {
  const s = svc();
  const d1 = s.openDsr('t', 'u', 'BR', 'access'); // 15d SLA
  // simulate time passing beyond SLA (mutate dueAt for test determinism)
  const internal = s.dsr(d1.dsrId);
  internal.dueAt = new Date(Date.now() - 86_400_000).toISOString(); // yesterday
  const fresh = s.openDsr('t', 'u', 'BR', 'access');
  const breaches = s.slaBreaches();
  assert.equal(breaches.some((b) => b.dsrId === d1.dsrId), true);
  assert.equal(breaches.some((b) => b.dsrId === fresh.dsrId), false);
  s.fulfil(d1.dsrId);
  assert.equal(s.slaBreaches().some((b) => b.dsrId === d1.dsrId), false); // completed clears
});

test('regulationFor: market → mapped regulation; unmapped market rejected (data gap, not fallback)', () => {
  const s = svc();
  const reg = s.regulationFor('BR');
  assert.ok(['LGPD', 'GDPR', 'CCPA/CPRA'].includes(reg.id));
  assert.throws(() => s.regulationFor('ZZ'), /add to consent-dsr pack/);
});
