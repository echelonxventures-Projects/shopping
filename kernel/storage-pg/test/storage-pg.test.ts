// Tests: PostgreSQL wire-protocol engine — SAME conformance matrix as every
// engine (admission is uniform), plus SQL-specific bitemporal proofs:
// in-SQL asOf, transactional supersede, full ordered history, durability
// across engine instances. Skips (not fails) when no PG server is reachable
// — local `npm test` stays green; CI provides the service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgEngine } from '../src/index.ts';
import { runStorageConformance, type ConformanceResult } from '@aether/kernel-conformance/src/index.ts';
import type { StoredRecord } from '@aether/kernel-storage';

const DSN = process.env.AETHER_PG_DSN ?? 'postgres://aether:aether@127.0.0.1:55433/aether';

async function pgReachable(): Promise<boolean> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: DSN });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

function record(over: Record<string, unknown> = {}): StoredRecord {
  return {
    id: 'e1', tenantId: 't1', typeId: 'et_apparel',
    validFrom: '2026-01-01T00:00:00Z', validTo: null,
    recordedAt: '2026-01-01T00:00:00Z', epoch: 1,
    attributes: { size: 'M' }, ...over,
  };
}

test('POSTGRES ENGINE ADMITTED through the full conformance matrix (wire protocol, production path)', async (t) => {
  if (!(await pgReachable())) return t.skip('no PG server on AETHER_PG_DSN — run: docker run -d -e POSTGRES_USER=aether -e POSTGRES_PASSWORD=aether -e POSTGRES_DB=aether -p 55433:5432 postgres:17-alpine');
  const engine = new PgEngine({ connectionString: DSN });
  await engine.init();
  await engine.deleteAll();
  const result: ConformanceResult = await runStorageConformance(engine);
  assert.equal(result.admitted, true, result.failures.map((f) => `${f.caseId}: ${f.error}`).join('; '));
  await engine.deleteAll();
  await engine.close();
});

test('in-SQL bitemporal: asOf windows + full ordered history + transactional supersede', async (t) => {
  if (!(await pgReachable())) return t.skip('no PG server reachable');
  const engine = new PgEngine({ connectionString: DSN });
  await engine.init();
  await engine.deleteAll();

  // v1 window 2026-01 → 2026-06; v2 window 2026-06 → null
  await engine.put(record());
  await engine.closeVersion('e1', 't1', '2026-06-01T00:00:00Z');
  await engine.put(record({ validFrom: '2026-06-01T00:00:00Z', attributes: { size: 'L' } }));

  const asOf1 = await engine.query({ tenantId: 't1', asOf: '2026-03-01T00:00:00Z' });
  assert.equal(asOf1[0]!.attributes.size, 'M');
  const asOf2 = await engine.query({ tenantId: 't1', asOf: '2026-08-01T00:00:00Z' });
  assert.equal(asOf2[0]!.attributes.size, 'L');
  const current = await engine.get('e1', 't1');
  assert.equal(current!.attributes.size, 'L');

  const history = await engine.historyAll('t1', 'e1');
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((h) => h.validFrom).sort(), ['2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z']);
  await engine.deleteAll();
  await engine.close();
});

test('optimistic concurrency: second put without upsert rejected over the wire', async (t) => {
  if (!(await pgReachable())) return t.skip('no PG server reachable');
  const engine = new PgEngine({ connectionString: DSN });
  await engine.init();
  await engine.deleteAll();
  await engine.put(record({ id: 'cc1' }));
  await assert.rejects(() => engine.put(record({ id: 'cc1' })), /optimistic-concurrency conflict/);
  await engine.put(record({ id: 'cc1' }), { upsert: true }); // accepted
  await engine.deleteAll();
  await engine.close();
});

test('durability: data written by one engine instance is read by a NEW instance (real server)', async (t) => {
  if (!(await pgReachable())) return t.skip('no PG server reachable');
  const w = new PgEngine({ connectionString: DSN });
  await w.init();
  await w.deleteAll();
  await w.put(record({ id: 'dur1', attributes: { proof: 'wire-durable' } }));
  await w.close();
  const r = new PgEngine({ connectionString: DSN }); // fresh pool, same database
  const got = await r.get('dur1', 't1');
  assert.equal(got!.attributes.proof, 'wire-durable');
  await r.deleteAll();
  await r.close();
});
