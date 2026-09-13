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

test('register: issues customer id + session token; password never stored plaintext', async () => {
  const s = svc();
  const { customer, session } = await s.register('Shopper@Test.com', 'shopper123', 'Alice');
  assert.match(customer.customerId, /^cust_\d{5}$/);
  assert.equal(customer.email, 'shopper@test.com'); // normalized
  assert.equal(customer.name, 'Alice');
  assert.ok(session.token.length >= 48);
  // raw internals hold hash only
  const raw = (s as unknown as { users: Map<string, { hash: string; salt: string }> }).users.get('shopper@test.com')!;
  assert.ok(!raw.hash.includes('shopper123'));
  assert.ok(raw.salt.length > 0);
});

test('register: pack password policy enforced (length/digit/letter), email validated, dup 409', async () => {
  const s = svc();
  await assert.rejects(async () => {await s.register('a@b.co', 'short1', 'A')}, /at least 8 chars/);
  await assert.rejects(async () => {await s.register('a@b.co', 'nodigitshere', 'A')}, /requires a digit/);
  await assert.rejects(async () => {await s.register('a@b.co', '12345678', 'A')}, /requires a letter/);
  await assert.rejects(async () => {await s.register('not-an-email', 'valid123', 'A')}, /invalid email/);
  await s.register('dup@test.com', 'valid123', 'B');
  await assert.rejects(async () => {await s.register('dup@test.com', 'valid123', 'B')}, /already registered/);
});

test('login: timing-safe scrypt compare; wrong password 401; case-insensitive email', async () => {
  const s = svc();
  await s.register('alice@test.com', 'correct123', 'Alice');
  const ok = await s.login('ALICE@Test.com', 'correct123');
  assert.equal(ok.customer.email, 'alice@test.com');
  await assert.rejects(async () => {await s.login('alice@test.com', 'wrong123x')}, /invalid email or password/);
  await assert.rejects(async () => {await s.login('ghost@test.com', 'whatever1')}, /invalid email or password/);
});

test('sessions: me() resolves token; logout invalidates; unknown/expired → null', async () => {
  const s = svc();
  const { session } = await s.register('ses@test.com', 'valid123', 'S');
  const me = await s.me(session.token)!;
  assert.equal(me.email, 'ses@test.com');
  assert.ok(await s.me('bogus-token') === null);
  assert.equal(await s.logout(session.token), true);
  assert.equal(await s.me(session.token), null);
  // expiry: forge a session past TTL via internals
  const raw = (s as unknown as { sessions: Map<string, Session2> }).sessions;
  const { session: s2 } = await s.register('exp@test.com', 'valid123', 'E');
  const rec = raw.get(s2.token)!;
  raw.set(s2.token, { ...rec, expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(await s.me(s2.token), null); // expired → rejected
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
  const r = await (api['register'] as (e: string, p: string, n: string) => Promise<{ session: { token: string } }>)('m@test.com', 'valid123', 'M');
  assert.ok(r.session.token);
  await (api['login'] as (e: string, p: string) => Promise<unknown>)('m@test.com', 'valid123');
  assert.ok(events.includes('identity.registered') && events.includes('identity.login'));
});

// ---------- distributed sessions (cross-pod state on Storage SPI) ----------
test('STORE-BACKED sessions: pod A registers, pod B (fresh engine instance on same DB) resolves', async () => {
  const { SqlEngine } = await import('../../../kernel/storage-sql/src/index.ts');
  const path = `/tmp/aether-ses-${Date.now()}.db`;
  const a = new IdentityService(pack);
  a.attachStore(new SqlEngine(path));
  const { session } = await a.register('pod@test.com', 'valid123', 'Pod');
  // pod B: NEW service instance, NEW engine instance, SAME durable database
  const b = new IdentityService(pack);
  b.attachStore(new SqlEngine(path));
  const me = await b.me(session.token);
  assert.equal(me!.email, 'pod@test.com');
  assert.equal(me!.customerId, session.customerId);
  // logout on B is seen by A (closeVersion)
  await b.logout(session.token);
  assert.equal(await a.me(session.token), null);
});

test('STORE-BACKED users: register on pod A, LOGIN on pod B, me() resolves customer on B', async () => {
  const { SqlEngine } = await import('../../../kernel/storage-sql/src/index.ts');
  const path = `/tmp/aether-usr-${Date.now()}.db`;
  const a = new IdentityService(pack);
  a.attachStore(new SqlEngine(path));
  await a.register('cross@test.com', 'valid123', 'Cross Pod');
  const b = new IdentityService(pack);
  b.attachStore(new SqlEngine(path));
  const { session } = await b.login('cross@test.com', 'valid123'); // B never saw the register
  const me = await b.me(session.token);
  assert.equal(me!.name, 'Cross Pod');
  assert.equal(me!.customerId, 'cust_00001');
  // duplicate email across pods still 409
  await assert.rejects(async () => {await b.register('cross@test.com', 'other123', 'Dup');}, /already registered/);
});
