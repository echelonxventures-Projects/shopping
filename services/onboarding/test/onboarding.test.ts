// Tests: onboarding/migration — pack field maps, dry-run default, dedupe,
// error-budget abort, checkpoint resume, reconciliation (P1-ONB-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OnboardingService } from '../src/index.ts';
import type { ImportRecord } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/onboarding-core.json'), 'utf8'));
const svc = () => new OnboardingService(pack);

function rec(i: number): ImportRecord {
  return { externalId: `sp-${i}`, entityType: 'product', data: { title: `Widget ${i}`, hs_code: '0000.00', tags: ['new'] } };
}

test('field maps from pack: shopify-class maps external -> local fields', () => {
  const s = svc();
  const mapped = s.mapRecord('shopify-class', rec(1));
  assert.equal(mapped['title'], 'Widget 1');
  assert.equal(mapped['hsCode'], '0000.00');
  assert.deepEqual(mapped['keywords'], ['new']);
  assert.throws(() => s.mapRecord('unknown-platform', rec(1)), /register an adapter/);
});

test('woocommerce-class uses its own field map (name→title)', () => {
  const s = svc();
  const mapped = s.mapRecord('woocommerce-class', { externalId: 'w-1', entityType: 'product', data: { name: 'Woo Product', sku: 'WOO-1', weight: 2.5 } });
  assert.equal(mapped['title'], 'Woo Product');
  assert.equal(mapped['weightKg'], 2.5);
});

test('dry-run is the default (pack policy): nothing is persisted, report still complete', () => {
  const s = svc();
  const report = s.importBatch('shopify-class', 'product', [rec(1), rec(2)]);
  assert.equal(report.dryRun, true);
  assert.equal(report.imported, 2);
  const second = s.importBatch('shopify-class', 'product', [rec(1), rec(2)]);
  assert.equal(second.skippedDuplicates, 0); // dry-run didn't persist — no dupes seen
  assert.equal(second.imported, 2);
});

test('live import dedupes by external-id (skip-by-external-id policy)', () => {
  const s = svc();
  const first = s.importBatch('shopify-class', 'product', [rec(1), rec(2)], { dryRun: false });
  assert.equal(first.imported, 2);
  const rerun = s.importBatch('shopify-class', 'product', [rec(1), rec(2), rec(3)], { dryRun: false });
  assert.equal(rerun.imported, 1); // only rec(3) is new
  assert.equal(rerun.skippedDuplicates, 2);
  assert.equal(rerun.reconciliation!.matches, true); // 3 = 1 + 2 dupes
});

test('error budget: abort after 50 mapping errors (pack policy)', () => {
  const s = svc();
  const bad = Array.from({ length: 60 }, (_, i): ImportRecord => ({ externalId: `bad-${i}`, entityType: 'nonexistent-entity', data: {} }));
  const report = s.importBatch('shopify-class', 'nonexistent-entity', bad, { dryRun: false });
  assert.equal(report.aborted, true);
  assert.equal(report.errors.length, 50); // stopped AT the budget
  assert.equal(report.reconciliation!.matches, false);
});

test('checkpoint resume: importBatch resumes from last checkpoint id', () => {
  const s = svc();
  const batch1 = [rec(1), rec(2), rec(3)];
  const r1 = s.importBatch('shopify-class', 'product', batch1, { dryRun: false });
  assert.equal(r1.checkpoint!.lastExternalId, 'sp-3');
  // crash simulation: new service, resume from checkpoint with remaining records
  const batch2 = [rec(1), rec(2), rec(3), rec(4)];
  const r2 = s.importBatch('shopify-class', 'product', batch2, { dryRun: false, resumeFrom: r1.checkpoint!.lastExternalId });
  assert.equal(r2.checkpoint!.processed, 2); // fast-forward skipped sp-1/sp-2; processed sp-3 (resume point, deduped) + sp-4
  assert.equal(r2.imported + r2.skippedDuplicates, 2);
  assert.equal(r2.imported, 1); // sp-4 was the only genuinely new record
});

test('onboarding progress tracker', () => {
  const s = svc();
  const p = s.onboardingProgress('t1', [
    { id: 'create-account', done: true },
    { id: 'configure-market', done: true },
    { id: 'import-catalog', done: false },
    { id: 'setup-payments', done: false },
  ]);
  assert.equal(p.pctComplete, 50);
  assert.equal(p.nextStep, 'import-catalog');
});
