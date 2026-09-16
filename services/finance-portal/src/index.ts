// @aether/service-finance-portal — seller/tenant finance as a product
// (P1-FIN-001). Module-as-a-Product: every financial rule is pack data —
// account classification is a PREFIX MAP over the double-entry ledger
// (categories are config, not code), reconciliation tolerances are config,
// period buckets are config, rounding policy is config. The service accepts a
// normalized finance feed (ledger entries with timestamps) so it plugs into
// any ledger implementation via the host port — Total Agnosticism.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

// ---------- finance feed shapes ----------
export interface FinanceEntry {
  transactionId: string;
  account: string;
  debit: number;
  credit: number;
  at: string; // ISO-8601 — period filter dimension
  ref?: string; // PSP/settlement reference for reconciliation
  sellerId?: string; // for per-seller statements
  memo?: string;
}

export interface PspSettlementLine {
  ref: string;
  amount: number;
  currency: string;
  at: string;
}

export interface OrderLineSummary {
  sellerId: string;
  category: string;
  amount: number;
  qty: number;
}

export interface OrderSummary {
  orderId: string;
  tenantId: string;
  at: string;
  currency: string;
  lines: OrderLineSummary[];
  total: number;
  fees: number;
  taxAmount: number;
}

export type PeriodKind = 'day' | 'month' | 'quarter' | 'year';

export interface PlStatement {
  tenantId: string;
  from: string;
  to: string;
  currency: string;
  lines: Record<string, number>;
  totals: { revenue: number; cogs: number; grossProfit: number; fees: number; refunds: number; discounts: number; shipping: number; netProfit: number };
}

export interface ReconException {
  id: string;
  kind: 'unmatched-psp' | 'unmatched-ledger' | 'amount-mismatch' | 'date-outside-window';
  ref: string;
  pspAmount?: number;
  ledgerAmount?: number;
  deltaMinor?: number;
  reason: string;
  at: string;
  cleared: boolean;
}

export interface ReconResult {
  matched: number;
  exceptions: ReconException[];
  totals: { psp: number; ledger: number; delta: number };
}

export interface GmvBucket {
  period: string;
  orders: number;
  units: number;
  gmv: number;
  fees: number;
  tax: number;
  net: number;
}

export interface FinancePack {
  pack: { name: string; version: string };
  accountMap: Record<string, string[]>;
  tolerances: { amountMinor: number; dateWindowHours: number; autoClearWithinTolerance: boolean; exceptionQueueBucket: string };
  periods: Record<PeriodKind, { kind: PeriodKind; pattern: string }>;
  statement: { currency: string; minorUnit: number; rounding: string; signConvention: Record<string, string> };
}

const round = (n: number, unit: number): number => {
  const f = 10 ** unit;
  return Math.round(n * f) / f;
};

export class FinancePortalService {
  private pack: FinancePack;
  private queue: ReconException[] = [];

  constructor(pack: FinancePack) {
    this.pack = pack;
  }

  private classify(account: string): string {
    for (const [category, prefixes] of Object.entries(this.pack.accountMap)) {
      if (prefixes.some((p) => account.startsWith(p))) return category;
    }
    return 'unclassified';
  }

  private sumCategory(entries: FinanceEntry[], category: string): number {
    let debit = 0;
    let credit = 0;
    for (const e of entries) {
      if (this.classify(e.account) !== category) continue;
      debit += e.debit;
      credit += e.credit;
    }
    const conv = this.pack.statement.signConvention[category] ?? 'debit-natural';
    const natural = conv === 'credit-natural' ? credit - debit : debit - credit;
    return round(natural, this.pack.statement.minorUnit);
  }

  plStatement(tenantId: string, from: string, to: string, entries: FinanceEntry[]): PlStatement {
    const inWindow = entries.filter((e) => e.at >= from && e.at <= to);
    const cats = Object.keys(this.pack.accountMap);
    const totals: Record<string, number> = {};
    for (const c of cats) totals[c] = this.sumCategory(inWindow, c);
    // money must never vanish: entries outside the pack's prefix map are surfaced explicitly
    const mapped = new Set(cats);
    const orphans = inWindow.filter((e) => !mapped.has(this.classify(e.account)));
    totals['unclassified'] = round(
      orphans.reduce((s, e) => s + e.debit - e.credit, 0),
      this.pack.statement.minorUnit
    );
    const revenue = totals['revenue'] ?? 0;
    const cogs = totals['cogs'] ?? 0;
    const fees = totals['fees'] ?? 0;
    const refunds = totals['refunds'] ?? 0;
    const discounts = totals['discounts'] ?? 0;
    const shipping = totals['shipping'] ?? 0;
    const tax = totals['tax'] ?? 0;
    return {
      tenantId,
      from,
      to,
      currency: this.pack.statement.currency,
      lines: { ...totals, tax },
      totals: {
        revenue,
        cogs,
        grossProfit: round(revenue + shipping - cogs, this.pack.statement.minorUnit),
        fees,
        refunds,
        discounts,
        shipping,
        netProfit: round(revenue + shipping - cogs - fees - refunds - discounts, this.pack.statement.minorUnit),
      },
    };
  }

  reconcile(pspLines: PspSettlementLine[], entries: FinanceEntry[]): ReconResult {
    const tolAmount = this.pack.tolerances.amountMinor / 10 ** this.pack.statement.minorUnit;
    const tolMs = this.pack.tolerances.dateWindowHours * 3600_000;
    const byRef = new Map<string, FinanceEntry>();
    for (const e of entries) {
      if (e.ref) byRef.set(e.ref, e);
    }
    const pspRefs = new Set<string>();
    const exceptions: ReconException[] = [];
    let matched = 0;
    let pspTotal = 0;
    let ledgerTotal = 0;

    for (const line of pspLines) {
      pspRefs.add(line.ref);
      pspTotal += line.amount;
      const ledger = byRef.get(line.ref);
      if (!ledger) {
        exceptions.push({ id: `exc-${exceptions.length + 1}`, kind: 'unmatched-psp', ref: line.ref, pspAmount: line.amount, reason: `PSP settlement ref "${line.ref}" has no ledger entry`, at: new Date().toISOString(), cleared: false });
        continue;
      }
      const ledgerAmount = round(ledger.credit - ledger.debit, this.pack.statement.minorUnit);
      ledgerTotal += ledgerAmount;
      const delta = round(line.amount - ledgerAmount, this.pack.statement.minorUnit);
      if (Math.abs(delta) > tolAmount) {
        exceptions.push({ id: `exc-${exceptions.length + 1}`, kind: 'amount-mismatch', ref: line.ref, pspAmount: line.amount, ledgerAmount, deltaMinor: Math.round(delta * 10 ** this.pack.statement.minorUnit), reason: `amount delta ${delta} exceeds tolerance ${tolAmount}`, at: new Date().toISOString(), cleared: false });
        continue;
      }
      const dtMs = Math.abs(Date.parse(line.at) - Date.parse(ledger.at));
      if (dtMs > tolMs) {
        exceptions.push({ id: `exc-${exceptions.length + 1}`, kind: 'date-outside-window', ref: line.ref, pspAmount: line.amount, ledgerAmount, reason: `settlement date differs by ${Math.round(dtMs / 3600_000)}h (window ${this.pack.tolerances.dateWindowHours}h)`, at: new Date().toISOString(), cleared: false });
        continue;
      }
      matched++;
    }

    for (const e of entries) {
      if (!e.ref) continue;
      if (pspRefs.has(e.ref)) continue;
      if (this.classify(e.account) !== 'cash') continue;
      ledgerTotal += round(e.credit - e.debit, this.pack.statement.minorUnit);
      exceptions.push({ id: `exc-${exceptions.length + 1}`, kind: 'unmatched-ledger', ref: e.ref, ledgerAmount: round(e.credit - e.debit, this.pack.statement.minorUnit), reason: `ledger ref "${e.ref}" missing from PSP settlement file`, at: new Date().toISOString(), cleared: false });
    }

    this.queue.push(...exceptions);
    return {
      matched,
      exceptions,
      totals: { psp: round(pspTotal, this.pack.statement.minorUnit), ledger: round(ledgerTotal, this.pack.statement.minorUnit), delta: round(pspTotal - ledgerTotal, this.pack.statement.minorUnit) },
    };
  }

  exceptions(): ReconException[] {
    return [...this.queue];
  }

  clearException(id: string, note?: string): ReconException {
    const found = this.queue.find((e) => e.id === id);
    if (!found) throw new Error(`no recon exception "${id}" — nothing to clear`);
    found.cleared = true;
    if (note) found.reason = `${found.reason} | cleared: ${note}`;
    return found;
  }

  gmvReport(orders: OrderSummary[], bucket: PeriodKind, currency?: string): GmvBucket[] {
    const def = this.pack.periods[bucket];
    if (!def) throw new Error(`unknown period bucket "${bucket}" — register it in the pack`);
    const groups = new Map<string, GmvBucket>();
    for (const o of orders) {
      if (currency && o.currency !== currency) continue;
      const key = this.periodKey(o.at, bucket);
      const b = groups.get(key) ?? { period: key, orders: 0, units: 0, gmv: 0, fees: 0, tax: 0, net: 0 };
      b.orders += 1;
      for (const l of o.lines) b.units += l.qty;
      b.gmv = round(b.gmv + o.total, this.pack.statement.minorUnit);
      b.fees = round(b.fees + o.fees, this.pack.statement.minorUnit);
      b.tax = round(b.tax + o.taxAmount, this.pack.statement.minorUnit);
      b.net = round(b.net + (o.total - o.fees - o.taxAmount), this.pack.statement.minorUnit);
      groups.set(key, b);
    }
    return [...groups.values()].sort((a, b) => a.period.localeCompare(b.period));
  }

  private periodKey(at: string, kind: PeriodKind): string {
    const d = new Date(at);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    switch (kind) {
      case 'day':
        return `${y}-${m}-${String(d.getUTCDate()).padStart(2, '0')}`;
      case 'month':
        return `${y}-${m}`;
      case 'quarter':
        return `${y}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
      case 'year':
        return String(y);
    }
  }

  sellerStatement(sellerId: string, from: string, to: string, entries: FinanceEntry[]): { sellerId: string; from: string; to: string; currency: string; gross: number; fees: number; refunds: number; payable: number; lines: FinanceEntry[] } {
    const inWindow = entries.filter((e) => e.sellerId === sellerId && e.at >= from && e.at <= to);
    let gross = 0;
    let fees = 0;
    let refunds = 0;
    for (const e of inWindow) {
      const cat = this.classify(e.account);
      if (cat === 'revenue') gross += e.credit - e.debit;
      else if (cat === 'fees') fees += e.debit - e.credit;
      else if (cat === 'refunds') refunds += e.debit - e.credit;
    }
    return {
      sellerId,
      from,
      to,
      currency: this.pack.statement.currency,
      gross: round(gross, this.pack.statement.minorUnit),
      fees: round(fees, this.pack.statement.minorUnit),
      refunds: round(refunds, this.pack.statement.minorUnit),
      payable: round(gross - fees - refunds, this.pack.statement.minorUnit),
      lines: inWindow,
    };
  }
}

// ---------- Module-as-a-Product contract ----------
const financePortalModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as FinancePack;
    const svc = new FinancePortalService(pack);
    const meter = (ev: string) => billing.meter(ev, 1);
    return {
      plStatement: (t: string, f: string, to: string, e: FinanceEntry[]) => (meter('finance.pl.generated'), svc.plStatement(t, f, to, e)),
      reconcile: (p: PspSettlementLine[], e: FinanceEntry[]) => (meter('finance.reconciliation.run'), svc.reconcile(p, e)),
      gmvReport: (o: OrderSummary[], b: PeriodKind, c?: string) => (meter('finance.gmv.reported'), svc.gmvReport(o, b, c)),
      sellerStatement: (s: string, f: string, to: string, e: FinanceEntry[]) => svc.sellerStatement(s, f, to, e),
      exceptions: () => svc.exceptions(),
      clearException: (id: string, note?: string) => svc.clearException(id, note),
      __raw: svc,
    };
  },
};

export default financePortalModule;