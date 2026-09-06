// @aether/kernel-codegen — Codegen pipeline v0 (P0-KRN-008).
// Registry epochs → generated artifacts. v0 generates: storage projection DDL,
// typed API surface (OpenAPI-class doc), and admin CRUD UI schema.
// Doctrine 1: generated, never hand-written per entity.

import type { EntityTypeDef, AttributeDefinition } from '@aether/kernel-primitives';

const SQL_TYPES: Record<AttributeDefinition['type'], string> = {
  string: 'TEXT',
  number: 'NUMERIC',
  boolean: 'BOOLEAN',
  object: 'JSONB',
  array: 'JSONB',
  reference: 'TEXT',
};

export function generateProjectionDdl(def: EntityTypeDef): string {
  const cols = Object.entries(def.attributes)
    .map(([name, attr]) => `  ${snake(name)} ${SQL_TYPES[attr.type]}${attr.required ? ' NOT NULL' : ''}`)
    .join(',\n');
  return [
    `-- Generated from registry epoch ${def.epoch} for entity-type ${def.name} (do not hand-edit)`,
    `CREATE TABLE IF NOT EXISTS ${snake(def.name)} (`,
    `  id TEXT PRIMARY KEY,`,
    `  tenant_id TEXT NOT NULL,`,
    `  valid_from TIMESTAMPTZ NOT NULL,`,
    `  valid_to TIMESTAMPTZ,`,
    `  recorded_at TIMESTAMPTZ NOT NULL,`,
    `  epoch INT NOT NULL,`,
    cols ? cols + ',' : '',
    `  attributes JSONB NOT NULL DEFAULT '{}'`,
    `);`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function generateApiDoc(def: EntityTypeDef): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: `${def.name} API (generated, epoch ${def.epoch})`,
      version: `epoch-${def.epoch}.0.0`,
    },
    paths: {
      [`/${kebab(def.name)}`]: { post: { summary: `Create ${def.name}`, tags: [def.name] } },
      [`/${kebab(def.name)}/{id}`]: { get: { summary: `Get ${def.name}`, tags: [def.name] } },
    },
    'x-aether-epoch': def.epoch,
    'x-aether-source': 'registry-codegen',
  };
}

export function generateAdminCrudSchema(def: EntityTypeDef): Record<string, unknown> {
  return {
    resource: kebab(def.name),
    title: def.name,
    generatedFromEpoch: def.epoch,
    listColumns: Object.keys(def.attributes).slice(0, 6),
    formFields: Object.entries(def.attributes).map(([name, attr]) => ({
      name,
      type: attr.type,
      required: attr.required ?? false,
      classification: attr.classification,
      input:
        attr.classification === 'pii' || attr.classification === 'sensitive-pii'
          ? 'masked-input'
          : attr.type === 'boolean'
            ? 'toggle'
            : attr.type === 'number'
              ? 'number-input'
              : 'text-input',
    })),
  };
}

export function generateAll(def: EntityTypeDef) {
  return {
    ddl: generateProjectionDdl(def),
    api: generateApiDoc(def),
    adminUi: generateAdminCrudSchema(def),
  };
}

function snake(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}
function kebab(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}
