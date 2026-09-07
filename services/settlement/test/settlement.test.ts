// Tests: settlement — region pinning (glob home resolution), cross-region writes
// REFUSED, per-region invariants, settlement window w/ FX spread, DR promotion
// thresholds (P3-SCL-002, §3.6 locked decision).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettlementService, RegionPinnedError } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/settlement-core.json'), 'utf8'));
const svc = () => new SettlementService(pack);

test('home-region resolution by pack globs: eu-* → eu-central, others → us-east default', () => {
  const s = svc();
  assert.equal(s.homeRegionFor('eu-acme').id, 'eu-central');
  assert.equal(s.homeRegionFor('eu-brand-store').id, 'eu-central');
  assert.equal(s.homeRegionFor('us-shop').id, 'us-east'); // '*' fallback
  assert.equal(s.homeRegionFor('random-tenant').id, 'us-east');
});

test('REGION PINNING: writes outside home region refused with RegionPinnedError', () => {
  const s = svc();
  // EU tenant posting to us-east → refused
  assert.throws(
    () => s.postInRegion('eu-acme', 'us-east', 'tx-1', [{ account: 'a', debit: 10 }, { account: 'b', credit: 10 }]),
    (err: unknown) => {
      assert.ok(err instanceof RegionPinnedError);
      assert.match(err.message, /pinned to region "eu-central"/);
      return true;
    }
  );
  // posting to the home region succeeds
  s.postInRegion('eu-acme', 'eu-central', 'tx-1', [{ account: 'a', debit: 10 }, { account: 'b', credit: 10 }]);
  assert.equal(s.regionLedgerInvariant('eu-central'), true);
});

test('per-region ledger invariants: each region sums to zero independently', () => {
  const s = svc();
  s.postInRegion('eu-acme', 'eu-central', 'eu-tx', [
    { account: 'asset:psp', debit: 100 },
    { account: 'liability:funds', credit: 100 },
  ]);
  s.postInRegion('us-shop', 'us-east', 'us-tx', [
    { account: 'asset:psp', debit: 50 },
    { account: 'liability:funds', credit: 50 },
  ]);
  assert.equal(s.regionLedgerInvariant('eu-central'), true);
  assert.equal(s.regionLedgerInvariant('us-east'), true);
  // unbalanced post rejected in-region (kernel invariant enforced per region)
  assert.throws(() =>
    s.postInRegion('eu-acme', 'eu-central', 'eu-bad', [{ account: 'x', debit: 5 }])
  , /Ledger invariant violated/);
});

test('cross-region settlement: positions queued, settled only at the pack window w/ FX spread', () => {
  const s = svc();
  s.queueCrossRegion('eu-central', 'us-east', 100, 'EUR');
  s.queueCrossRegion('us-east', 'eu-central', 200, 'USD');
  // window at wrong hour refused
  assert.throws(() => s.runSettlementWindow(14, {}), /Settlement window runs at 2:00 UTC/);
  // correct window (2:00 UTC) with FX: EUR→USD 1.1, spread 0.5%
  const r = s.runSettlementWindow(2, { EUR: 1.1, USD: 1 });
  assert.equal(r.settled, 2);
  // 100 EUR → 110 USD × (1−0.005) = 109.45; 200 USD → 200 × 0.995 = 199.00
  assert.equal(r.totalUsd, Math.round((109.45 + 199) * 100) / 100);
  assert.ok(s.positions().every((p) => p.settled));
  // second run settles nothing (idempotent)
  const r2 = s.runSettlementWindow(2, { EUR: 1.1, USD: 1 });
  assert.equal(r2.settled, 0);
});

test('DR promotion: below threshold refused, at/after threshold promotes', () => {
  const s = svc();
  s.reportPrimaryDown('us-east', 1_000_000);
  const early = s.tryPromote('us-east', 1_000_030); // 30s down < 60s threshold
  assert.equal(early.promoted, false);
  assert.match(early.reason, /30s < 60s/);
  const ready = s.tryPromote('us-east', 1_000_060); // exactly 60s
  assert.equal(ready.promoted, true);
  assert.equal(s.regionDrState('us-east').status, 'promoted');
  // healthy region never promotes
  const healthy = s.tryPromote('eu-central', 1_000_100);
  assert.equal(healthy.promoted, false);
  assert.match(healthy.reason, /primary healthy/);
});

test('DR targets from pack: RPO 300s / RT0 3600s are policy data', () => {
  assert.equal(pack.settlement.dr.rpoSeconds, 300);
  assert.equal(pack.settlement.dr.rtoSeconds, 3600);
  assert.equal(pack.settlement.dr.promoteAfterPrimaryDownSec, 60);
  assert.equal(pack.settlement.window.hourUtc, 2);
  assert.equal(pack.settlement.crossRegion.fxSpreadPct, 0.5);
});
