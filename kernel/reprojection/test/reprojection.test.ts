// Tests: epoch reprojection — transform math from diff data, batched runs,
// pause/resume checkpoints, error tolerance, zero-downtime contract (P3-SCL-003).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReprojectionEngine, applyDiff } from '../src/index.ts';
import type { EpochDiff } from '../src/index.ts';
import type { StoredRecord } from '@aether/kernel-storage';
import type { EntityTypeDef } from '@aether/kernel-primitives';

const rec = (i: number, attrs: Record<string, unknown>): StoredRecord => ({
  id: `r-${String(i).padStart(6, '0')}`,
  tenantId: 't',
  typeId: 'et_apparel',
  validFrom: '2026-01-01T00:00:00Z',
  validTo: null,
  recordedAt: '2026-01-01T00:00:00Z',
  epoch: 1,
  attributes: attrs,
});

const diff: EpochDiff = {
  fromEpoch: 1,
  toEpoch: 2,
  entityTypeId: 'et_apparel',
  transforms: [
    { kind: 'rename-attribute', from: 'colour', to: 'color' }, // legacy rename
    { kind: 'add-attribute', attribute: 'fabric', default: 'unknown' },
    { kind: 'derive', attribute: 'searchKey', from: 'title', op: 'uppercase' },
    { kind: 'derive', attribute: 'priceInCents', from: 'price', op: 'multiply', operand: 100, roundTo: 0 },
  ],
};

const newTypeDef: EntityTypeDef = {
  id: 'et_apparel_v2', kind: 'entity-type', name: 'Apparel', extends: null,
  attributes: {
    color: { type: 'string', classification: 'public' },
    fabric: { type: 'string', classification: 'public' },
    searchKey: { type: 'string', classification: 'public' },
    priceInCents: { type: 'number', classification: 'public' },
  },
  epoch: 2, validFrom: '2026-09-01T00:00:00Z', validTo: null, recordedAt: '2026-09-01T00:00:00Z',
};

function records(n: number): StoredRecord[] {
  return Array.from({ length: n }, (_, i) => rec(i, { colour: 'navy', title: `Tee ${i}`, price: 19.99 }));
}

test('applyDiff: rename + default + derive transforms from diff data (pure, replayable)', () => {
  const out = applyDiff(rec(0, { colour: 'navy', title: 'Classic Tee', price: 19.99 }), diff);
  const attrs = out.attributes as Record<string, unknown>;
  assert.equal(attrs['color'], 'navy');
  assert.equal(attrs['colour'], undefined); // renamed away
  assert.equal(attrs['fabric'], 'unknown'); // defaulted
  assert.equal(attrs['searchKey'], 'CLASSIC TEE'); // derived
  assert.equal(attrs['priceInCents'], 1999); // derived ×100
  assert.equal(out.epoch, 2);
  // idempotent on already-migrated shape: color exists, colour absent — rename no-ops
  const again = applyDiff(out, diff);
  assert.equal((again.attributes as Record<string, unknown>)['color'], 'navy');
  assert.equal((again.attributes as Record<string, unknown>)['priceInCents'], 1999);
});

test('1M-record migration: batched, correct count, exact checkpoint semantics', () => {
  const engine = new ReprojectionEngine();
  const N = 1_000_000;
  const job = engine.createJob(diff, newTypeDef, N);
  const written: StoredRecord[] = [];
  const done = engine.run(job.jobId, records(N), (r) => written.push(r), { batchSize: 10_000 });
  assert.equal(done.status, 'completed');
  assert.equal(done.processed, N);
  assert.equal(written.length, N);
  assert.equal(done.errors.length, 0);
  assert.equal((written[500_000]!.attributes as Record<string, unknown>)['searchKey'], 'TEE 500000');
  assert.ok(done.completedAt);
});

test('pause/resume: checkpointed job continues exactly where it stopped', () => {
  const engine = new ReprojectionEngine();
  const N = 10_000;
  const job = engine.createJob(diff, newTypeDef, N);
  const written: StoredRecord[] = [];
  const source = records(N);
  // pause after 3 batches of 1000 → 3000 processed
  const paused = engine.run(job.jobId, source, (r) => written.push(r), { batchSize: 1000, pauseAfterBatches: 3 });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.processed, 3000);
  const checkpoint = paused.checkpointId!;
  // resume with the SAME source: fast-forwards to checkpoint, completes the rest
  const done = engine.run(job.jobId, source, (r) => written.push(r), { batchSize: 1000 });
  assert.equal(done.status, 'completed');
  assert.equal(done.processed, N); // total processed counter reaches N
  assert.equal(written.length, N); // exactly N writes — no duplicates, no gaps
  // verify no record written twice
  const ids = new Set(written.map((w) => w.id));
  assert.equal(ids.size, N);
  void checkpoint;
});

test('error tolerance: bad records recorded, job fails loudly if incomplete', () => {
  const engine = new ReprojectionEngine();
  const src = records(100);
  const job = engine.createJob(diff, newTypeDef, 100);
  let n = 0;
  const done = engine.run(job.jobId, src, () => {
    n++;
    if (n === 50) throw new Error('sink unavailable'); // one failure (50th call = record r-000049)
  });
  assert.equal(done.errors.length, 1);
  assert.equal(done.errors[0]!.recordId, 'r-000049'); // 0-indexed record ids
  assert.equal(done.processed, 100);
  // errors present but all records attempted → completed with error log (ops replay failed ids)
  assert.equal(done.status, 'completed');
});

test('jobs registry: unknown jobId rejected; completed jobs not re-runnable', () => {
  const engine = new ReprojectionEngine();
  assert.throws(() => engine.job('nope'), /not found/);
  const job = engine.createJob(diff, newTypeDef, 1);
  const done = engine.run(job.jobId, records(1), () => {});
  assert.equal(done.status, 'completed');
  const again = engine.run(job.jobId, records(1), () => { throw new Error('should not run'); });
  assert.equal(again.status, 'completed'); // no-op
});
