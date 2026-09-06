// Tests: support — triage rules from pack, SLA clocks, ticket workflow, explainability journal (P1-SUP-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SupportService } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/support-core.json'), 'utf8'));
const svc = () => new SupportService(pack);

test('triage: chargeback text → critical/payments-risk queue (rule pack)', () => {
  const s = svc();
  const t = s.open('t1', 'c1', 'Money taken twice', 'I see a chargeback dispute on my card for order 123');
  const r = s.triage('t1', t.ticketId);
  assert.equal(r.severity, 'critical');
  assert.equal(r.queue, 'payments-risk');
  assert.equal(r.ruleName, 'triage-chargeback');
  assert.ok(r.explain[0]!.includes('triage-chargeback'));
});

test('triage: WISMO → self-service queue with auto-resolve action', () => {
  const s = svc();
  const t = s.open('t1', 'c2', '??', 'Where is my order? Track please');
  const r = s.triage('t1', t.ticketId);
  assert.equal(r.queue, 'self-service');
  assert.equal(r.autoResolve, 'tracking-lookup');
});

test('triage: refund → high severity; default → normal/general', () => {
  const s = svc();
  const t1 = s.open('t1', 'c3', 'r', 'I want a refund for the damaged lamp');
  assert.equal(s.triage('t1', t1.ticketId).severity, 'high');
  const t2 = s.open('t1', 'c4', 'x', 'How do I change my newsletter settings?');
  const r2 = s.triage('t1', t2.ticketId);
  assert.equal(r2.severity, 'normal');
  assert.equal(r2.queue, 'general');
});

test('SLA clocks: critical first-response due in 15min, resolution 240min', () => {
  const s = svc();
  const t = s.open('t1', 'c5', 'cb', 'chargeback dispute');
  s.triage('t1', t.ticketId);
  const got = s.get('t1', t.ticketId);
  const firstDueMs = Date.parse(got.firstResponseDueAt!) - Date.now();
  const resDueMs = Date.parse(got.resolutionDueAt!) - Date.now();
  assert.ok(firstDueMs > 13 * 60_000 && firstDueMs <= 15 * 60_000);
  assert.ok(resDueMs > 235 * 60_000 && resDueMs <= 240 * 60_000);
});

test('ticket workflow: new→triaged→open→resolved→closed; illegal skip rejected', () => {
  const s = svc();
  const t = s.open('t1', 'c6', 'q', 'general question');
  s.triage('t1', t.ticketId); // new → triaged
  s.advance('t1', t.ticketId, 'open', 'agent-assigned');
  s.advance('t1', t.ticketId, 'resolved', 'resolution-applied');
  s.advance('t1', t.ticketId, 'closed', 'customer-confirmed');
  assert.equal(s.get('t1', t.ticketId).status, 'closed');
  assert.throws(() => s.advance('t1', t.ticketId, 'open', 'agent-assigned'));
});

test('resolution-rejected loop: resolved → open (customer rejected)', () => {
  const s = svc();
  const t = s.open('t1', 'c7', 'q', 'question');
  s.triage('t1', t.ticketId);
  s.advance('t1', t.ticketId, 'open', 'agent-assigned');
  s.advance('t1', t.ticketId, 'resolved', 'resolution-applied');
  s.advance('t1', t.ticketId, 'open', 'customer-rejected');
  s.advance('t1', t.ticketId, 'resolved', 'resolution-applied');
  s.advance('t1', t.ticketId, 'closed', 'customer-confirmed');
  assert.equal(s.get('t1', t.ticketId).events.length, 6);
});

test('decision-explainability: journal records + queries why-was-I-charged', () => {
  const s = svc();
  s.recordExplain({
    subject: 'order:ord_9:line:0',
    decisionType: 'tax',
    summary: 'EU VAT 20% inclusive applied (€3.33 of €20 gross)',
    ruleTrails: [{ source: 'rule:eu-vat-inclusive', detail: 'market=EU, offerKind=1p, rate=0.20' }],
    contextFrame: { tenant: 'acme', market: 'EU', world: 'earth', atTime: '2026-09-06T10:00:00Z' },
  });
  s.recordExplain({
    subject: 'order:ord_9:line:0',
    decisionType: 'commission',
    summary: 'Seller commission 10% ($2.00)',
    ruleTrails: [{ source: 'rule:commission-default', detail: 'seller=s-1, amount=20' }],
    contextFrame: { tenant: 'acme' },
  });
  const taxWhy = s.explainCharge('order:ord_9:line:0', 'tax');
  assert.equal(taxWhy.length, 1);
  assert.match(taxWhy[0]!.summary, /VAT 20%/);
  assert.equal((taxWhy[0]!.contextFrame as { market: string }).market, 'EU');
  assert.equal(s.explain('order:ord_9:line:0').length, 2);
});
