// Tests: B2B — quote lifecycle w/ volume discounts, PO approval routing
// (manager vs finance by pack thresholds), net-terms grades (P1-B2B).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { B2BService } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/b2b-core.json'), 'utf8'));
const svc = () => new B2BService(pack);

const ITEMS = [{ productId: 'p1', qty: 100, unitPrice: 50 }]; // 5000 gross

test('contract pricing tiers from pack: volume discounts apply at quote time', () => {
  const s = svc();
  assert.equal(s.contractDiscount(0), 0); // bronze
  assert.equal(s.contractDiscount(60_000), 5); // silver
  assert.equal(s.contractDiscount(300_000), 12); // gold
  assert.equal(s.contractDiscount(2_000_000), 20); // platinum
  const q = s.requestQuote('t1', 'org1', 'seller1', ITEMS, 300_000); // gold
  assert.equal(q.discountPct, 12);
  assert.equal(q.total, 4400); // 5000 × (1 − 0.12)
  assert.equal(q.status, 'requested');
});

test('quote lifecycle: requested → quoted → accepted → ordered; expiry path', () => {
  const s = svc();
  const q = s.requestQuote('t1', 'org1', 's', ITEMS);
  s.quoteTransition('t1', q.quoteId, 'quoted', 'seller-responded');
  s.quoteTransition('t1', q.quoteId, 'accepted', 'buyer-accepted');
  s.quoteTransition('t1', q.quoteId, 'ordered', 'po-issued');
  assert.equal(s.getQuote('t1', q.quoteId).status, 'ordered');

  const q2 = s.requestQuote('t1', 'org1', 's', ITEMS);
  s.quoteTransition('t1', q2.quoteId, 'quoted', 'seller-responded');
  s.quoteTransition('t1', q2.quoteId, 'expired', 'validity-elapsed');
  assert.throws(() => s.quoteTransition('t1', q2.quoteId, 'accepted', 'buyer-accepted'), /illegal/); // expired is terminal
});

test('net-terms grades from pack: credit score → terms', () => {
  const s = svc();
  assert.equal(s.netTermGrade(850), 'net-15');
  assert.equal(s.netTermGrade(750), 'net-30');
  assert.equal(s.netTermGrade(620), 'net-60');
  assert.equal(s.netTermGrade(400), 'prepaid'); // below all grades → default
});

test('PO approval: under manager limit → manager approves directly', () => {
  const s = svc();
  const po = s.submitPo('t1', 'org1', 5_000, 750); // < 10,000 manager limit
  assert.equal(po.status, 'manager-review'); // auto-routed
  s.poAdvance('t1', po.poId, 'approved', 'manager-approved', 'mgr@org1');
  const done = s.getPo('t1', po.poId);
  assert.equal(done.status, 'approved');
  assert.equal(done.netTermGrade, 'net-30');
  assert.equal(done.approvalTrail.length, 2); // auto-route + manager approval
});

test('PO approval: over manager limit MUST route through finance (pack guard)', () => {
  const s = svc();
  const po = s.submitPo('t1', 'org1', 25_000, 800); // > 10,000 → finance guard
  // direct manager → approved is BLOCKED by the guard (amount-over-manager-limit)
  assert.throws(() => s.poAdvance('t1', po.poId, 'approved', 'manager-approved'), /illegal PO transition/);
  // correct path: manager → finance → approved
  s.poAdvance('t1', po.poId, 'finance-review', 'manager-approved', 'mgr@org1');
  s.poAdvance('t1', po.poId, 'approved', 'finance-approved', 'fin@org1');
  assert.equal(s.getPo('t1', po.poId).status, 'approved');
});

test('PO over finance limit (pack 100k) rejected — requires procurement committee', () => {
  const s = svc();
  assert.throws(() => s.submitPo('t1', 'org1', 150_000, 800), /exceeds finance limit/);
});
