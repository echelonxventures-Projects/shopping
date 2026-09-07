// Tests: crypto vault — field policies, tenant crypto-isolation, blind indexes,
// CBOM floors, crypto-agility swap, round-trips (P1-SEC-001 / §4.5 wiring).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CryptoVaultService } from '../src/index.ts';
import type { EncryptedField } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/crypto-vault-core.json'), 'utf8'));
const svc = () => new CryptoVaultService(pack);

test('field policy from pack: public passes through; pii encrypts', async () => {
  const s = svc();
  assert.equal(await s.protectField('t1', 'public', 'hello'), 'hello');
  const enc = (await s.protectField('t1', 'pii', 'user@example.com')) as EncryptedField;
  assert.notEqual(enc.c, undefined);
  assert.equal(enc.classification, 'pii');
  assert.equal(enc.scheme, 'sc-field-aes-gcm');
  // ciphertext never contains plaintext
  const decoded = Buffer.from(enc.c, 'base64').toString('binary');
  assert.ok(!decoded.includes('user@example.com'));
});

test('round-trip: encrypt → reveal returns the original plaintext', async () => {
  const s = svc();
  const enc = await s.protectField('t1', 'pii', 'user@example.com');
  const back = await s.revealField('t1', enc);
  assert.equal(back, 'user@example.com');
});

test('TENANT CRYPTO-ISOLATION: cross-tenant decrypt fails (GCM auth tag)', async () => {
  const s = svc();
  assert.equal(await s.isCrossTenantSafe(), true);
  // direct proof: encrypt under tenant-a, attempt reveal under tenant-b → throws
  const enc = (await s.protectField('tenant-a', 'sensitive-pii', 'the-secret')) as EncryptedField;
  await assert.rejects(() => s.revealField('tenant-b', enc));
});

test('searchable encryption: blind index deterministic per tenant, differs across tenants', async () => {
  const s = svc();
  const i1 = await s.blindIndex('t1', 'pii', 'User@Example.com');
  const i2 = await s.blindIndex('t1', 'pii', 'user@example.com'); // case-insensitive exact-lookup
  const i3 = await s.blindIndex('t2', 'pii', 'user@example.com');
  assert.equal(i1, i2); // deterministic lookup key
  assert.notEqual(i1, i3); // tenant-scoped: no cross-tenant correlation
  await assert.rejects(() => s.blindIndex('t1', 'public', 'x'), /not enabled/); // pack policy (async rejection)
});

test('CBOM: generated from scheme registry; PQ readiness computed; floor enforced', () => {
  const s = svc();
  const cbom = s.cbom();
  assert.equal(cbom.length, 3);
  assert.ok(cbom.some((c) => c.location === 'fields/pii' && c.algorithm.includes('aes-256-gcm')));
  const pq = s.pqReadiness();
  assert.equal(pq.total, 3);
  assert.equal(pq.ready, 1); // audit hash-chain is pq-hybrid per pack
});

test('crypto-agility: scheme reassignment via pack data (no code change)', async () => {
  const s = svc();
  // swap fields/pii to the PQ-hybrid scheme
  s.reassignScheme('fields/pii', 'sc-field-pq-hybrid');
  const cbom = s.cbom();
  const pii = cbom.find((c) => c.location === 'fields/pii')!;
  assert.ok(pii.algorithm.includes('mlkem'));
  assert.equal(pii.pqReady, true);
  assert.throws(() => s.reassignScheme('fields/pii', 'sc-unknown-scheme'), /register in pack/);
});

test('unknown classification rejected — registry is the door', () => {
  const s = svc();
  assert.throws(() => s.policyFor('card-data-prohibited'), /No field policy/);
  const weak = JSON.parse(readFileSync(join(here, '../packs/crypto-vault-core.json'), 'utf8'));
  weak.schemes['sc-weak'] = { algorithm: 'aes-64', keyBits: 64, pqHybrid: false };
  weak.cbomLocations.push({ location: 'fields/bad', scheme: 'sc-weak' });
  const weakSvc = new CryptoVaultService(weak);
  assert.throws(() => weakSvc.cbom(), /floor violated/);
});
