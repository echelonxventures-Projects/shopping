// Tests: registry epoch model + bitemporal definition evolution (P0-KRN-006, P0-KRN-013).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry, EntityStore } from '../src/index.ts';
import type { EntityTypeDef } from '@aether/kernel-primitives';

function et(partial: Partial<EntityTypeDef>): EntityTypeDef {
  return {
    id: 'et_x',
    kind: 'entity-type',
    name: 'X',
    attributes: {},
    epoch: 1,
    validFrom: '2026-01-01T00:00:00Z',
    validTo: null,
    recordedAt: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

test('epochs publish, supersede, and old epochs still resolve', () => {
  const r = new Registry();
  const e1 = r.publishEpoch([et({ id: 'et_a_v1', name: 'A', attributes: { color: { type: 'string', classification: 'public' } } })]);
  const e2 = r.publishEpoch([
    et({
      id: 'et_a_v2',
      name: 'A',
      attributes: {
        color: { type: 'string', classification: 'public' },
        size: { type: 'string', classification: 'public' },
      },
    }),
  ]);
  assert.equal(e2, 2);
  assert.ok(r.entityType('A')!.attributes.size);
  assert.equal(r.entityType('A', e1)!.attributes.size, undefined);
});

test('epoch rollback restores prior definition set', () => {
  const r = new Registry();
  r.publishEpoch([et({ id: 'et_a_v1', name: 'A' })]);
  r.publishEpoch([et({ id: 'et_a_v2', name: 'A' })]);
  assert.ok(r.manifest(1).entries[0]);
});

test('EntityStore: create, relate, point-in-time get', () => {
  const s = new EntityStore();
  s.create({
    id: 'i1',
    typeId: 'et_p',
    attributes: { sku: 'T-001' },
    epoch: 1,
    validFrom: '2026-01-01T00:00:00Z',
    validTo: null,
    recordedAt: '2026-01-01T00:00:00Z',
  });
  s.create({
    id: 'i2',
    typeId: 'et_p',
    attributes: { sku: 'T-002' },
    epoch: 1,
    validFrom: '2026-03-01T00:00:00Z',
    validTo: null,
    recordedAt: '2026-03-01T00:00:00Z',
  });
  assert.equal(s.byType('et_p', '2026-02-01T00:00:00Z').length, 1);
  assert.equal(s.byType('et_p').length, 2);
  s.relate({
    id: 'rel1',
    typeId: 'variant-of',
    fromId: 'i2',
    toId: 'i1',
    epoch: 1,
    validFrom: '2026-01-01T00:00:00Z',
    validTo: null,
    recordedAt: '2026-01-01T00:00:00Z',
  });
  assert.deepEqual(s.outgoing('i2'), [{ typeId: 'variant-of', toId: 'i1' }]);
});
