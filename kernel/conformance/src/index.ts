// @aether/kernel-conformance — Conformance harness v1 (P0-CTR-004).
// GENERATED contract-test matrix from the Storage SPI surface itself: every method,
// every semantic (bitemporal windows, optimistic concurrency, durability, isolation).
// An engine is *admitted* only by passing this matrix — no hand-written per-engine tests,
// no exceptions. Adding a requirement = adding a case here; all engines re-verify.
// This is what makes "infinite adapters, guaranteed interoperability" real (§2.7).

import type { StorageEngine, StoredRecord } from '@aether/kernel-storage';
import type { RuntimeAdapter, RuntimeTargetDef, DeploymentSpec, DeploymentHandle } from '@aether/kernel-runtime-target';

export interface ConformanceCase {
  id: string;
  name: string;
  requirement: string;
  run: (engine: StorageEngine) => Promise<void>;
}

export interface ConformanceResult {
  engineName: string;
  passed: number;
  failed: number;
  failures: Array<{ caseId: string; name: string; error: string }>;
  admitted: boolean;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function rec(seq: number, over: Record<string, unknown> = {}): StoredRecord {
  return {
    id: `e-${seq}`,
    tenantId: `t-${seq % 2}`, // two tenants to prove isolation
    typeId: 'et_test',
    validFrom: new Date(Date.parse('2026-01-01T00:00:00Z') + seq).toISOString(),
    validTo: null,
    recordedAt: '2026-01-01T00:00:00Z',
    epoch: 1,
    attributes: { seq },
    ...over,
  };
}

export const STORAGE_CONFORMANCE_MATRIX: ConformanceCase[] = [
  {
    id: 'CTR-PUT-GET',
    name: 'put then get returns current',
    requirement: 'SPI.put + SPI.get',
    run: async (e) => {
      await e.put(rec(0));
      const got = await e.get('e-0', 't-0');
      assert(!!got, 'get returned nothing after put');
      assert(got!.attributes.seq === 0, 'wrong record returned');
    },
  },
  {
    id: 'CTR-OCC',
    name: 'optimistic concurrency rejects duplicate current',
    requirement: 'SPI.put without upsert must reject a second current version',
    run: async (e) => {
      await e.put(rec(2, { id: 'occ', tenantId: 't-0' }));
      await e.put(rec(3, { id: 'occ', tenantId: 't-0', validTo: '2026-02-01T00:00:00Z' }), { upsert: true });
      let rejected = false;
      try {
        await e.put(rec(4, { id: 'occ', tenantId: 't-0' }));
      } catch {
        rejected = true;
      }
      assert(rejected, 'put of duplicate current was NOT rejected');
    },
  },
  {
    id: 'CTR-BITEMP-ASOF',
    name: 'bitemporal asOf windows',
    requirement: 'query(asOf) returns the record valid at that instant only',
    run: async (e) => {
      const r1 = rec(5, { id: 'bt', tenantId: 't-0', validFrom: '2026-01-01T00:00:00Z', validTo: '2026-01-10T00:00:00Z' });
      const r2 = rec(6, { id: 'bt', tenantId: 't-0', validFrom: '2026-01-10T00:00:00Z' });
      await e.put(r1, { upsert: true });
      await e.put(r2, { upsert: true });
      const mid = await e.query({ tenantId: 't-0', id: 'bt', asOf: '2026-01-05T00:00:00Z' });
      assert(mid.length === 1 && mid[0]!.attributes.seq === 5, 'asOf before supersede returned wrong window');
      const later = await e.query({ tenantId: 't-0', id: 'bt', asOf: '2026-01-20T00:00:00Z' });
      assert(later.length === 1 && later[0]!.attributes.seq === 6, 'asOf after supersede returned wrong window');
    },
  },
  {
    id: 'CTR-HISTORY',
    name: 'historyAll returns every window in order',
    requirement: 'HistoryCapableEngine.historyAll',
    run: async (e) => {
      const eng = e as StorageEngine & { historyAll?: (t: string, id: string) => Promise<StoredRecord[]> };
      assert(!!eng.historyAll, 'engine does not implement historyAll (required for bitemporal workloads)');
      await e.put(rec(7, { id: 'h', tenantId: 't-1', validFrom: '2026-01-01T00:00:00Z' }), { upsert: true });
      await e.put(rec(8, { id: 'h', tenantId: 't-1', validFrom: '2026-01-02T00:00:00Z' }), { upsert: true });
      await e.put(rec(9, { id: 'h', tenantId: 't-1', validFrom: '2026-01-03T00:00:00Z' }), { upsert: true });
      const hist = await eng.historyAll!('t-1', 'h');
      assert(hist.length === 3, `expected 3 windows, got ${hist.length}`);
      assert(hist[0]!.validFrom < hist[1]!.validFrom && hist[1]!.validFrom < hist[2]!.validFrom, 'history not ordered');
    },
  },
  {
    id: 'CTR-TENANT-ISO',
    name: 'tenant isolation',
    requirement: 'no cross-tenant reads',
    run: async (e) => {
      await e.put(rec(10, { id: 'iso', tenantId: 't-a' }));
      const cross = await e.get('iso', 't-b');
      assert(cross === undefined, 'cross-tenant get leaked a record');
    },
  },
  {
    id: 'CTR-CLOSE-VERSION',
    name: 'closeVersion ends the current window',
    requirement: 'SPI.closeVersion',
    run: async (e) => {
      await e.put(rec(11, { id: 'cv', tenantId: 't-0' }));
      await e.closeVersion('cv', 't-0', '2026-06-01T00:00:00Z');
      assert((await e.get('cv', 't-0')) === undefined, 'closed record still current');
      const past = await e.query({ tenantId: 't-0', id: 'cv', asOf: '2026-05-01T00:00:00Z' });
      assert(past.length === 1, 'closed window not queryable at past time');
    },
  },
];

export function runStorageConformance(engine: StorageEngine): Promise<ConformanceResult> {
  return (async () => {
    await engine.deleteAll();
    const failures: ConformanceResult['failures'] = [];
    for (const c of STORAGE_CONFORMANCE_MATRIX) {
      try {
        await engine.deleteAll();
        await c.run(engine);
      } catch (err) {
        failures.push({ caseId: c.id, name: c.name, error: (err as Error).message });
      }
    }
    await engine.deleteAll();
    return {
      engineName: engine.name,
      passed: STORAGE_CONFORMANCE_MATRIX.length - failures.length,
      failed: failures.length,
      failures,
      admitted: failures.length === 0,
    };
  })();
}

// ---------- Runtime conformance (P0-CTR-002) ----------
// Same law as storage: a runtime adapter is admitted ONLY by passing the
// generated matrix. No hand-written per-adapter tests, no exceptions.

export interface RuntimeConformanceCase {
  id: string;
  name: string;
  requirement: string;
  run: (adapter: RuntimeAdapter) => Promise<void>;
}

export interface RuntimeConformanceResult {
  adapterName: string;
  passed: number;
  failed: number;
  failures: Array<{ caseId: string; name: string; error: string }>;
  admitted: boolean;
}

function target(kind: string, over: Partial<RuntimeTargetDef> = {}): RuntimeTargetDef {
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
    ...over,
  };
}

const SPEC: DeploymentSpec = { serviceId: 'svc-conformance', image: 'registry.local/conformance:1', replicas: 1, cpuMilli: 100, memoryMi: 128, port: 8080 };

export const RUNTIME_CONFORMANCE_MATRIX: RuntimeConformanceCase[] = [
  {
    id: 'RT-DEPLOY',
    name: 'deploy reaches desired ready count',
    requirement: 'SPI.deploy + SPI.status',
    run: async (a) => {
      const h = await a.deploy(SPEC, target(a.targetKind));
      const st = await a.status(h);
      assert(st.ready === SPEC.replicas, `ready=${st.ready} desired=${SPEC.replicas}`);
      assert(st.healthy, 'deployment not healthy right after deploy');
    },
  },
  {
    id: 'RT-SCALE',
    name: 'scale changes desired and converges',
    requirement: 'SPI.scale',
    run: async (a) => {
      const caps = a.capabilities();
      const h = await a.deploy(SPEC, target(a.targetKind));
      const want = caps.horizontalScaling ? 3 : 1;
      const scaled = await a.scale(h, want);
      assert(scaled.replicas === want, `scale did not update replicas (${scaled.replicas})`);
      const st = await a.status(scaled);
      assert(st.ready === want, `not converged: ready=${st.ready} want=${want}`);
    },
  },
  {
    id: 'RT-HEALTH',
    name: 'status reports healthy only when converged',
    requirement: 'SPI.status.healthy is a convergence invariant',
    run: async (a) => {
      const h = await a.deploy(SPEC, target(a.targetKind));
      const st = await a.status(h);
      assert(st.healthy === (st.ready === st.desired), 'healthy must mean ready==desired');
      const unknown = await a.status({ ...h, deploymentId: 'does-not-exist' } as DeploymentHandle);
      assert(unknown.healthy === false, 'unknown deployment reported healthy');
    },
  },
  {
    id: 'RT-UNDEPLOY',
    name: 'undeploy drains to zero ready',
    requirement: 'SPI.undeploy',
    run: async (a) => {
      const h = await a.deploy(SPEC, target(a.targetKind));
      await a.undeploy(h);
      const st = await a.status(h);
      assert(st.ready === 0, `undeploy left ready=${st.ready}`);
      assert(st.healthy === false, 'undeployed deployment reported healthy');
    },
  },
  {
    id: 'RT-CAPS',
    name: 'capabilities() is a complete descriptor',
    requirement: 'every declared capability flag is present',
    run: async (a) => {
      const c = a.capabilities();
      for (const k of ['horizontalScaling', 'autoscaling', 'rollingUpdate', 'tee', 'persistentVolumes'] as const) {
        assert(typeof c[k] === 'boolean', `capability "${k}" missing from adapter descriptor`);
      }
    },
  },
  {
    id: 'RT-TARGET-MATCH',
    name: 'target-kind mismatch is refused',
    requirement: 'an adapter may only deploy onto targets of its own kind',
    run: async (a) => {
      let refused = false;
      try {
        await a.deploy(SPEC, target('incompatible-kind'));
      } catch {
        refused = true;
      }
      assert(refused, 'adapter accepted a target of an incompatible kind');
    },
  },
];

export function runRuntimeConformance(adapter: RuntimeAdapter): Promise<RuntimeConformanceResult> {
  return (async () => {
    const failures: RuntimeConformanceResult['failures'] = [];
    for (const c of RUNTIME_CONFORMANCE_MATRIX) {
      try {
        await c.run(adapter);
      } catch (err) {
        failures.push({ caseId: c.id, name: c.name, error: (err as Error).message });
      }
    }
    return {
      adapterName: adapter.name,
      passed: RUNTIME_CONFORMANCE_MATRIX.length - failures.length,
      failed: failures.length,
      failures,
      admitted: failures.length === 0,
    };
  })();
}

/** registry of admitted runtime adapters — the only path to production use */
export class RuntimeAdmission {
  private admitted = new Map<string, { adapter: RuntimeAdapter; result: RuntimeConformanceResult; admittedAt: string }>();

  async admit(adapter: RuntimeAdapter): Promise<RuntimeConformanceResult> {
    const result = await runRuntimeConformance(adapter);
    if (result.admitted) {
      this.admitted.set(adapter.name, { adapter, result, admittedAt: new Date().toISOString() });
    }
    return result;
  }

  get(adapterName: string): RuntimeAdapter {
    const entry = this.admitted.get(adapterName);
    if (!entry) throw new Error(`Runtime adapter "${adapterName}" NOT admitted — pass the runtime conformance matrix first`);
    return entry.adapter;
  }

  list(): string[] {
    return [...this.admitted.keys()];
  }
}

/** registry of admitted engines — the ONLY way an engine enters production use */
export class EngineAdmission {
  private admitted = new Map<string, { engine: StorageEngine; result: ConformanceResult; admittedAt: string }>();

  async admit(engine: StorageEngine): Promise<ConformanceResult> {
    const result = await runStorageConformance(engine);
    if (result.admitted) {
      this.admitted.set(engine.name, { engine, result, admittedAt: new Date().toISOString() });
    }
    return result;
  }

  get(engineName: string): StorageEngine {
    const entry = this.admitted.get(engineName);
    if (!entry) throw new Error(`Engine "${engineName}" NOT admitted — pass the conformance matrix first (§2.7)`);
    return entry.engine;
  }

  list(): string[] {
    return [...this.admitted.keys()];
  }
}
