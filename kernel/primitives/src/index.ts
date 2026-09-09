// @aether/kernel-primitives — Tier-0 invariant code (Doctrine 2: Invariant-only Kernel).
// Entity, Context, Relationship, Behavior, Rule, Workflow, Policy primitives.
// No domain concepts here — those are registry data (packs/). Refs: P0-KRN-002..005.

export interface Bitemporal {
  validFrom: string;
  validTo: string | null;
  recordedAt: string;
}

export type AttributeClassification =
  | 'public'
  | 'internal'
  | 'pii'
  | 'sensitive-pii'
  | 'card-data-prohibited';

export interface AttributeDefinition {
  /** informational only — the attribute's Record key IS its name (canonical) */
  name?: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'reference';
  classification: AttributeClassification;
  required?: boolean;
  itemsType?: AttributeDefinition['type'];
}

export interface EntityTypeDef extends Bitemporal {
  id: string;
  kind: 'entity-type';
  name: string;
  extends?: string | null;
  attributes: Record<string, AttributeDefinition>;
  epoch: number;
}

export interface RelationshipTypeDef extends Bitemporal {
  id: string;
  kind: 'relationship-type';
  name: string;
  fromType: string;
  toType: string;
  cardinality: 'one-one' | 'one-many' | 'many-many';
  epoch: number;
}

export interface EntityInstance extends Bitemporal {
  id: string;
  typeId: string;
  attributes: Record<string, unknown>;
  epoch: number;
}

export interface RelationshipInstance extends Bitemporal {
  id: string;
  typeId: string;
  fromId: string;
  toId: string;
  epoch: number;
}

export interface ContextFrame {
  tenant?: string | null;
  market?: string | null;
  locale?: string | null;
  channel?: string | null;
  audience?: string | null;
  world?: string | null;
  atTime?: string;
}

export type BehaviorCapability =
  | 'fulfillment'
  | 'entitlement'
  | 'pricing'
  | 'tax'
  | 'lifecycle'
  | 'identity'
  | 'storage'
  | 'search'
  | 'ui'
  | (string & {});

export interface BehaviorPackDef extends Bitemporal {
  id: string;
  kind: 'behavior-pack';
  name: string;
  capability: BehaviorCapability;
  config: Record<string, unknown>;
  epoch: number;
}

export interface RuleDef extends Bitemporal {
  id: string;
  kind: 'rule';
  name: string;
  decisionTable: Array<Record<string, unknown>>;
  priority: number;
  evaluator?: string;
  epoch: number;
}

export type WorkflowState = string;

export interface WorkflowDef extends Bitemporal {
  id: string;
  kind: 'workflow';
  name: string;
  entityTypeId: string;
  states: WorkflowState[];
  transitions: Array<{
    from: WorkflowState;
    to: WorkflowState;
    trigger: string;
    guardRules?: string[];
  }>;
  initial: WorkflowState;
  epoch: number;
}

export interface PolicyDef extends Bitemporal {
  id: string;
  kind: 'policy';
  name: string;
  scope: 'platform' | 'tenant' | 'market' | 'vendor';
  grants: Array<{
    subject: string;
    resource: string;
    actions: string[];
  }>;
  epoch: number;
}

export type RegistryEntry =
  | EntityTypeDef
  | RelationshipTypeDef
  | BehaviorPackDef
  | RuleDef
  | WorkflowDef
  | PolicyDef;

export interface EpochManifest {
  epoch: number;
  recordedAt: string;
  entries: RegistryEntry[];
  supersedes?: number;
}

export class RegistryDLPError extends Error {
  attributeName: string;
  constructor(attributeName: string) {
    super(
      `Attribute "${attributeName}" is classified card-data-prohibited; ` +
        `rejected at registry write time (constitutional crypto floor, §4.5).`
    );
    this.name = 'RegistryDLPError';
    this.attributeName = attributeName;
  }
}

export function validateEntityType(def: EntityTypeDef): void {
  for (const [name, attr] of Object.entries(def.attributes)) {
    if (attr.classification === 'card-data-prohibited') {
      throw new RegistryDLPError(name);
    }
  }
}

export function isCurrent(entry: Bitemporal, at?: string): boolean {
  const now = at ?? new Date().toISOString();
  return entry.validFrom <= now && (entry.validTo === null || entry.validTo > now);
}
