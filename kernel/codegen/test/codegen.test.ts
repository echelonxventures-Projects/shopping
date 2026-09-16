// Tests: codegen pipeline — DDL/API/UI generated from registry epochs (P0-KRN-008)
// plus the contract layer: CloudEvents envelope, OTel/W3C telemetry, and the
// contract-compatibility gate (P0-CTR-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateAll,
  generateCloudEvent,
  validateCloudEvent,
  makeTraceContext,
  generateOtelSpan,
  contractCompat,
} from '../src/index.ts';
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

test('CloudEvents-class envelope: required attributes + platform extensions (tenant/market/epoch)', () => {
  const evt = generateCloudEvent({
    id: 'evt-1',
    source: 'aether/catalog',
    type: 'aether.product.created.v1',
    subject: 'et_apparel/prod-1',
    time: '2026-09-16T00:00:00Z',
    data: { productId: 'prod-1' },
    tenantId: 't-1',
    market: 'EU',
    epoch: 3,
  });
  assert.equal(evt.specversion, '1.0');
  assert.equal(evt.datacontenttype, 'application/json');
  assert.equal(evt.extensions!.tenantid, 't-1');
  assert.equal(evt.extensions!.market, 'EU');
  assert.equal(evt.extensions!.epoch, 3);
  assert.equal(validateCloudEvent(evt), true);
});

test('CloudEvents validation gate rejects malformed events (bad specversion, missing required)', () => {
  assert.equal(validateCloudEvent({ specversion: '0.3' as never, id: 'x', source: 's', type: 't', time: 'now' }), 'specversion must be "1.0"');
  assert.equal(validateCloudEvent({ specversion: '1.0', id: '', source: 's', type: 't', time: 'now' }), 'missing required CloudEvents attribute "id"');
  assert.equal(validateCloudEvent({ specversion: '1.0', id: 'x', source: 's', type: 't', time: '' }), 'missing required CloudEvents attribute "time"');
});

test('W3C trace context + OTel-class span generation with registry attributes', () => {
  const trace = makeTraceContext('0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331');
  assert.equal(trace.traceparent, '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
  assert.throws(() => makeTraceContext('not-hex', 'b7ad6b7169203331'), /32 lowercase hex/);
  const span = generateOtelSpan({
    name: 'catalog.createProduct',
    kind: 'SERVER',
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    startTimeUnixNano: '1757971200000000000',
    endTimeUnixNano: '1757971200500000000',
    serviceName: 'catalog',
    epoch: 3,
  });
  assert.equal(span.attributes['service.name'], 'catalog');
  assert.equal(span.attributes['aether.registry.epoch'], 3);
  assert.equal(span.status.code, 'UNSET');
  const failed = generateOtelSpan({
    name: 'checkout.saga',
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    startTimeUnixNano: '1',
    endTimeUnixNano: '2',
    error: 'payment declined',
  });
  assert.deepEqual(failed.status, { code: 'ERROR', message: 'payment declined' });
});

test('contract-compat gate: additive changes pass, breaking changes are flagged with reasons', () => {
  const prev: EntityTypeDef = {
    id: 'et_a', kind: 'entity-type', name: 'Widget', attributes: {
      title: { type: 'string', classification: 'public', required: true },
      price: { type: 'number', classification: 'internal' },
    }, epoch: 4, validFrom: '2026-01-01T00:00:00Z', validTo: null, recordedAt: '2026-01-01T00:00:00Z',
  };
  const additive: EntityTypeDef = {
    ...prev, epoch: 5, attributes: { ...prev.attributes, color: { type: 'string', classification: 'public' } },
  };
  const ok = contractCompat(prev, additive);
  assert.equal(ok.compatible, true);
  assert.equal(ok.changes[0]!.change, 'added');
  assert.equal(ok.changes[0]!.breaking, false);

  const breaking: EntityTypeDef = {
    ...prev, epoch: 6, attributes: {
      title: { type: 'string', classification: 'public', required: true },
      price: { type: 'string', classification: 'pii' },
    },
  };
  const bad = contractCompat(prev, breaking);
  assert.equal(bad.compatible, false);
  assert.ok(bad.changes.some((c) => c.change === 'type-changed' && c.breaking));
  assert.ok(bad.changes.some((c) => c.change === 'classification-tightened' && c.breaking));

  const requiredAdded: EntityTypeDef = {
    ...prev, epoch: 7, attributes: { ...prev.attributes, sku: { type: 'string', classification: 'internal', required: true } },
  };
  assert.equal(contractCompat(prev, requiredAdded).compatible, false);
});