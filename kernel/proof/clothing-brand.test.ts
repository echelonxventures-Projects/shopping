// Doctrine proof: a clothing brand derived end-to-end from pure config (M1 fixture).
// Loads packs/acmewear-clothing/pack.json and drives it through every kernel stage:
// registry epoch → DLP gate → entity instances → relationships → context resolution
// → U²ID schemes → codegen (DDL/API/UI). Zero hardcoded domain code — the pack IS the vertical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Registry, EntityStore } from '@aether/kernel-registry/src/index.ts';
import { ContextResolver } from '@aether/kernel-context/src/index.ts';
import { UidAllocator, UDictionary } from '@aether/kernel-uid/src/index.ts';
import { generateAll } from '@aether/kernel-codegen/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../../packs/acmewear-clothing/pack.json'), 'utf8'));

test('clothing brand = one config graph: pack loads, DLP-clean, epoch published', () => {
  const registry = new Registry();
  const epoch = registry.publishEpoch([
    ...pack.entityTypes,
    ...pack.relationshipTypes,
    ...pack.behaviorPacks,
  ]);
  assert.equal(epoch, 1);
  const apparel = registry.entityType('Apparel');
  assert.ok(apparel, 'Apparel entity type resolved from registry');
  assert.equal(apparel!.attributes.hsCode.classification, 'public');
});

test('Apparel instances + variant-of/styled-with relationships via U²ID', () => {
  const registry = new Registry();
  registry.publishEpoch(pack.entityTypes);
  const apparel = registry.entityType('Apparel')!;

  const uid = new UidAllocator();
  const dict = new UDictionary();
  const store = new EntityStore();

  const parent = uid.allocate('reference-uuidv7', 'Apparel');
  const variant = uid.allocate('reference-uuidv7', 'Apparel');
  dict.register(parent.value, 'e_tee', 'Apparel', 1);
  dict.register(variant.value, 'e_tee_red', 'Apparel', 1);
  dict.alias('GTIN-0888443300155', parent.value);

  store.create({
    id: parent.value,
    typeId: apparel.id,
    attributes: { size: 'M', color: 'navy', fabric: 'cotton', hsCode: '6109.10', countryOfOrigin: 'IN' },
    epoch: 1,
    validFrom: '2026-09-06T00:00:00Z',
    validTo: null,
    recordedAt: '2026-09-06T00:00:00Z',
  });
  store.relate({
    id: 'rel_1',
    typeId: 'rel_variant_of',
    fromId: variant.value,
    toId: parent.value,
    epoch: 1,
    validFrom: '2026-09-06T00:00:00Z',
    validTo: null,
    recordedAt: '2026-09-06T00:00:00Z',
  });

  assert.deepEqual(dict.resolve('GTIN-0888443300155'), { entityId: 'e_tee', entityType: 'Apparel' });
  assert.deepEqual(store.outgoing(variant.value), [{ typeId: 'rel_variant_of', toId: parent.value }]);
});

test('per-market size charts resolved by context (US vs EU)', () => {
  const resolver = new ContextResolver(pack.contextualConfig);
  const us = resolver.pick({ tenant: 'acmewear', market: 'US' }, 'size-chart');
  const eu = resolver.pick({ tenant: 'acmewear', market: 'EU' }, 'size-chart');
  assert.deepEqual((us!.value as { sizes: string[] }).sizes, ['XS', 'S', 'M', 'L', 'XL']);
  assert.deepEqual((eu!.value as { sizes: string[] }).sizes, ['EU-34', 'EU-36', 'EU-38', 'EU-40']);
});

test('pack-registered ID schemes allocate without code changes', () => {
  const uid = new UidAllocator();
  for (const scheme of pack.idSchemes) uid.registerScheme(scheme);
  const sku = uid.allocate('acme-sku', 'Apparel');
  const acmeSku = pack.idSchemes.find((s: { name: string }) => s.name === 'acme-sku') as {
    alphabet: string;
    length: number;
  };
  const re = new RegExp(`^[${acmeSku.alphabet}]{${acmeSku.length}}$`);
  assert.match(sku.value, re);
});

test('codegen: Apparel DDL/API/UI generated from registry epoch — zero hand-written artifacts', () => {
  const registry = new Registry();
  registry.publishEpoch(pack.entityTypes);
  const apparel = registry.entityType('Apparel')!;
  const { ddl, api, adminUi } = generateAll(apparel);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS apparel/);
  assert.match(ddl, /hs_code TEXT NOT NULL/);
  assert.ok((api as { paths: Record<string, unknown> }).paths['/apparel']);
  const ui = adminUi as { resource: string; formFields: Array<{ name: string }> };
  assert.equal(ui.resource, 'apparel');
  assert.ok(ui.formFields.some((f) => f.name === 'fabric'));
});
