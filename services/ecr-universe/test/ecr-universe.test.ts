// Tests: ECR Universe — the ZERO-EXCEPTION proof (Doctrine 1).
// Payments, Geo, GID, Billing, SEO, Logistics, Tax, Audits — every domain is
// answered by the SAME generic kernel engines (Registry/EntityStore/Context/
// RuleEngine). No domain-specific branches exist anywhere in the service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EcrUniverseService, type EcrUniversePack } from '../src/index.ts';
import type { EntityTypeDef, RuleDef } from '@aether/kernel-primitives';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/ecr-universe-core.json'), 'utf8')) as EcrUniversePack;
const svc = new EcrUniverseService(pack);

test('ALL eight domains project onto the same five primitives — no exception, no partial', () => {
  for (const domain of pack.domains) {
    const s = svc.domainSummary(domain);
    assert.ok(s.entityTypes.length >= 1, `${domain} must have entity types`);
    assert.ok(s.relationshipTypes.length >= 1, `${domain} relationships exist in the shared graph`);
    assert.ok(s.rules.length >= 1 || s.policies.length >= 1, `${domain} has behavior (rules or policies)`);
    assert.ok(s.instances >= 1, `${domain} has entity instances`);
  }
  // the whole universe is ONE graph — relationships cross domains freely:
  // seo surface —served-by→ geo zone —taxed-under→ jurisdiction —ships-via→ carrier
  const chain = svc.traverse('seo_sitemap_surface', '2026-06-01T00:00:00Z');
  assert.ok(chain.length >= 1);
  const zone = chain[0]!.to!;
  assert.equal(zone.typeId, 'et_geo_zone');
  const tax = svc.traverse(zone.id, '2026-06-01T00:00:00Z', 'rt_taxed_under');
  assert.equal(tax[0]!.to!.attributes['regime'], 'vat-inclusive');
  const ship = svc.traverse(zone.id, '2026-06-01T00:00:00Z', 'rt_ships_via');
  assert.equal(ship[0]!.to!.attributes['carrierClass'], 'dhl-class');
});

test('PAYMENTS as E×C×T×R: PSP routing is a decision-table rule evaluated at time T', () => {
  // default routing
  const byMarket = svc.evaluateRule({ fact: 'psp-route', market: 'BR', rail: 'cards' }, '2026-06-01T00:00:00Z');
  assert.equal(byMarket[0]!.outputs['psp'], 'psp-stripe-class');
  // higher-priority local-rail rule wins (UPI in India)
  const upi = svc.evaluateRule({ fact: 'psp-route', market: 'IN', rail: 'upi' }, '2026-06-01T00:00:00Z');
  assert.equal(upi[0]!.outputs['psp'], 'psp-upi-adapter');
  assert.equal(upi[0]!.ruleName, 'psp-route-upi');
  // SAQ-A constitutional floor is a POLICY (platform-scope registry entry)
  assert.ok(pack.policies.some((p) => p.name === 'saq-a-floor'));
  // PSPs are ENTITIES with temporal validity
  const psp = svc.entityAt('psp-upi-adapter', '2026-06-01T00:00:00Z');
  assert.ok((psp!.attributes['markets'] as string[]).includes('IN'));
});

test('GEO as E×C×T×R: zones are entities; context precedence picks EU override over platform default', () => {
  const eu = svc.resolveContext('geo.zone.resolution', { market: 'EU' });
  assert.equal(eu!['priority'], 90); // market-scoped tier
  const fallback = svc.resolveContext('geo.zone.resolution', { market: 'JP' });
  assert.equal(fallback!['priority'], 10); // platform tier
});

test('GID as E×C×T×R: identity aliases are relationship instances (alias-of)', () => {
  const aliases = svc.traverse('id_shopper_001', '2026-06-01T00:00:00Z', 'rt_alias_of');
  assert.ok(aliases.length >= 1);
  assert.equal(aliases[0]!.typeId, 'rt_alias_of');
});

test('BILLING + AUDITS as E×C×T×R: metered resource evidenced by audit events via relationships', () => {
  const fee = svc.entityAt('billable_order_fee', '2026-06-01T00:00:00Z');
  assert.equal(fee!.attributes['meterEvent'], 'order.placed');
  const evidence = svc.traverse('audit_0001', '2026-06-01T00:00:00Z', 'rt_evidences');
  assert.equal(evidence[0]!.toId, 'billable_order_fee');
});

test('TEMPORAL zero-gap: point-in-time reconstruction — entity valid windows honored exactly', () => {
  // supersede the EU VAT rate by a NEW instance with later validity (amendment, never mutation)
  const epoch = svc.loadDomain(
    [],
    [
      {
        id: 'jurisdiction_eu_vat',
        typeId: 'et_tax_jurisdiction',
        attributes: { regime: 'vat-inclusive', rate: 0.22 }, // raised 22%
        epoch: 99,
        validFrom: '2026-09-01T00:00:00Z',
        validTo: null,
        recordedAt: '2026-08-20T00:00:00Z',
      },
    ],
    []
  );
  assert.equal(epoch, 2); // a NEW registry epoch — temporal law
  // historical T before the change: 20% (bitemporal reconstruction)
  const before = svc.currentEntities('2026-06-01T00:00:00Z');
  const oldRate = before.find((e) => e.id === 'jurisdiction_eu_vat')!;
  assert.equal(oldRate.attributes['rate'], 0.2);
  // after the change: 22%
  const after = svc.currentEntities('2026-09-02T00:00:00Z');
  const newRate = after.filter((e) => e.id === 'jurisdiction_eu_vat');
  assert.ok(newRate.some((e) => e.attributes['rate'] === 0.22));
});

test('INFINITE extensibility: a NEW domain/market/vendor arrives as a pack epoch — zero code', () => {
  // e.g. a brand-new domain: 'carbon-offsets' or market 'XX' — just registry entries
  const newType: EntityTypeDef = {
    id: 'et_carbon_offset',
    kind: 'entity-type',
    name: 'CarbonOffset',
    extends: 'Entity',
    attributes: {
      market: { type: 'string', classification: 'internal', required: true },
      tonnes: { type: 'number', classification: 'internal', required: true },
    },
    epoch: 2,
    validFrom: '2026-09-01T00:00:00Z',
    validTo: null,
    recordedAt: '2026-08-20T00:00:00Z',
  };
  const newRule: RuleDef = {
    id: 'rule_carbon_market_eligible',
    kind: 'rule',
    name: 'carbon-eligibility',
    priority: 30,
    decisionTable: [
      { field: 'fact', equals: 'carbon-eligible' },
      { field: 'market', in: ['EU', 'XX-NEW'], then: { eligible: true } },
    ],
    epoch: 2,
    validFrom: '2026-09-01T00:00:00Z',
    validTo: null,
    recordedAt: '2026-08-20T00:00:00Z',
  };
  svc.loadDomain([newType, newRule], [], []);
  // market XX-NEW (a market that did not exist this morning) is now live via DATA
  const verdict = svc.evaluateRule({ fact: 'carbon-eligible', market: 'XX-NEW' }, '2026-09-02T00:00:00Z');
  assert.equal(verdict[0]!.outputs['eligible'], true);
  // and a market never added is not (no invented fallback)
  const notAdded = svc.evaluateRule({ fact: 'carbon-eligible', market: 'ZZ-NOTADDED' }, '2026-09-02T00:00:00Z');
  assert.equal(notAdded.length, 0);
});

test('factories: entities generated from pack templates (config, not enumeration)', () => {
  const zone = svc.instantiateFromFactory('zoneFactory', 'zone_factory_made_1', { matchRules: { country: 'JP' }, priority: 77 });
  assert.equal(zone.typeId, 'et_geo_zone');
  assert.equal(zone.attributes['priority'], 77);
  const psp = svc.instantiateFromFactory('pspFactory', 'psp_factory_made_1', { pspClass: 'adyen-class', markets: ['XX-NEW'] });
  assert.equal(psp.attributes['saqACompliant'], true); // factory default applied
});

test('unknown domain rejected with the doctrinal message (data, not code)', () => {
  assert.throws(() => svc.domainSummary('teleportation'), /add a pack epoch, never code/);
});

test('module contract: default export AetherModule, metered projections', async () => {
  const mod = (await import('../src/index.ts')).default;
  assert.equal(mod.manifest.id, 'mod-ecr-universe');
  const events: string[] = [];
  const api = await mod.create(
    { tenantId: () => 't1', storage: () => null, log: () => {} },
    { meter: (e: string) => events.push(e) },
    { 'ecr-universe-core': pack }
  );
  const ent = (api['entityAt'] as (id: string, at: string) => { typeId: string })('psp-stripe-class', '2026-06-01T00:00:00Z');
  assert.equal(ent.typeId, 'et_psp');
  const hops = (api['traverse'] as (f: string, at?: string, t?: string) => unknown[])('zone_eu_vat', '2026-06-01T00:00:00Z');
  assert.ok(hops.length >= 2);
  assert.ok(events.includes('ecr.entity.reconstructed'));
});

test('relate: declare NEW relationships at runtime (config, not enumeration)', () => {
  const svc2 = new EcrUniverseService(pack);
  const relId = svc2.relate({
    typeId: 'rt_ships_via',
    fromId: 'zone_us_west_ecr',
    toId: 'carrier_regional_in',
    epoch: 1,
    validFrom: '2026-01-01T00:00:00Z',
    recordedAt: '2026-01-01T00:00:00Z',
  });
  assert.ok(relId.startsWith('rel-'));
  const hops = svc2.traverse('zone_us_west_ecr', '2026-06-01T00:00:00Z', 'rt_ships_via');
  assert.ok(hops.some((h) => h.toId === 'carrier_regional_in'));
});
