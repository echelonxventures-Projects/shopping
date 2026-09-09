// Tests: Ops Center — chaos drills from pack scenarios (invariants + rollback
// verification + abort-on-breach), runbooks generated from the LIVE product
// registry (total coverage by construction), FinOps per-tenant attribution +
// unit economics (P3-SCL-004, PX-OPS-001, PX-FIN-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpsCenterService, type OpsPack, type DrillHarness } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/ops-center-core.json'), 'utf8')) as OpsPack;
const svc = new OpsCenterService(pack);

/** simulated game-day harness: healthy system semantics */
function healthyHarness(): DrillHarness & { injected: string[]; rolledBack: string[] } {
  const h = {
    injected: [] as string[],
    rolledBack: [] as string[],
    inject(fault: { kind: string; target: string }) {
      h.injected.push(`${fault.kind}:${fault.target}`);
    },
    measure(check: string): unknown {
      const sim: Record<string, unknown> = {
        'no-acknowledged-write-lost': true,
        'failover-under-seconds': 12,
        'error-budget-burn-pct': 2,
        'oversell-count': 0,
        'waiting-room-engaged': true,
        'p95-under-ms': 180,
        'publish-rejected-at-gate': true,
        'running-config-unchanged': true,
      };
      return sim[check];
    },
    executeRollbackStep(step: string): boolean {
      h.rolledBack.push(step);
      return true;
    },
  };
  return h;
}

test('chaos drill passes: fault injected, all invariants verified, rollback executed + verified (P3-SCL-004)', () => {
  const h = healthyHarness();
  const r = svc.runDrill('drill_store_outage', h);
  assert.equal(r.passed, true);
  assert.equal(r.aborted, false);
  assert.deepEqual(h.injected, ['kill-dependency:storage-primary']);
  assert.equal(r.invariantResults.length, 3);
  assert.equal(r.rollbackVerified, true);
  assert.deepEqual(h.rolledBack, ['restore-primary', 'verify-replication-lag-zero', 'return-traffic']);
});

test('invariant breach aborts the drill (pack policy) but rollback STILL runs', () => {
  const h = healthyHarness();
  const bad: DrillHarness = {
    inject: h.inject,
    measure: (check) => (check === 'oversell-count' ? 3 : h.measure(check)), // oversold!
    executeRollbackStep: h.executeRollbackStep,
  };
  const r = svc.runDrill('drill_burst_overload', bad);
  assert.equal(r.passed, false);
  assert.equal(r.aborted, true);
  const oversell = r.invariantResults.find((i) => i.check === 'oversell-count')!;
  assert.equal(oversell.passed, false);
  assert.equal(oversell.observed, 3);
  assert.ok(h.rolledBack.length > 0, 'rollback must run even on abort');
});

test('unknown drill rejected — drills are pack data, not code paths', () => {
  assert.throws(() => svc.runDrill('drill_nonexistent', healthyHarness()), /pack data/);
});

test('control-plane drill: bad pack publish rejected at gate, running config unchanged', () => {
  const r = svc.runDrill('drill_bad_pack_publish', healthyHarness());
  assert.equal(r.passed, true);
});

test('runbook generated from live product listing — sections from template, content from registry (PX-OPS-001)', () => {
  const rb = svc.runbookFor('mod-tax');
  assert.equal(rb.productId, 'mod-tax');
  assert.ok(String(rb.sections['overview']).includes('Tax'));
  assert.ok((rb.sections['capabilities'] as string[]).includes('tax'));
  assert.ok((rb.sections['public-api'] as string[]).includes('compute'));
  assert.ok(Array.isArray(rb.sections['meterable-signals']));
  assert.equal((rb.sections['escalation'] as Record<string, string>)['l3'], 'platform-constitution-quorum');
});

test('runbook coverage is TOTAL by construction: one per registered product (35+)', () => {
  const all = svc.allRunbooks();
  assert.ok(all.length >= 35, `expected >=35 runbooks, got ${all.length}`);
  const ids = new Set(all.map((r) => r.productId));
  for (const must of ['mod-checkout', 'mod-pricing', 'mod-geo', 'mod-ops-center']) {
    assert.ok(ids.has(must), `missing runbook for ${must}`);
  }
  for (const rb of all) assert.ok(Object.keys(rb.sections).length === pack.runbookTemplate.sections.length);
});

test('FinOps attribution: metered usage x pack cost table -> per-tenant cost, unknown resource rejected (PX-FIN-001)', () => {
  const usage = [
    { tenantId: 't-acme', resource: 'request', qty: 1_000_000 },
    { tenantId: 't-acme', resource: 'storage-gb-day', qty: 200 },
    { tenantId: 't-zen', resource: 'request', qty: 50_000 },
  ];
  const out = svc.attribute(usage);
  assert.equal(out.get('t-acme')!.costMicros, 1_000_000 * 12 + 200 * 900);
  assert.equal(out.get('t-zen')!.costMicros, 50_000 * 12);
  assert.equal(out.get('t-acme')!.byResource['storage-gb-day'], 180_000);
  assert.throws(() => svc.attribute([{ tenantId: 't', resource: 'quantum-flux', qty: 1 }]), /finops pack/);
});

test('unit economics: margin vs pack target', () => {
  const usage = [{ tenantId: 't-acme', resource: 'request', qty: 1_000_000 }]; // cost 12,000,000 micros = $12
  const good = svc.tenantUnitEconomics('t-acme', usage, 40_000_000); // $40 revenue → 70% margin
  assert.equal(good.marginPct, 70);
  assert.equal(good.meetsTarget, true); // target 65
  const bad = svc.tenantUnitEconomics('t-acme', usage, 20_000_000); // $20 → 40%
  assert.equal(bad.meetsTarget, false);
});

test('module contract: default export AetherModule with metered drill execution', async () => {
  const mod = (await import('../src/index.ts')).default;
  assert.equal(mod.manifest.id, 'mod-ops-center');
  const events: string[] = [];
  const api = await mod.create(
    { tenantId: () => 't1', storage: () => null, log: () => {} },
    { meter: (e: string) => events.push(e) },
    { 'ops-center-core': pack }
  );
  const r = (api['runDrill'] as (id: string, h: DrillHarness) => { passed: boolean })('drill_store_outage', healthyHarness());
  assert.equal(r.passed, true);
  assert.deepEqual(events, ['ops.drill.executed']);
});

test('listDrills: the drill catalog is pack data (every drill declared is listed)', () => {
  const drills = svc.listDrills();
  assert.equal(drills.length, pack.drills.length);
  assert.ok(drills.every((d) => d.invariants.length >= 1 && d.rollback.length >= 1));
  const ids = drills.map((d) => d.id);
  for (const must of ['drill_store_outage', 'drill_burst_overload', 'drill_bad_pack_publish']) {
    assert.ok(ids.includes(must));
  }
});
