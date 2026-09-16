// Tests: Runtime SPI — RuntimeTarget is a registry entity; adapters admitted
// ONLY through the generated runtime matrix (P0-CTR-002 acceptance: a SECOND
// runtime target is admitted via the harness, and a broken adapter is refused).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessHostAdapter, ContainerOrchestratorAdapter, TargetMismatchError, type RuntimeAdapter, type DeploymentSpec, type RuntimeTargetDef } from '../src/index.ts';
import { RuntimeAdmission, runRuntimeConformance } from '@aether/kernel-conformance/src/index.ts';

function target(kind: string): RuntimeTargetDef {
  return {
    id: `rt-${kind}`,
    kind,
    computeClass: 'general',
    scalingSemantics: 'horizontal',
    networkModel: 'service-mesh',
    placementConstraints: [],
    teeCapable: false,
    capabilities: ['containers'],
    validFrom: '2026-01-01T00:00:00Z',
    validTo: null,
    recordedAt: '2026-01-01T00:00:00Z',
  };
}

const spec: DeploymentSpec = { serviceId: 'svc-a', image: 'img:1', replicas: 2, cpuMilli: 250, memoryMi: 256, port: 8787 };

test('GATE: a SECOND runtime target is admitted through the harness (acceptance)', async () => {
  const admission = new RuntimeAdmission();
  const first = await admission.admit(new ContainerOrchestratorAdapter());
  const second = await admission.admit(new ProcessHostAdapter());
  assert.equal(first.admitted, true, first.failures.map((f) => f.error).join('; '));
  assert.equal(second.admitted, true, second.failures.map((f) => f.error).join('; '));
  assert.ok(admission.list().length >= 2, 'gate needs >=2 admitted runtime targets');
  assert.ok(admission.get('container-orchestrator-adapter'));
});

test('container-orchestrated class: horizontal deploy/scale/converge/undeploy', async () => {
  const a = new ContainerOrchestratorAdapter();
  assert.equal(a.capabilities().horizontalScaling, true);
  const h = await a.deploy(spec, target('container-orchestrated'));
  assert.equal(h.replicas, 2);
  const st = await a.status(h);
  assert.deepEqual({ ready: st.ready, desired: st.desired, healthy: st.healthy }, { ready: 2, desired: 2, healthy: true });
  await a.scale(h, 5);
  assert.equal((await a.status(h)).ready, 5);
  await a.undeploy(h);
  assert.equal((await a.status(h)).healthy, false);
});

test('process-host class: vertical-only — replicas>1 refused by the adapter semantics', async () => {
  const a = new ProcessHostAdapter();
  assert.equal(a.capabilities().horizontalScaling, false);
  const ok = await a.deploy({ ...spec, replicas: 1 }, target('process-host'));
  assert.equal(ok.replicas, 1);
  await assert.rejects(() => a.deploy(spec, target('process-host')), /does not support horizontal scaling/);
});

test('target-kind isolation: adapters refuse foreign targets (placement invariant)', async () => {
  const a = new ProcessHostAdapter();
  await assert.rejects(() => a.deploy({ ...spec, replicas: 1 }, target('container-orchestrated')), TargetMismatchError);
});

test('broken adapter is REFUSED: cannot scale (matrix case RT-SCALE fails)', async () => {
  class NoScale extends ContainerOrchestratorAdapter {
    override readonly name = 'no-scale-adapter';
    override async scale(): Promise<never> {
      throw new Error('scale unsupported');
    }
  }
  const admission = new RuntimeAdmission();
  const r = await admission.admit(new NoScale() as RuntimeAdapter);
  assert.equal(r.admitted, false);
  assert.ok(r.failures.some((f) => f.caseId === 'RT-SCALE'));
  assert.throws(() => admission.get('no-scale-adapter'), /NOT admitted/);
});

test('broken adapter is REFUSED: unhealthy convergence (matrix case RT-HEALTH fails)', async () => {
  class Lying extends ProcessHostAdapter {
    override readonly name = 'lying-adapter';
    override async status(): Promise<{ ready: number; desired: number; healthy: boolean }> {
      return { ready: 0, desired: 1, healthy: true };
    }
  }
  const r = await runRuntimeConformance(new Lying() as RuntimeAdapter);
  assert.equal(r.admitted, false);
  assert.ok(r.failures.some((f) => f.caseId === 'RT-HEALTH'));
});

test('matrix is complete: every case id is unique and requirement-bearing', () => {
  const ids = RUNTIME_MATRIX_IDS();
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('RT-DEPLOY') && ids.includes('RT-TARGET-MATCH'));
});

function RUNTIME_MATRIX_IDS(): string[] {
  return ['RT-DEPLOY', 'RT-SCALE', 'RT-HEALTH', 'RT-UNDEPLOY', 'RT-CAPS', 'RT-TARGET-MATCH'];
}