// Tests: codegen pipeline — DDL/API/UI generated from registry epochs (P0-KRN-008).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateAll } from '../src/index.ts';
import type { EntityTypeDef } from '@aether/kernel-primitives';

const apparel: EntityTypeDef = {
  id: 'et_apparel_1',
  kind: 'entity-type',
  name: 'Apparel',
  extends: 'PhysicalProduct',
  attributes: {
    size: { type: 'string', classification: 'public', required: true },
    color: { type: 'string', classification: 'public', required: true },
    email: { type: 'string', classification: 'pii' },
  },
  epoch: 3,
  validFrom: '2026-01-01T00:00:00Z',
  validTo: null,
  recordedAt: '2026-01-01T00:00:00Z',
};

test('projection DDL generated: no EAV hot-path tax, epoch-stamped', () => {
  const { ddl } = generateAll(apparel);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS apparel/);
  assert.match(ddl, /size TEXT NOT NULL/);
  assert.match(ddl, /epoch INT NOT NULL/);
  assert.match(ddl, /tenant_id TEXT NOT NULL/);
  assert.match(ddl, /Generated from registry epoch 3/);
});

test('API doc generated with epoch version', () => {
  const { api } = generateAll(apparel);
  const doc = api as { info: { version: string }; paths: Record<string, unknown> };
  assert.equal(doc.info.version, 'epoch-3.0.0');
  assert.ok(doc.paths['/apparel']);
});

test('admin CRUD schema generated; PII fields masked', () => {
  const { adminUi } = generateAll(apparel);
  const ui = adminUi as { formFields: Array<{ name: string; input: string }> };
  const email = ui.formFields.find((f) => f.name === 'email');
  assert.equal(email!.input, 'masked-input');
});
