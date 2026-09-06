// Tests: Storage SPI — engine parity, capabilities, durability, concurrency, history (P0-CTR-003).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEngine, FileEngine, negotiate } from '../src/index.ts';

function record(over: Record<string, unknown> = {}, seq = 0) {
  return {
    id: 'e1', tenantId: 't1', typeId: 'et_apparel',
    validFrom: new Date(Date.parse('2026-01-01T00:00:00Z') + seq).toISOString(), validTo: null,
    recordedAt: '2026-01-01T00:00:00Z', epoch: 1,
    attributes: { size: 'M' }, ...over,
  };
}

test('capability negotiation rejects wrong engine class', () => {
  const mem = new MemoryEngine();
  assert.throws(() => negotiate(mem, { durable: true }), /durable/);
  assert.throws(() => negotiate(mem, { engineClass: 'search' }), /engineClass/);
  negotiate(mem, { engineClass: 'document' });
});

for (const Engine of [MemoryEngine, FileEngine]) {
  test(`${Engine.name}: put/get/query/asOf/closeVersion parity`, async () => {
    const path = Engine === FileEngine ? join(tmpdir(), `aether-test-${Date.now()}.jsonl`) : undefined as never;
    const eng = path ? new FileEngine(path) : new MemoryEngine() as unknown as FileEngine;
    await eng.put(record());
    const got = await eng.get('e1', 't1');
    assert.equal(got!.attributes.size, 'M');
    await eng.closeVersion('e1', 't1', '2026-02-01T00:00:00Z');
    assert.equal(await eng.get('e1', 't1'), undefined);
    const past = await eng.query({ tenantId: 't1', asOf: '2026-01-15T00:00:00Z' });
    assert.equal(past.length, 1);
  });

  test(`${Engine.name}: optimistic-concurrency conflict on duplicate current`, async () => {
    const path = Engine === FileEngine ? join(tmpdir(), `aether-cc-${Date.now()}.jsonl`) : undefined as never;
    const eng = path ? new FileEngine(path) : new MemoryEngine() as unknown as FileEngine;
    await eng.put(record());
    await assert.rejects(() => eng.put(record({ attributes: { size: 'L' } })), /optimistic-concurrency/);
    await eng.put(record({ attributes: { size: 'L' } }), { upsert: true });
  });

  test(`${Engine.name}: historyAll returns version log + current`, async () => {
    const path = Engine === FileEngine ? join(tmpdir(), `aether-hist-${Date.now()}.jsonl`) : undefined as never;
    const eng = path ? new FileEngine(path) : new MemoryEngine() as unknown as FileEngine;
    await eng.put(record({ attributes: { size: 'S' } }, 0));
    await eng.put(record({ attributes: { size: 'M' } }, 1), { upsert: true });
    await eng.put(record({ attributes: { size: 'L' } }, 2), { upsert: true });
    const hist = await eng.historyAll('t1', 'e1');
    assert.equal(hist.length, 3);
    assert.equal(hist[hist.length - 1]!.attributes.size, 'L');
  });
}

test('FileEngine durability: survives process restart (new instance, same path)', async () => {
  const path = join(tmpdir(), `aether-dur-${Date.now()}.jsonl`);
  const eng1 = new FileEngine(path);
  await eng1.put(record({ attributes: { size: 'XL' } }));
  const eng2 = new FileEngine(path);
  const got = await eng2.get('e1', 't1');
  assert.equal(got!.attributes.size, 'XL');
});
