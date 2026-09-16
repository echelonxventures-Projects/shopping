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

// ---------- Contract layer (P0-CTR-001) ----------
// Events (CloudEvents-class), telemetry (OTel-class/W3C trace context), and the
// contract-compatibility gate. All envelopes are GENERATED from registry data;
// no hand-written per-service event or span shape exists anywhere.

export interface CloudEventEnvelope {
  specversion: '1.0';
  id: string;
  source: string;
  type: string;
  subject?: string;
  time: string;
  datacontenttype: 'application/json';
  data: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface CloudEventInput {
  id: string;
  source: string;
  type: string;
  subject?: string;
  time?: string;
  data?: Record<string, unknown>;
  tenantId?: string;
  market?: string;
  epoch?: number;
  extensions?: Record<string, unknown>;
}

/** CloudEvents 1.0 envelope with platform extensions carried as first-class context */
export function generateCloudEvent(input: CloudEventInput): CloudEventEnvelope {
  const extensions: Record<string, unknown> = { ...(input.extensions ?? {}) };
  if (input.tenantId !== undefined) extensions['tenantid'] = input.tenantId;
  if (input.market !== undefined) extensions['market'] = input.market;
  if (input.epoch !== undefined) extensions['epoch'] = input.epoch;
  return {
    specversion: '1.0',
    id: input.id,
    source: input.source,
    type: input.type,
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    time: input.time ?? new Date().toISOString(),
    datacontenttype: 'application/json',
    data: input.data ?? {},
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
  };
}

/** validate an event against the CloudEvents 1.0 required-attribute rules */
export function validateCloudEvent(evt: Partial<CloudEventEnvelope>): true | string {
  if (evt.specversion !== '1.0') return 'specversion must be "1.0"';
  for (const f of ['id', 'source', 'type', 'time'] as const) {
    const v = evt[f];
    if (typeof v !== 'string' || v.length === 0) return `missing required CloudEvents attribute "${f}"`;
  }
  if (evt.datacontenttype !== undefined && evt.datacontenttype !== 'application/json') {
    return 'datacontenttype must be application/json for registry-generated events';
  }
  return true;
}

export interface TraceContext {
  traceparent: string;
  tracestate?: string;
}

/** deterministic trace context from a trace id + span id (W3C traceparent) */
export function makeTraceContext(traceId: string, spanId: string, sampled = true): TraceContext {
  if (!/^[0-9a-f]{32}$/.test(traceId)) throw new Error('traceId must be 32 lowercase hex chars (W3C)');
  if (!/^[0-9a-f]{16}$/.test(spanId)) throw new Error('spanId must be 16 lowercase hex chars (W3C)');
  return { traceparent: `00-${traceId}-${spanId}-${sampled ? '01' : '00'}` };
}

export interface OtelSpanEnvelope {
  name: string;
  kind: 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER' | 'INTERNAL';
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, unknown>;
  status: { code: 'UNSET' | 'OK' | 'ERROR'; message?: string };
}

export interface OtelSpanInput {
  name: string;
  kind?: OtelSpanEnvelope['kind'];
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: Record<string, unknown>;
  error?: string;
  serviceName?: string;
  epoch?: number;
}

/** OTel-class span generated from registry/telemetry data (never hand-shaped) */
export function generateOtelSpan(input: OtelSpanInput): OtelSpanEnvelope {
  const attributes: Record<string, unknown> = { ...(input.attributes ?? {}) };
  if (input.serviceName !== undefined) attributes['service.name'] = input.serviceName;
  if (input.epoch !== undefined) attributes['aether.registry.epoch'] = input.epoch;
  return {
    name: input.name,
    kind: input.kind ?? 'INTERNAL',
    traceId: input.traceId,
    spanId: input.spanId,
    ...(input.parentSpanId !== undefined ? { parentSpanId: input.parentSpanId } : {}),
    startTimeUnixNano: input.startTimeUnixNano,
    endTimeUnixNano: input.endTimeUnixNano,
    attributes,
    status: input.error ? { code: 'ERROR', message: input.error } : { code: 'UNSET' },
  };
}

export interface ContractChange {
  field: string;
  change: 'added' | 'removed' | 'type-changed' | 'became-required' | 'became-optional' | 'classification-tightened';
  breaking: boolean;
  detail: string;
}

export interface ContractCompatResult {
  compatible: boolean;
  epochFrom: number;
  epochTo: number;
  changes: ContractChange[];
}

/** contract-compatibility gate between two epochs of one entity type */
export function contractCompat(prev: EntityTypeDef, next: EntityTypeDef): ContractCompatResult {
  const changes: ContractChange[] = [];
  const prevAttrs = prev.attributes;
  const nextAttrs = next.attributes;

  for (const [name, p] of Object.entries(prevAttrs)) {
    const n = nextAttrs[name];
    if (!n) {
      changes.push({ field: name, change: 'removed', breaking: true, detail: `attribute "${name}" removed` });
      continue;
    }
    if (p.type !== n.type) {
      changes.push({ field: name, change: 'type-changed', breaking: true, detail: `${name}: ${p.type} → ${n.type}` });
    }
    if (p.classification !== n.classification && rank(n.classification) > rank(p.classification)) {
      changes.push({
        field: name,
        change: 'classification-tightened',
        breaking: true,
        detail: `${name}: classification ${p.classification} → ${n.classification}`,
      });
    }
    if (!p.required && n.required) {
      changes.push({ field: name, change: 'became-required', breaking: true, detail: `${name} is now required` });
    }
    if (p.required && !n.required) {
      changes.push({ field: name, change: 'became-optional', breaking: false, detail: `${name} is now optional` });
    }
  }

  for (const [name, n] of Object.entries(nextAttrs)) {
    if (!prevAttrs[name]) {
      changes.push({ field: name, change: 'added', breaking: n.required === true, detail: n.required ? `${name} added as REQUIRED (breaking)` : `${name} added optional` });
    }
  }

  return {
    compatible: changes.every((c) => !c.breaking),
    epochFrom: prev.epoch,
    epochTo: next.epoch,
    changes,
  };
}

function rank(c: AttributeDefinition['classification']): number {
  switch (c) {
    case 'public':
      return 0;
    case 'internal':
      return 1;
    case 'pii':
      return 2;
    case 'sensitive-pii':
      return 3;
    case 'card-data-prohibited':
      return 4;
    default:
      return 0;
  }
}

function snake(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}
function kebab(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}
