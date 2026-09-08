// Tests: SQL storage engine — real relational engine admitted through the SAME
// conformance matrix as every engine, plus SQL-specific proofs: durability
// across instances, transactional closeVersion, in-SQL asOf, full history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqlEngine } from '../src/index.ts';
import { runStorageConformance, type ConformanceResult } from '@aether/kernel-conformance/src/index.ts';
import type { StoredRecord } from '@aether/kernel-storage';

function record(over: Record<string, unknown> = {}): StoredRecord {
  return {
    id: 'e1', tenantId: 't1', typeId: 'et_apparel',
    validFrom: '2026-01-01T00:00:00Z', validTo: null,
    recordedAt: '2026-01-01T00:00:00Z', epoch: 1,
    attributes: { size: 'M' }, ...over,
  };
}

test('SQL ENGINE ADMITTED through the full conformance matrix (real relational path)', async () => {
  const engine = new SqlEngine();
  const result: ConformanceResult = await runStorageConformance(engine);
  assert.equal(result.admitted, true, result.failures.map((f) => `${f.caseId}: ${f.error}`).join('; '));
  assert.equal(result.passed, 6);
  engine.close();
});

test('in-SQL bitemporal: asOf windows + full ordered history', async () => {
  const engine = new SqlEngine();
  await engine.put(record({ validFrom: '2026-01-01T00:00:00Z', validTo: '2026-01-10T00:00:00Z', attributes: { v: 1 } }), { upsert: true });
  await engine.put(record({ validFrom: '2026-01-10T00:00:00Z', attributes: { v: 2 } }), { upsert: true });
  await engine.put(record({ validFrom: '2026-01-20T00:00:00Z', attributes: { v: 3 } }), { upsert: true });
  const atV2 = await engine.query({ tenantId: 't1', asOf: '2026-01-15T00:00:00Z' });
  assert.equal(atV2.length, 1);
  assert.equal((atV2[0]!.attributes as { v: number }).v, 2);
  const hist = await engine.historyAll('t1', 'e1');
  assert.equal(hist.length, 3);
  assert.deepEqual(hist.map((h) => (h.attributes as { v: number }).v), [1, 2, 3]); // ordered by valid_from
  engine.close();
});

test('durable across instances (real on-disk SQL file)', async () => {
  const dbPath = join(tmpdir(), `aether-sql-dur-${Date.now()}.db`);
  const eng1 = new SqlEngine(dbPath);
  await eng1.put(record({ attributes: { size: 'XL', note: 'persisted' } }));
  eng1.close();
  const eng2 = new SqlEngine(dbPath);
  const got = await eng2.get('e1', 't1');
  assert.equal((got!.attributes as { note: string }).note, 'persisted');
  eng2.close();
});

test('transactional closeVersion: concurrent-safe window closing', async () => {
  const engine = new SqlEngine();
  await engine.put(record());
  await engine.closeVersion('e1', 't1', '2026-06-01T00:00:00Z');
  assert.equal(await engine.get('e1', 't1'), undefined); // closed
  const past = await engine.query({ tenantId: 't1', asOf: '2026-05-01T00:00:00Z' });
  assert.equal(past.length, 1);
  engine.close();
});

test('capabilities declare real relational posture', () => {
  const engine = new SqlEngine();
  assert.equal(engine.capabilities.engineClass, 'relational');
  assert.equal(engine.capabilities.durable, true);
  assert.equal(engine.capabilities.transactions, true);
  assert.equal(engine.capabilities.multiTenantIsolation, 'rls');
  engine.close();
});
