// @aether/service-ecr-universe — the ZERO-EXCEPTION proof (Doctrine 1: ECR
// Derivation, no exemptions). Payment gateway, Geo, GID, Billing, SEO,
// Logistics, Tax, Audits — every domain — is composed from the SAME five
// kernel primitives: Entity, Context, Temporal (bitemporal), Relationship,
// Behavior (rule/policy). This service loads DOMAIN PACKS as registry epochs
// (entity types + relationship types + rules + policies are entries), stores
// domain state as EntityInstance/RelationshipInstance data, and answers every
// domain question with the GENERIC kernel engines only:
//   - Registry (epoch-managed types, point-in-time type resolution)
//   - EntityStore (bitemporal instances + relationship traversal)
//   - ContextResolver (scope precedence)
//   - RuleEngine (decision tables)
// There is no domain-specific branch anywhere. A new domain, market, gateway,
// carrier, vendor, or tax regime = a new pack epoch. Zero code. Zero gaps.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';
import {
  type EntityTypeDef,
  type RelationshipTypeDef,
  type RuleDef,
  type PolicyDef,
  type EntityInstance,
  type RelationshipInstance,
  type RegistryEntry,
  type ContextFrame,
  isCurrent,
} from '@aether/kernel-primitives';
import { Registry, EntityStore } from '@aether/kernel-registry';
import { ContextResolver } from '@aether/kernel-context';
import { RuleEngine, ruleDefToEvaluatable, type RuleMatch } from '@aether/kernel-runtime';

// ---------- pack shape (the pack IS registry entries + instance data) ----------
export interface EcrUniversePack {
  pack: { name: string };
  domains: string[];
  entityTypes: EntityTypeDef[];
  relationshipTypes: RelationshipTypeDef[];
  rules: RuleDef[];
  policies: PolicyDef[];
  contextScopes: Array<{
    key: string;
    tiers: Array<{ scope: ContextFrame; value: Record<string, unknown> }>;
  }>;
  instances: Array<EntityInstance & { validTo?: string | null }>;
  relationshipInstances: Array<RelationshipInstance>;
  zoneFactory?: { templateTypeId: string; defaults: Record<string, unknown> };
  pspFactory?: { templateTypeId: string; defaults: Record<string, unknown> };
}

export interface DomainSummary {
  domain: string;
  entityTypes: string[];
  relationshipTypes: string[];
  rules: string[];
  policies: string[];
  instances: number;
  relationships: number;
}

export class EcrUniverseService {
  private pack: EcrUniversePack;
  private registry = new Registry();
  private store = new EntityStore();
  private loadedInstances: EntityInstance[] = [];
  private context: ContextResolver;
  private rules: RuleEngine;
  private ruleDefs: RuleDef[] = [];

  constructor(pack: EcrUniversePack) {
    this.pack = pack;
    // 1. TEMPORAL: publish the entire domain ontology as ONE registry epoch
    const entries: RegistryEntry[] = [
      ...pack.entityTypes,
      ...pack.relationshipTypes,
      ...pack.rules,
      ...pack.policies,
    ];
    this.registry.publishEpoch(entries);
    // 2. ENTITY + RELATIONSHIP: domain state as instances
    for (const inst of pack.instances) this.store.create(inst as EntityInstance);
    for (const rel of pack.relationshipInstances)
      this.store.relate({ ...rel, validTo: rel.validTo ?? null });
    // 3. CONTEXT: scope-precedent tiers as contextual entries (value.name = key)
    this.context = new ContextResolver(
      pack.contextScopes.flatMap((cs) =>
        cs.tiers.map((t) => ({
          id: `ctx-${cs.key}-${t.scope.market ?? 'any'}`,
          scope: { tenant: null, market: t.scope.market ?? null },
          value: { name: cs.key, ...t.value },
          validFrom: '2026-01-01T00:00:00Z',
          validTo: null,
          recordedAt: '2026-01-01T00:00:00Z',
        }))
      )
    );
    // 4. BEHAVIOR: decision-table rules via the kernel's own converter
    this.ruleDefs = [...pack.rules];
    this.rules = new RuleEngine(this.ruleDefs.map(ruleDefToEvaluatable));
  }

  /** register another domain pack at runtime: a NEW EPOCH + LIVE rules, never code */
  loadDomain(entries: RegistryEntry[], instances: EntityInstance[], relationships: RelationshipInstance[]): number {
    const epoch = this.registry.publishEpoch(entries);
    this.loadedInstances.push(...instances);
    for (const i of instances) this.store.create(i);
    for (const r of relationships) this.store.relate({ ...r, validTo: r.validTo ?? null });
    // rules arriving in the epoch go LIVE immediately (behavior is data)
    const newRules = entries.filter((e): e is RuleDef => e.kind === 'rule');
    if (newRules.length > 0) {
      this.ruleDefs.push(...newRules);
      this.rules = new RuleEngine(this.ruleDefs.map(ruleDefToEvaluatable));
    }
    return epoch;
  }

  /** ENTITY + TEMPORAL: point-in-time entity projection (what did X look like at T?) */
  entityAt(id: string, at: string): EntityInstance | undefined {
    return this.store.get(id, at);
  }

  /** RELATIONSHIP: declare a relationship between any two entities (config data) */
  relate(rel: Omit<RelationshipInstance, 'id'> & { id?: string }): string {
    const id = rel.id ?? `rel-${Math.random().toString(36).slice(2, 10)}`;
    this.store.relate({
      id,
      typeId: rel.typeId,
      fromId: rel.fromId,
      toId: rel.toId,
      epoch: rel.epoch,
      validFrom: rel.validFrom,
      validTo: rel.validTo ?? null,
      recordedAt: rel.recordedAt,
    });
    return id;
  }

  /** RELATIONSHIP traversal: outgoing edges from an entity (optionally of a type) */
  traverse(fromId: string, at?: string, typeId?: string): Array<{ typeId: string; toId: string; to?: EntityInstance }> {
    return this.store
      .outgoing(fromId)
      .filter((r) => (typeId ? r.typeId === typeId : true))
      .map((r) => ({ typeId: r.typeId, toId: r.toId, to: this.store.get(r.toId, at) }));
  }

  /** CONTEXT: resolve a scoped value by precedence — market-scoped tier first, then platform default */
  resolveContext(key: string, frame: ContextFrame): Record<string, unknown> | undefined {
    const scoped = this.context.pick(frame, key as never);
    if (scoped) return scoped.value as Record<string, unknown>;
    // platform-default tier (marketless frame) — explicit fallback, never invented
    if (frame.market !== undefined && frame.market !== null) {
      const base = this.context.pick({ ...frame, market: null }, key as never);
      if (base) return base.value as Record<string, unknown>;
    }
    return undefined;
  }

  /** BEHAVIOR: evaluate decision-table rules at a point in time */
  evaluateRule(fact: Record<string, unknown>, at: string): RuleMatch[] {
    return this.rules.evaluateAll(fact, at);
  }

  /** factories: entities from TEMPLATES (config-driven generation, not enumeration) */
  instantiateFromFactory(factory: 'zoneFactory' | 'pspFactory', id: string, attributes: Record<string, unknown>): EntityInstance {
    const f = this.pack[factory];
    if (!f) throw new Error(`factory ${factory} not in pack — factories are pack data`);
    const inst: EntityInstance = {
      id,
      typeId: f.templateTypeId,
      attributes: { ...f.defaults, ...attributes },
      epoch: this.registry.epoch,
      validFrom: new Date().toISOString(),
      validTo: null,
      recordedAt: new Date().toISOString(),
    };
    return this.store.create(inst);
  }

  /** per-domain proof summary: what each named domain projects onto */
  domainSummary(domain: string): DomainSummary {
    if (!this.pack.domains.includes(domain)) {
      throw new Error(`domain '${domain}' not in pack — add a pack epoch, never code`);
    }
    return {
      domain,
      entityTypes: this.pack.entityTypes.filter((e) => e.name.toLowerCase().includes(domainWord(domain))).map((e) => e.id),
      relationshipTypes: this.pack.relationshipTypes.map((r) => r.id),
      rules: this.pack.rules.map((r) => r.id),
      policies: this.pack.policies.map((p) => p.id),
      instances: this.pack.instances.length,
      relationships: this.pack.relationshipInstances.length,
    };
  }

  /** TEMPORAL invariant exposure: every current entity across the universe (incl. loaded domains) */
  private allInstances(): EntityInstance[] {
    return [...this.pack.instances, ...this.loadedInstances];
  }

  currentEntities(at: string): EntityInstance[] {
    return this.allInstances().filter((i) => isCurrent(i as never, at));
  }
}

function domainWord(domain: string): string {
  // payments→psp/payment, geo→zone/geo, gid→identity, billing→billable,
  // seo→seo, logistics→carrier/ship, tax→tax, audits→audit
  const map: Record<string, string> = {
    payments: 'psp',
    geo: 'geo',
    gid: 'identity',
    billing: 'billable',
    seo: 'seo',
    logistics: 'carrier',
    tax: 'tax',
    audits: 'audit',
  };
  return (map[domain] ?? domain).toLowerCase();
}

// ---------- Module-as-a-Product contract ----------
const ecrUniverseModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as EcrUniversePack;
    const svc = new EcrUniverseService(pack);
    return {
      loadDomain: (e: RegistryEntry[], i: EntityInstance[], r: RelationshipInstance[]) => (billing.meter('ecr.domain.loaded', 1), svc.loadDomain(e, i, r)),
      entityAt: (id: string, at: string) => (billing.meter('ecr.entity.reconstructed', 1), svc.entityAt(id, at)),
      relate: (r: Parameters<typeof svc.relate>[0]) => svc.relate(r),
      traverse: (from: string, at?: string, typeId?: string) => (billing.meter('ecr.relationship.traversed', 1), svc.traverse(from, at, typeId)),
      resolveContext: (key: string, frame: ContextFrame) => svc.resolveContext(key, frame),
      evaluateRule: (fact: Record<string, unknown>, at: string) => svc.evaluateRule(fact, at),
      domainSummary: (d: string) => svc.domainSummary(d),
      currentEntities: (at: string) => svc.currentEntities(at),
      instantiateFromFactory: (f: 'zoneFactory' | 'pspFactory', id: string, attrs: Record<string, unknown>) => svc.instantiateFromFactory(f, id, attrs),
      __raw: svc,
    };
  },
};

export default ecrUniverseModule;
