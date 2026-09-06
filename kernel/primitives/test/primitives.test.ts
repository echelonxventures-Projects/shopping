// Tests for kernel primitives — Registry DLP floor (P0-KRN-011) + bitemporal validity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEntityType,
  isCurrent,
  RegistryDLPError,
  type EntityTypeDef,
} from '../src/index.ts';

function entityTypeDef(partial: Partial<EntityTypeDef>): EntityTypeDef {
  return {
    id: 'et_test',
    kind: 'entity-type',
    name: 'Test',
    attributes: {},
    epoch: 1,
    validFrom: '2026-01-01T00:00:00Z',
    validTo: null,
    recordedAt: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

test('P0-KRN-011: card-data attribute rejected at registry write (PCI SAQ-A permanent)', () => {
  const def = entityTypeDef({
    attributes: { cardNumber: { type: 'string', classification: 'card-data-prohibited' } },
  });
  assert.throws(() => validateEntityType(def), RegistryDLPError);
});

test('PII and public classifications accepted', () => {
  const def = entityTypeDef({
    attributes: {
      email: { type: 'string', classification: 'pii' },
      title: { type: 'string', classification: 'public' },
    },
  });
  validateEntityType(def);
});

test('bitemporal validity: current, expired, not-yet-valid', () => {
  const at = '2026-06-01T00:00:00Z';
  assert.equal(
    isCurrent(
      { validFrom: '2026-01-01', validTo: null, recordedAt: '2026-01-01' },
      at
    ),
    true
  );
  assert.equal(
    isCurrent({ validFrom: '2026-01-01', validTo: '2026-05-01', recordedAt: '2026-01-01' }, at),
    false
  );
  assert.equal(
    isCurrent({ validFrom: '2026-07-01', validTo: null, recordedAt: '2026-01-01' }, at),
    false
  );
});
