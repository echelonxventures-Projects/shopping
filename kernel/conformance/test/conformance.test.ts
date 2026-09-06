// Tests: conformance harness admits engines by generated matrix (P0-CTR-004).
// Proves: memory + file engines both admitted; a broken engine is REJECTED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineAdmission, runStorageConformance } from '../src/index.ts';
import { MemoryEngine, FileEngine, type StorageEngine, type StoredRecord } from '@aether/kernel-storage/src/index.ts';

test('both Reference Pack engines pass the generated matrix and are admitted', async () => {
  const admission = new EngineAdmission();
  const mem = await admission.admit(new MemoryEngine());
  const file = await admission.admit(new FileEngine(join(tmpdir(), `aether-conf-${Date.now()}.jsonl`)));
  assert.equal(mem.admitted, true, mem.failures.map((f) => f.error).join('; '));
  assert.equal(file.admitted, true, file.failures.map((f) => f.error).join('; '));
  assert.deepEqual(admission.list().sort(), ['file-engine', 'memory-engine']);
  assert.ok(admission.get('file-engine'));
});

test('M1 gate condition: a SECOND storage engine is admitted (CTR-003 + CTR-004)', async () => {
  const admission = new EngineAdmission();
  await admission.admit(new MemoryEngine());
  await admission.admit(new FileEngine(join(tmpdir(), `aether-gate-${Date.now()}.jsonl`)));
  assert.ok(admission.list().length >= 2, 'gate needs >=2 admitted engines');
});

test('broken engine is rejected — historyAll missing', async () => {
  class NoHistoryEngine extends MemoryEngine {
    name = 'no-history-engine';
    // pretends history isn't supported: throws on historyAll
    async historyAll(): Promise<StoredRecord[]> {
      throw new Error('history unsupported');
    }
  }
  const admission = new EngineAdmission();
  const r = await admission.admit(new NoHistoryEngine() as never);
  assert.equal(r.admitted, false);
  assert.ok(r.failures.some((f) => f.caseId === 'CTR-HISTORY'));
  assert.throws(() => admission.get('no-history-engine'), /NOT admitted/);
});

test('unadmitted engine cannot be fetched (admission is the only door)', async () => {
  const admission = new EngineAdmission();
  assert.throws(() => admission.get('memory-engine'), /NOT admitted/);
});

test('tenant-isolation case catches a leaking engine', async () => {
  class LeakyEngine extends MemoryEngine {
    async get(id: string, _tenantId: string): Promise<StoredRecord | undefined> {
      for (const r of await this.query({})) if (r.id === id) return r; // leaks across tenants
      return undefined;
    }
  }
  const r = await runStorageConformance(new LeakyEngine());
  assert.equal(r.admitted, false);
  assert.ok(r.failures.some((f) => f.caseId === 'CTR-TENANT-ISO'));
});
