// Tests: projection engine + bitemporal SDK — engine-agnostic (P0-KRN-012/013).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectionEngine, BitemporalQuery } from '../src/index.ts';
import { MemoryEngine, FileEngine } from '@aether/kernel-storage/src/index.ts';
import type { EntityTypeDef } from '@aether/kernel-primitives';

const apparel: EntityTypeDef = {
  id: 'et_apparel', kind: 'entity-type', name: 'Apparel',
  attributes: {
    size: { type: 'string', classification: 'public', required: true },
    color: { type: 'string', classification: 'public', required: true },
  },
  epoch: 1, validFrom: '2026-01-01T00:00:00Z', validTo: null, recordedAt: '2026-01-01T00:00:00Z',
};

for (const [label, engine] of [
  ['memory', new MemoryEngine()],
  ['file', new FileEngine(join(tmpdir(), `aether-proj-${Date.now()}.jsonl`))],
] as const) {
  test(`${label} engine: projection lifecycle — instantiate, find, supersede, validate`, async () => {
    const pe = new ProjectionEngine(engine as never);
    const p = pe.apply(apparel);
    const inst = await pe.instantiate(p, { size: 'M', color: 'navy' }, { id: 'sku-1', tenantId: 'acme', epoch: 1 });
    assert.equal(inst.attributes.color, 'navy');
    const got = await pe.find(p, 'acme', 'sku-1');
    assert.equal(got!.attributes.size, 'M');
    const v2 = await pe.supersede(p, 'acme', 'sku-1', { size: 'L', color: 'navy' }, 2);
    assert.equal(v2.attributes.size, 'L');
    await assert.rejects(
      () => pe.instantiate(p, { color: 'red' }, { id: 'sku-2', tenantId: 'acme', epoch: 1 }),
      /Missing required attribute "size"/
    );
  });

  test(`${label} engine: bitemporal history + point-in-time read`, async () => {
    const pe = new ProjectionEngine(engine as never);
    const bq = new BitemporalQuery(engine as never);
    const p = pe.apply(apparel);
    await pe.instantiate(p, { size: 'S', color: 'red' }, { id: 'sku-9', tenantId: 'acme2', epoch: 1 });
    await new Promise((r) => setTimeout(r, 3)); // deterministic window separation
    const sup = await pe.supersede(p, 'acme2', 'sku-9', { size: 'M', color: 'red' }, 2);
    const hist = await bq.history('acme2', 'sku-9');
    assert.equal(hist.length, 2);
    // point-in-time: inside first window → old attrs; at supersede instant → new attrs
    const closed = hist.find((r) => r.validTo !== null)!;
    const justBefore = new Date(Date.parse(closed.validTo!) - 1).toISOString();
    assert.ok(justBefore >= closed.validFrom, 'window separation too small — bump supersede guard');
    const before = await bq.asOf({ tenantId: 'acme2', id: 'sku-9', asOf: justBefore });
    assert.equal(before.length, 1);
    assert.equal(before[0]?.attributes.size, 'S');
    const after = await bq.asOf({ tenantId: 'acme2', id: 'sku-9', asOf: sup.validFrom });
    assert.equal(after.length, 1);
    assert.equal(after[0]?.attributes.size, 'M');
    const nowSnap = await bq.snapshot('acme2', new Date().toISOString());
    const current = nowSnap.filter((r) => r.validTo === null);
    assert.equal(current.length, 1);
  });
}
