// Tests: agentic commerce — signed delegations, scope enforcement, spend caps,
// category bans, human-confirmation, expiry/revocation, consent gate (P4-AI-002).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgenticCommerceService, AgenticCommerceError } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/agentic-core.json'), 'utf8'));
const svc = () => new AgenticCommerceService(pack);

const sign = (p: string) => `sig(${p})`; // dev signer; ed25519-class adapter in production
const verify = (p: string, s: string) => s === `sig(${p})`;
const now = () => Date.now();

function purchaseDelegation(s: AgenticCommerceService, scope = 'purchase', userId = 'user-1') {
  s.setConsent(userId, true);
  return s.issueDelegation(userId, 'agent-butler', scope, 24, sign);
}

test('consent gate: no delegation without user consent (constitutional policy)', () => {
  const s = svc();
  assert.throws(() => s.issueDelegation('user-x', 'agent', 'purchase', 1, sign), /consent/);
  s.setConsent('user-x', true);
  assert.ok(s.issueDelegation('user-x', 'agent', 'purchase', 1, sign));
});

test('delegation TTL clamped by pack; signature verifies; tampered signature rejected', () => {
  const s = svc();
  s.setConsent('user-1', true);
  assert.throws(() => s.issueDelegation('user-1', 'agent', 'purchase', 200, sign), /TTL 200h exceeds policy max 168h/);
  const d = s.issueDelegation('user-1', 'agent', 'purchase', 24, sign);
  assert.equal(s.verifyDelegation(d.delegationId, verify), true);
  assert.equal(s.verifyDelegation(d.delegationId, () => false), false); // bad signer
});

test('scope enforcement: browse-scope cannot purchase; cart-scope cannot purchase; purchase-scope can', () => {
  const s = svc();
  s.setConsent('user-1', true);
  const browse = s.issueDelegation('user-1', 'agent', 'browse', 1, sign);
  const r1 = s.evaluate({ delegationId: browse.delegationId, kind: 'search', now: now() });
  assert.equal(r1.status, 'allowed');
  const r2 = s.evaluate({ delegationId: browse.delegationId, kind: 'purchase', basket: [{ productId: 'p', category: 'apparel', unitPrice: 50, qty: 1 }], now: now() });
  assert.equal(r2.status, 'blocked-scope');
  const buy = purchaseDelegation(s);
  const r3 = s.evaluate({ delegationId: buy.delegationId, kind: 'purchase', basket: [{ productId: 'p', category: 'apparel', unitPrice: 50, qty: 1 }], now: now() });
  assert.equal(r3.status, 'allowed');
});

test('spend guardrails: per-action cap $500; per-day cap $2000 accumulates; item cap 20', () => {
  const s = svc();
  const d = purchaseDelegation(s);
  // per-action: $600 → blocked
  const over = s.evaluate({ delegationId: d.delegationId, kind: 'purchase', basket: [{ productId: 'p', category: 'apparel', unitPrice: 600, qty: 1 }], now: now() });
  assert.equal(over.status, 'blocked-spend-cap');
  assert.equal((over as { cap: string }).cap, 'per-action');
  // item cap: 21 items of $1
  const tooMany = s.evaluate({ delegationId: d.delegationId, kind: 'purchase', basket: [{ productId: 'p', category: 'apparel', unitPrice: 1, qty: 21 }], now: now() });
  assert.equal((tooMany as { cap: string }).cap, 'items-per-order');
  // per-day accumulation: 8 × $250 = $2000 committed (each under the $300 auto threshold)
  for (let i = 0; i < 8; i++) {
    const r = s.evaluate({ delegationId: d.delegationId, kind: 'purchase', basket: [{ productId: 'p', category: 'apparel', unitPrice: 250, qty: 1 }], now: now() + i });
    assert.equal(r.status, 'allowed');
  }
  // 9th purchase would push $2250 > $2000 daily cap
  const ninth = s.evaluate({ delegationId: d.delegationId, kind: 'purchase', basket: [{ productId: 'p', category: 'apparel', unitPrice: 250, qty: 1 }], now: now() + 8 });
  assert.equal(ninth.status, 'blocked-spend-cap');
  assert.equal((ninth as { cap: string }).cap, 'per-day');
  assert.equal((ninth as { attempted: number }).attempted, 2250);
  assert.equal((ninth as { capAmount: number }).capAmount, 2000);
});

test('category bans: pharma forbidden; replenish scope restricted to consumable/perishable', () => {
  const s = svc();
  const d = purchaseDelegation(s);
  const r = s.evaluate({ delegationId: d.delegationId, kind: 'purchase', basket: [{ productId: 'rx', category: 'pharma', unitPrice: 50, qty: 1 }], now: now() });
  assert.equal(r.status, 'blocked-category');
  const rep = purchaseDelegation(s, 'replenish', 'user-2');
  const okFood = s.evaluate({ delegationId: rep.delegationId, kind: 'purchase', basket: [{ productId: 'milk', category: 'perishable', unitPrice: 3, qty: 2 }], now: now() });
  assert.equal(okFood.status, 'allowed');
  const notFood = s.evaluate({ delegationId: rep.delegationId, kind: 'purchase', basket: [{ productId: 'tee', category: 'apparel', unitPrice: 20, qty: 1 }], now: now() });
  assert.equal(notFood.status, 'blocked-category');
});

test('human-confirmation threshold: $300+ purchases held for user approval', () => {
  const s = svc();
  const d = purchaseDelegation(s);
  const big = s.evaluate({ delegationId: d.delegationId, kind: 'purchase', basket: [{ productId: 'p', category: 'apparel', unitPrice: 350, qty: 1 }], now: now() });
  assert.equal(big.status, 'needs-human-confirmation');
  assert.equal((big as { basketTotal: number }).basketTotal, 350);
  const small = s.evaluate({ delegationId: d.delegationId, kind: 'purchase', basket: [{ productId: 'p', category: 'apparel', unitPrice: 299, qty: 1 }], now: now() });
  assert.equal(small.status, 'allowed'); // under threshold — auto
});

test('expiry + revocation block all agent actions', () => {
  const s = svc();
  const d = purchaseDelegation(s);
  s.revokeDelegation(d.delegationId);
  const r = s.evaluate({ delegationId: d.delegationId, kind: 'search', now: now() });
  assert.equal(r.status, 'blocked-expired-delegation'); // revoked treated as expired authority
  const s2 = svc();
  const d2 = purchaseDelegation(s2);
  const later = s2.evaluate({ delegationId: d2.delegationId, kind: 'search', now: now() + 25 * 3_600_000 }); // TTL was 24h
  assert.equal(later.status, 'blocked-expired-delegation');
});
