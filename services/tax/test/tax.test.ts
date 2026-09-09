// Tests: Tax Engine v2 — pack-driven rates, inclusive/exclusive, facilitator, reverse charge,
// bitemporal point-in-time rates, explainability (P1-TAX-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaxEngine } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../../../packs/tax-core/pack.json'), 'utf8'));
const engine = new TaxEngine(pack.taxRules);

test('US exclusive mode: default 7%, CA override 9.25% (priority resolution)', () => {
  const r = engine.compute({ market: 'US', region: 'TX' }, [{ lineId: 'l1', netAmount: 100 }]);
  assert.equal(r.lines[0]!.mode, 'exclusive');
  assert.equal(r.lines[0]!.taxAmount, 7);
  assert.equal(r.lines[0]!.gross, 107);

  const ca = engine.compute({ market: 'US', region: 'CA' }, [{ lineId: 'l1', netAmount: 100 }]);
  assert.equal(ca.lines[0]!.rate, 0.0925);
  assert.equal(ca.lines[0]!.taxAmount, 9.25);
  assert.equal(ca.lines[0]!.jurisdiction, 'US-CA');
});

test('EU inclusive mode: 20% VAT extracted from gross', () => {
  const r = engine.compute({ market: 'EU' }, [{ lineId: 'l1', netAmount: 120 }]);
  assert.equal(r.lines[0]!.mode, 'inclusive');
  assert.equal(r.lines[0]!.net, 100);
  assert.equal(r.lines[0]!.taxAmount, 20);
  assert.equal(r.lines[0]!.gross, 120);
});

test('marketplace-facilitator liability flagged for 3P offers in EU (config, not code)', () => {
  const r = engine.compute({ market: 'EU', offerKind: '3p-marketplace' }, [{ lineId: 'l1', netAmount: 120 }]);
  assert.equal(r.lines[0]!.facilitatorLiable, true);
  const firstParty = engine.compute({ market: 'EU', offerKind: '1p' }, [{ lineId: 'l1', netAmount: 120 }]);
  assert.equal(firstParty.lines[0]!.facilitatorLiable, false);
});

test('B2B reverse charge: valid VAT ID → 0 tax with reverseCharge flag', () => {
  const r = engine.compute({ market: 'EU', audience: 'b2b', vatIdValid: true }, [{ lineId: 'l1', netAmount: 100 }]);
  assert.equal(r.lines[0]!.taxAmount, 0);
  assert.equal(r.lines[0]!.reverseCharge, true);
  const noVat = engine.compute({ market: 'EU', audience: 'b2b', vatIdValid: false }, [{ lineId: 'l1', netAmount: 100 }]);
  assert.equal(noVat.lines[0]!.reverseCharge, false);
});

test('India GST 18% inclusive from pack', () => {
  const r = engine.compute({ market: 'IN' }, [{ lineId: 'l1', netAmount: 118 }]);
  assert.equal(r.lines[0]!.rate, 0.18);
  assert.equal(r.lines[0]!.net, 100);
  assert.equal(r.lines[0]!.jurisdiction, 'IN-GST');
});

test('bitemporal rate reconstruction: point-in-time rule evaluation', () => {
  // rules validFrom 2026-01-01 — before that, no rule matches → 0
  const before = engine.rateAt({ market: 'EU' }, '2025-06-01T00:00:00Z');
  assert.equal(before.rate, 0);
  const after = engine.rateAt({ market: 'EU' }, '2026-06-01T00:00:00Z');
  assert.equal(after.rate, 0.20);
});

test('explainability: every line carries rule-name explanation (§10 decision-explainability)', () => {
  const r = engine.compute({ market: 'US', region: 'CA' }, [{ lineId: 'l1', netAmount: 100 }]);
  assert.match(r.lines[0]!.explain[0]!, /us-sales-tax-ca/);
  assert.match(r.lines[0]!.explain[0]!, /US-CA/);
});

test('multi-line totals aggregate correctly (per-line rounding, then sum)', () => {
  const r = engine.compute({ market: 'US' }, [
    { lineId: 'a', netAmount: 100 },
    { lineId: 'b', netAmount: 50.5 },
  ]);
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0]!.taxAmount, 7);
  assert.equal(r.lines[1]!.taxAmount, 3.54); // 50.5 * 0.07 = 3.535 → 3.54
  assert.equal(r.totalTax, 10.54); // per-line rounding then sum: 7 + 3.54
  assert.equal(r.totalGross, 161.04); // 150.5 + 10.54
});

test('computeLine: single-line convenience API agrees with compute (P1-TAX-001)', () => {
  const line = { lineId: 'single-1', netAmount: 200 };
  const single = engine.computeLine({ market: 'US', region: 'TX' }, line);
  const batch = engine.compute({ market: 'US', region: 'TX' }, [line]);
  assert.equal(single.taxAmount, batch.lines[0]!.taxAmount);
  assert.equal(single.gross, batch.lines[0]!.gross);
  assert.equal(single.mode, 'exclusive');
  assert.ok(single.explain.length >= 1);
});
