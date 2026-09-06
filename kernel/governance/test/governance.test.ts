// Tests: config store tiers, constitution floors + amendment protocol, crypto registry (v0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigStore, Constitution, CryptoRegistry } from '../src/index.ts';

test('config store: scope precedence + validation + bitemporal history', () => {
  const cs = new ConfigStore();
  cs.registerValidator('commission', (_k, v) => {
    if ((v as number) < 0) throw new Error('commission must be >= 0');
  });
  cs.publish({ key: 'commission.default', tier: 'T2', value: 0.15, scope: {}, publishedBy: 'admin-1' });
  cs.publish({ key: 'commission.default', tier: 'T2', value: 0.1, scope: { tenant: 'acme' }, publishedBy: 'admin-1' });
  assert.equal(cs.resolve('commission.default')!.value, 0.15);
  assert.equal(cs.resolve('commission.default', { tenant: 'acme' })!.value, 0.1);
  assert.equal(cs.resolve('commission.default', { tenant: 'other' })!.value, 0.15);
  assert.throws(() => cs.publish({ key: 'commission.x', tier: 'T2', value: -1, scope: {}, publishedBy: 'a' }), />= 0/);
  assert.equal(cs.history('commission.default').length, 2); // supersede keeps history
});

test('constitution: floors enforced, M-of-N amendment, auto-revert', () => {
  const c = new Constitution();
  c.ratify(
    [{ id: 'f1', name: 'tls-floor', check: (k, v) => (k.startsWith('tls') && (v as string) === '1.2' ? 'TLS 1.2 below floor' : true) }],
    { of: 3, need: 2 }
  );
  assert.equal(c.verify('tls.version', '1.3').ok, true);
  const bad = c.verify('tls.version', '1.2');
  assert.equal(bad.ok, false);

  const p = c.propose('raise key floor', { minKeyBits: 256 });
  c.approve(p.id, 'admin-A');
  assert.equal(p.status, 'proposed'); // verification pending — no single-person enactment
  c.enactAfterVerification(p.id);
  assert.equal(p.status, 'proposed'); // still needs quorum
  c.approve(p.id, 'admin-B');
  assert.equal(p.status, 'enacted');
  assert.equal(c.autoRevert(p.id).status, 'auto-reverted');
});

test('crypto registry: floors reject weak keys; CBOM + PQ readiness generated', () => {
  const cr = new CryptoRegistry();
  cr.register({ id: 'sc-tls-hybrid', purpose: 'in-transit', algorithm: 'X25519+ML-KEM', keyBits: 256, pqHybrid: true });
  cr.register({ id: 'sc-field', purpose: 'field', algorithm: 'AES-GCM', keyBits: 256 });
  assert.throws(() => cr.register({ id: 'sc-weak', purpose: 'field', algorithm: 'AES', keyBits: 64 }), /floor/);
  cr.assign('edge/external', 'sc-tls-hybrid');
  cr.assign('pii/vault', 'sc-field');
  const cbom = cr.cbom();
  assert.equal(cbom.length, 2);
  assert.equal(cr.pqReadiness().ready, 1);
  assert.equal(cr.schemeFor('pii/vault').algorithm, 'AES-GCM');
});
