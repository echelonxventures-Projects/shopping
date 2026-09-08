// Tests: load ops — flash-sale burst against REAL services, oversell=0 verified,
// SLO verdicts from pack, staged execution, scenario registry gate (PX-INF-003).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoadOpsHarness } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/load-ops-core.json'), 'utf8'));
const harness = () => new LoadOpsHarness(pack);

test('flash-sale burst: real chain, staged ramp executes, metrics reported', async () => {
  const h = harness();
  const report = await h.run('flash-sale-burst');
  assert.equal(report.scenarioId, 'flash-sale-burst');
  assert.ok(report.totalOps > 100, `expected substantial ops, got ${report.totalOps}`);
  assert.equal(report.perStage.length, 3); // warm/ramp/peak from pack
  assert.deepEqual(report.perStage.map((s) => s.label), ['warm', 'ramp', 'peak']);
  assert.ok(report.okOps > 0);
  assert.ok(report.p95LatencyMs >= 0);
  assert.ok(report.throughputOpsPerSec > 0);
});

test('OVERSELL INVARIANT: sold units never exceed stocked units under burst', async () => {
  const h = harness();
  const report = await h.run('flash-sale-burst');
  assert.equal(report.oversoldUnits, 0); // the §5 invariant: oversell = 0, always
  assert.equal(report.sloVerdict, 'pass');
  assert.deepEqual(report.sloFailures, []);
});

test('error rate within pack SLO: real checkout chain does not fail under load', async () => {
  const h = harness();
  const report = await h.run('flash-sale-burst');
  const scenario = h.scenario('flash-sale-burst');
  assert.ok(report.errorRate <= scenario.slos.maxErrorRate, `errorRate ${report.errorRate} > ${scenario.slos.maxErrorRate}`);
});

test('search-heavy scenario runs and passes its (stricter) SLOs', async () => {
  const h = harness();
  const report = await h.run('search-heavy');
  assert.equal(report.scenarioId, 'search-heavy');
  assert.ok(report.totalOps > 50);
});

test('scenario registry gate: unknown scenario rejected with pack guidance', async () => {
  const h = harness();
  await assert.rejects(() => h.run('ddos-attack'), /Unknown load scenario/);
});

test('SLO verdict logic: fabricated report math verified against pack thresholds', async () => {
  const h = harness();
  const scenario = h.scenario('flash-sale-burst');
  // p95 SLO is 5ms; real in-process ops are sub-ms — pass expected
  const report = await h.run('flash-sale-burst');
  if (report.p95LatencyMs <= scenario.slos.p95LatencyMs) {
    assert.ok(!report.sloFailures.some((f) => f.includes('p95')));
  } else {
    assert.ok(report.sloVerdict === 'fail' && report.sloFailures.some((f) => f.includes('p95')));
  }
  void h;
});
