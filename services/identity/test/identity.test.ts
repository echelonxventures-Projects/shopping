// Tests: identity — register/login/sessions, scrypt hashing, pack password policy,
// timing-safe compare, session TTL, uniqueness, email normalization (shopper flow).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdentityService } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/identity-core.json'), 'utf8'));
const svc = () => new IdentityService(pack);

test('register: issues customer id + session token; password never stored plaintext', () => {
  const s = svc();
  const { customer, session } = s.register('Shopper@Test.com', 'shopper123', 'Alice');
  assert.match(customer.customerId, /^cust_\d{5}$/);
  assert.equal(customer.email, 'shopper@test.com'); // normalized
  assert.equal(customer.name, 'Alice');
  assert.ok(session.token.length >= 48);
  // raw internals hold hash only
  const raw = (s as unknown as { users: Map<string, { hash: string; salt: string }> }).users.get('shopper@test.com')!;
  assert.ok(!raw.hash.includes('shopper123'));
  assert.ok(raw.salt.length > 0);
});

test('register: pack password policy enforced (length/digit/letter), email validated, dup 409', () => {
  const s = svc();
  assert.throws(() => s.register('a@b.co', 'short1', 'A'), /at least 8 chars/);
  assert.throws(() => s.register('a@b.co', 'nodigitshere', 'A'), /requires a digit/);
  assert.throws(() => s.register('a@b.co', '12345678', 'A'), /requires a letter/);
  assert.throws(() => s.register('not-an-email', 'valid123', 'A'), /invalid email/);
  s.register('dup@test.com', 'valid123', 'B');
  assert.throws(() => s.register('dup@test.com', 'valid123', 'B'), /already registered/);
});

test('login: timing-safe scrypt compare; wrong password 401; case-insensitive email', () => {
  const s = svc();
  s.register('alice@test.com', 'correct123', 'Alice');
  const ok = s.login('ALICE@Test.com', 'correct123');
  assert.equal(ok.customer.email, 'alice@test.com');
  assert.throws(() => s.login('alice@test.com', 'wrong123x'), /invalid email or password/);
  assert.throws(() => s.login('ghost@test.com', 'whatever1'), /invalid email or password/);
});

test('sessions: me() resolves token; logout invalidates; unknown/expired → null', () => {
  const s = svc();
  const { session } = s.register('ses@test.com', 'valid123', 'S');
  const me = s.me(session.token)!;
  assert.equal(me.email, 'ses@test.com');
  assert.ok(s.me('bogus-token') === null);
  assert.equal(s.logout(session.token), true);
  assert.equal(s.me(session.token), null);
  // expiry: forge a session past TTL via internals
  const raw = (s as unknown as { sessions: Map<string, Session2> }).sessions;
  const { session: s2 } = s.register('exp@test.com', 'valid123', 'E');
  const rec = raw.get(s2.token)!;
  raw.set(s2.token, { ...rec, expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(s.me(s2.token), null); // expired → rejected
});

type Session2 = { token: string; customerId: string; email: string; expiresAt: string };

test('module contract: default export AetherModule, metered register/login', async () => {
  const mod = (await import('../src/index.ts')).default;
  assert.equal(mod.manifest.id, 'mod-identity');
  const events: string[] = [];
  const api = await mod.create(
    { tenantId: () => 't', storage: () => null, log: () => {} },
    { meter: (e: string) => events.push(e) },
    { 'identity-core': pack }
  );
  const r = (api['register'] as (e: string, p: string, n: string) => { session: { token: string } })('m@test.com', 'valid123', 'M');
  assert.ok(r.session.token);
  (api['login'] as (e: string, p: string) => unknown)('m@test.com', 'valid123');
  assert.ok(events.includes('identity.registered') && events.includes('identity.login'));
});
