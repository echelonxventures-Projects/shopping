// Tests: U²ID allocation + U²D dictionary invariants (P0-KRN-010, §3.15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UidAllocator, UDictionary } from '../src/index.ts';

test('auto-allocation: collision-free across 10k allocations (scheme = config)', () => {
  const a = new UidAllocator();
  const seen = new Set<string>();
  for (let i = 0; i < 10_000; i++) {
    const { value } = a.allocate('reference-uuidv7', 'product');
    assert.ok(!seen.has(value), 'collision detected');
    seen.add(value);
    assert.ok(value.length >= 30);
  }
});

test('infinite schemes: register custom scheme at runtime (zero code change)', () => {
  const a = new UidAllocator();
  a.registerScheme({ name: 'ord-short', format: 'opaque-random', length: 12, alphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' });
  const id = a.allocate('ord-short', 'order');
  assert.equal(id.value.length, 12);
  assert.match(id.value, /^[A-Z2-9]+$/);
});

test('U²D: never-reuse invariant enforced', () => {
  const d = new UDictionary();
  d.register('u1', 'e1', 'product', 1);
  assert.throws(() => d.register('u1', 'e2', 'product', 1), /never-reuse/);
});

test('U²D: alias resolution + merge maps to canonical; retired IDs unresolvable', () => {
  const d = new UDictionary();
  d.register('u1', 'e1', 'product', 1);
  d.register('u2', 'e2', 'product', 1);
  d.alias('EAN-0123456', 'u1');
  assert.deepEqual(d.resolve('EAN-0123456'), { entityId: 'e1', entityType: 'product' });
  d.merge('u1', 'u2');
  assert.deepEqual(d.resolve('u1'), { entityId: 'e2', entityType: 'product' });
  d.retire('u2');
  assert.equal(d.resolve('u2'), undefined);
});
