// Tests: finance portal — pack-driven P&L classification, reconciliation with
// tolerance + exception queue, GMV bucketing, seller statements (P1-FIN-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FinancePortalService, type FinancePack, type FinanceEntry, type OrderSummary } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/finance-portal-core.json'), 'utf8')) as FinancePack;
const svc = () => new FinancePortalService(pack);

const JAN = '2026-01-15T10:00:00Z';
const FEB = '2026-02-15T10:00:00Z';

test('P&L: account classification is a PREFIX MAP from pack — no chart-of-accounts code', () => {
  const s = svc();
  const entries: FinanceEntry[] = [
    { transactionId: 't1', account: 'revenue:orders', debit: 0, credit: 1000, at: JAN },
    { transactionId: 't1', account: 'cogs:products', debit: 400, credit: 0, at: JAN },
    { transactionId: 't1', account: 'fees:payment-fees', debit: 30, credit: 0, at: JAN },
    { transactionId: 't1', account: 'commission:platform', debit: 20, credit: 0, at: JAN },
    { transactionId: 't1', account: 'shipping:standard', debit: 0, credit: 15, at: JAN },
    { transactionId: 't2', account: 'refund:orders', debit: 50, credit: 0, at: JAN },
    { transactionId: 't2', account: 'discount:promo', debit: 25, credit: 0, at: JAN },
    { transactionId: 't2', account: 'tax:us-ca', debit: 0, credit: 92.5, at: JAN },
    { transactionId: 't2', account: 'unknown:account', debit: 5, credit: 0, at: JAN },
  ];
  const pl = s.plStatement('t-1', '2026-01-01', '2026-01-31', entries);
  assert.equal(pl.lines['revenue'], 1000);
  assert.equal(pl.lines['cogs'], 400);
  assert.equal(pl.lines['fees'], 50); // payment-fees + commission: two prefixes, one category
  assert.equal(pl.lines['shipping'], 15);
  assert.equal(pl.lines['refunds'], 50);
  assert.equal(pl.lines['discounts'], 25);
  assert.equal(pl.lines['unclassified'], 5); // never silently dropped
  assert.equal(pl.totals.grossProfit, 615); // 1000 + 15 - 400
  assert.equal(pl.totals.netProfit, 490); // 615 - 50 fees - 50 refunds - 25 discounts
});

test('P&L: period window excludes out-of-range entries (timestamps are the dimension)', () => {
  const s = svc();
  const entries: FinanceEntry[] = [
    { transactionId: 't1', account: 'revenue:orders', debit: 0, credit: 1000, at: JAN },
    { transactionId: 't2', account: 'revenue:orders', debit: 0, credit: 9999, at: FEB },
  ];
  const jan = s.plStatement('t-1', '2026-01-01', '2026-01-31', entries);
  assert.equal(jan.totals.revenue, 1000);
});

test('reconciliation: matched within tolerance; amount-mismatch and unmatched-psp become queue exceptions', () => {
  const s = svc();
  const entries: FinanceEntry[] = [
    { transactionId: 'tx1', account: 'cash:psp', debit: 0, credit: 500, at: JAN, ref: 'ch_ok' },
    { transactionId: 'tx2', account: 'cash:psp', debit: 0, credit: 200, at: JAN, ref: 'ch_off' },
    { transactionId: 'tx3', account: 'cash:psp', debit: 0, credit: 100, at: JAN, ref: 'ch_orphan' },
  ];
  const r = s.reconcile(
    [
      { ref: 'ch_ok', amount: 500, currency: 'USD', at: JAN },
      { ref: 'ch_off', amount: 200.5, currency: 'USD', at: JAN }, // 0.50 delta, tolerance 1.00 → within
      { ref: 'ch_ghost', amount: 99, currency: 'USD', at: JAN },
    ],
    entries
  );
  assert.equal(r.matched, 2); // ch_ok + ch_off within tolerance
  assert.ok(r.exceptions.some((e) => e.kind === 'unmatched-psp' && e.ref === 'ch_ghost'));
  assert.ok(r.exceptions.some((e) => e.kind === 'unmatched-ledger' && e.ref === 'ch_orphan'));
});

test('reconciliation: amount beyond tolerance + date outside window flagged; exception queue clears', () => {
  const s = svc();
  const entries: FinanceEntry[] = [
    { transactionId: 'tx1', account: 'cash:psp', debit: 0, credit: 100, at: JAN, ref: 'ch_bad' },
    { transactionId: 'tx2', account: 'cash:psp', debit: 0, credit: 50, at: JAN, ref: 'ch_late' },
  ];
  const r = s.reconcile(
    [
      { ref: 'ch_bad', amount: 105, currency: 'USD', at: JAN }, // 5.00 delta > 1.00 tolerance
      { ref: 'ch_late', amount: 50, currency: 'USD', at: '2026-01-22T10:00:00Z' }, // >72h from ledger
    ],
    entries
  );
  assert.equal(r.matched, 0);
  assert.ok(r.exceptions.some((e) => e.kind === 'amount-mismatch'));
  assert.ok(r.exceptions.some((e) => e.kind === 'date-outside-window'));
  assert.equal(s.exceptions().length, r.exceptions.length);
  const first = s.exceptions()[0]!;
  const cleared = s.clearException(first.id, 'confirmed by PSP support ticket 991');
  assert.equal(cleared.cleared, true);
  assert.match(cleared.reason, /cleared: confirmed/);
});

test('GMV report: bucketed by pack period; fees/tax/net per bucket', () => {
  const s = svc();
  const orders: OrderSummary[] = [
    { orderId: 'o1', tenantId: 't-1', at: '2026-01-05T00:00:00Z', currency: 'USD', total: 100, fees: 10, taxAmount: 7, lines: [{ sellerId: 's1', category: 'apparel', amount: 100, qty: 2 }] },
    { orderId: 'o2', tenantId: 't-1', at: '2026-01-25T00:00:00Z', currency: 'USD', total: 200, fees: 20, taxAmount: 14, lines: [{ sellerId: 's1', category: 'apparel', amount: 200, qty: 3 }] },
    { orderId: 'o3', tenantId: 't-1', at: '2026-02-05T00:00:00Z', currency: 'USD', total: 50, fees: 5, taxAmount: 3.5, lines: [{ sellerId: 's2', category: 'home', amount: 50, qty: 1 }] },
    { orderId: 'o4', tenantId: 't-1', at: '2026-02-06T00:00:00Z', currency: 'EUR', total: 999, fees: 0, taxAmount: 0, lines: [] }, // filtered by currency
  ];
  const monthly = s.gmvReport(orders, 'month', 'USD');
  assert.equal(monthly.length, 2);
  assert.deepEqual(monthly[0], { period: '2026-01', orders: 2, units: 5, gmv: 300, fees: 30, tax: 21, net: 249 });
  assert.equal(monthly[1]!.gmv, 50);
  const daily = s.gmvReport(orders, 'day', 'USD');
  assert.equal(daily.length, 3);
  const q = s.gmvReport(orders, 'quarter', 'USD');
  assert.equal(q[0]!.period, '2026-Q1');
  assert.throws(() => s.gmvReport(orders, 'fortnight' as never), /register it in the pack/);
});

test('seller statement: gross/fees/refunds/payable from seller-tagged ledger lines', () => {
  const s = svc();
  const entries: FinanceEntry[] = [
    { transactionId: 't1', account: 'revenue:sales', debit: 0, credit: 300, at: JAN, sellerId: 's1' },
    { transactionId: 't1', account: 'fees:commission', debit: 30, credit: 0, at: JAN, sellerId: 's1' },
    { transactionId: 't2', account: 'refund:orders', debit: 25, credit: 0, at: JAN, sellerId: 's1' },
    { transactionId: 't3', account: 'revenue:sales', debit: 0, credit: 500, at: JAN, sellerId: 's2' },
  ];
  const st = s.sellerStatement('s1', '2026-01-01', '2026-01-31', entries);
  assert.equal(st.gross, 300);
  assert.equal(st.fees, 30);
  assert.equal(st.refunds, 25);
  assert.equal(st.payable, 245);
});

test('module contract: default export AetherModule, metered P&L + reconciliation + GMV', async () => {
  const mod = (await import('../src/index.ts')).default;
  assert.equal(mod.manifest.id, 'mod-finance-portal');
  const events: string[] = [];
  const api = await mod.create(
    { tenantId: () => 't', storage: () => null, log: () => {} },
    { meter: (e: string) => events.push(e) },
    { 'finance-portal-core': pack }
  );
  const pl = (api['plStatement'] as (t: string, f: string, to: string, e: FinanceEntry[]) => { totals: { revenue: number } })('t-1', '2026-01-01', '2026-01-31', [
    { transactionId: 't1', account: 'revenue:orders', debit: 0, credit: 100, at: JAN },
  ]);
  assert.equal(pl.totals.revenue, 100);
  (api['reconcile'] as (p: unknown[], e: unknown[]) => unknown)([], []);
  (api['gmvReport'] as (o: unknown[], b: string) => unknown)([], 'month');
  assert.deepEqual(events, ['finance.pl.generated', 'finance.reconciliation.run', 'finance.gmv.reported']);
});