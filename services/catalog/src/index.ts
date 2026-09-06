// @aether/service-catalog — first kernel application (P1-CAT-001).
// Contains NO domain logic of its own: every type, workflow, and rule comes from
// the registry/pack. It wires kernel primitives into a storefront-facing catalog
// service: list, find, offer, buy-box, and context-aware pricing display.
// Tech-agnostic: any conformance-admitted StorageEngine; any ID scheme.

import { Registry } from '@aether/kernel-registry/src/index.ts';
import { ProjectionEngine, type Projection } from '@aether/kernel-projection/src/index.ts';
import { UidAllocator, UDictionary } from '@aether/kernel-uid/src/index.ts';
import { ContextResolver } from '@aether/kernel-context/src/index.ts';
import { RuleEngine } from '@aether/kernel-runtime/src/index.ts';
import { validateEntityType, type EntityTypeDef, type RuleDef } from '@aether/kernel-primitives';
import type { StorageEngine } from '@aether/kernel-storage';

export interface CatalogPack {
  entityTypes: EntityTypeDef[];
  relationshipTypes: unknown[];
  behaviorPacks?: unknown[];
  workflows?: unknown[];
  idSchemes?: Array<Record<string, unknown>>;
  contextualConfig?: Array<{ id: string; scope: Record<string, string | null>; value: Record<string, unknown>; validFrom: string; validTo: string | null; recordedAt: string }>;
  rules?: RuleDef[];
}

export interface OfferInput {
  sellerId: string;
  price: number;
  currency: string;
  condition?: string;
  fulfillmentMode?: string;
}

export interface ResolvedOffer {
  offerId: string;
  sellerId: string;
  price: number;
  currency: string;
  buyBoxWinner: boolean;
  explain: string[];
}

export class CatalogService {
  private registry = new Registry();
  private projections = new Map<string, Projection>();
  private uid = new UidAllocator();
  private dict = new UDictionary();
  private resolver: ContextResolver;
  private rules: RuleEngine;
  private productProjection?: Projection;
  private offerProjection?: Projection;

  private engine: StorageEngine;
  private idScheme: string;
  private offerScheme: string;

  constructor(
    engine: StorageEngine,
    pack: CatalogPack,
    idScheme = 'reference-uuidv7',
    offerScheme = 'prefixed-ulid'
  ) {
    this.engine = engine;
    this.idScheme = idScheme;
    this.offerScheme = offerScheme;
    for (const s of pack.idSchemes ?? []) this.uid.registerScheme(s as never);
    this.registry.publishEpoch([...pack.entityTypes, ...(pack.rules ?? [])]);
    this.rules = new RuleEngine(
      (pack.rules ?? []).map((r) => ({
        id: r.id, name: r.name, priority: r.priority,
        when: r.decisionTable.filter((row) => 'field' in row) as never,
        then: (r.decisionTable.find((row) => 'then' in row) as { then?: Record<string, unknown> })?.then ?? {},
        validFrom: r.validFrom, validTo: r.validTo, recordedAt: r.recordedAt,
      }))
    );
    this.resolver = new ContextResolver(pack.contextualConfig ?? []);
    const pe = new ProjectionEngine(engine);
    const productType = pack.entityTypes.find((t) => t.name === 'Product' || t.name === 'Apparel' || t.extends === null);
    const offerType = pack.entityTypes.find((t) => t.name === 'Offer');
    if (productType) this.productProjection = pe.apply(productType);
    if (offerType) this.offerProjection = pe.apply(offerType);
  }

  get epoch(): number {
    return this.registry.epoch;
  }

  async createProduct(
    tenantId: string,
    attrs: Record<string, unknown>,
    aliases: string[] = []
  ): Promise<{ id: string }> {
    if (!this.productProjection) throw new Error('Product entity type missing from pack');
    const id = this.uid.allocate(this.idScheme, 'Product').value;
    const pe = new ProjectionEngine(this.engine);
    await pe.instantiate(this.productProjection, attrs, { id, tenantId, epoch: this.registry.epoch });
    this.dict.register(id, id, 'Product', this.registry.epoch);
    for (const alias of aliases) this.dict.alias(alias, id);
    return { id };
  }

  async addOffer(tenantId: string, productId: string, input: OfferInput): Promise<ResolvedOffer> {
    if (!this.offerProjection) throw new Error('Offer entity type missing from pack');
    const offerId = this.uid.allocate(this.offerScheme, 'Offer', { Offer: 'off' }).value;
    const pe = new ProjectionEngine(this.engine);
    await pe.instantiate(
      this.offerProjection,
      { productId, sellerId: input.sellerId, price: input.price, currency: input.currency, condition: input.condition ?? 'new', fulfillmentMode: input.fulfillmentMode ?? 'seller-fulfilled' },
      { id: offerId, tenantId, epoch: this.registry.epoch }
    );
    return {
      offerId,
      sellerId: input.sellerId,
      price: input.price,
      currency: input.currency,
      buyBoxWinner: false,
      explain: [],
    };
  }

  /** buy-box: rule-driven winner across offers (rules are pack data) */
  async buyBox(tenantId: string, productId: string, frame?: { market?: string | null }): Promise<ResolvedOffer | undefined> {
    const offers = await this.listOffers(tenantId, productId);
    if (offers.length === 0) return undefined;
    const sorted = [...offers].sort((a, b) => a.price - b.price);
    let winner = sorted[0]!;
    const explain = [`lowest-price default`];
    for (const offer of offers) {
      const hits = this.rules.evaluateAll({
        fact: 'buybox',
        productId,
        offerId: offer.offerId,
        sellerId: offer.sellerId,
        price: offer.price,
        fulfillmentMode: offer.fulfillmentMode,
        market: frame?.market ?? null,
      });
      for (const h of hits) {
        if (h.outputs['prefer-seller'] === true) {
          winner = offer;
          explain.length = 0;
          explain.push(`rule ${h.ruleName} prefers seller ${offer.sellerId}`);
        }
      }
    }
    return { ...winner, buyBoxWinner: true, explain };
  }

  async listOffers(tenantId: string, productId: string): Promise<Array<ResolvedOffer & { fulfillmentMode: string }>> {
    const all = await this.engine.query({ tenantId, typeId: this.offerProjection?.entityTypeDef.id });
    return all
      .filter((r) => r.attributes.productId === productId)
      .map((r) => ({
        offerId: r.id,
        sellerId: String(r.attributes.sellerId),
        price: Number(r.attributes.price),
        currency: String(r.attributes.currency),
        fulfillmentMode: String(r.attributes.fulfillmentMode ?? 'seller-fulfilled'),
        buyBoxWinner: false,
        explain: [],
      }));
  }

  /** context-aware display (market price display, tax mode, etc. from contextualConfig) */
  displayConfig(frame: { tenant?: string | null; market?: string | null }): Record<string, unknown> | undefined {
    return this.resolver.pick(frame, 'price-display')?.value;
  }
}
