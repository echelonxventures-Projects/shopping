// @aether/kernel-product-registry — EVERYTHING IS A PRODUCT (Doctrine 5, hard law).
// The platform's own inventory: every module registered in the ModuleRuntime is
// automatically listed in the Product Registry as a SELLABLE product with a
// generated offer, wired to the Monetization Stack (billable resources derive
// from each product's meterableEvents). External hosts may use this registry
// alone (no platform coupling) — it is itself a module.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ProductListing {
  productId: string; // module id
  name: string;
  displayName: string;
  version: string;
  description: string;
  capabilities: string[];
  offer: {
    pricingModel: string;
    suggestedRate?: { amount: number; currency: string; perUnit?: string };
    meterableResources: Array<{ resource: string; unit: string; description: string }>;
  };
  apiSurface: string[];
  bundledPacks: string[];
}

export class ProductRegistry {
  private listings = new Map<string, ProductListing>();

  /** scan a services directory and list EVERY product found (no exceptions) */
  scanDirectory(servicesDir: string): number {
    let n = 0;
    for (const svc of readdirSync(servicesDir)) {
      const svcPath = join(servicesDir, svc);
      if (!statSync(svcPath).isDirectory()) continue;
      const manifestPath = join(svcPath, 'module.json');
      if (!existsSync(manifestPath)) continue; // product-conformance lint catches stragglers
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
      this.listings.set(m.id, {
        productId: m.id,
        name: m.name,
        displayName: m.displayName,
        version: m.version,
        description: m.description,
        capabilities: m.capabilities,
        offer: {
          pricingModel: m.billing.pricingModel,
          suggestedRate: m.billing.suggestedRate,
          meterableResources: m.billing.meterableEvents.map((e: { event: string; unit: string; description: string }) => ({
            resource: e.event.replace(/\./g, '_'),
            unit: e.unit,
            description: e.description,
          })),
        },
        apiSurface: m.publicApi,
        bundledPacks: m.packs,
      });
      n++;
    }
    return n;
  }

  list(): ProductListing[] {
    return [...this.listings.values()];
  }

  get(productId: string): ProductListing {
    const p = this.listings.get(productId);
    if (!p) throw new Error(`Unknown product "${productId}" — every product must be registered`);
    return p;
  }

  /** Monetization Stack wiring: a tenant subscribing to a product generates the
      rate-plan line + billable resources — the platform buys its own products. */
  monetizationSyncPayload(): {
    billableResources: Array<{ id: string; name: string; unit: string; meterEvent: string }>;
    productOffers: Array<{ id: string; displayName: string; pricingModel: string; suggestedRate?: { amount: number; currency: string; perUnit?: string } }>;
  } {
    const resources = new Map<string, { id: string; name: string; unit: string; meterEvent: string }>();
    for (const p of this.listings.values()) {
      for (const r of p.offer.meterableResources) {
        resources.set(r.resource, {
          id: `res_${r.resource}`,
          name: r.resource,
          unit: r.unit,
          meterEvent: r.resource,
        });
      }
    }
    return {
      billableResources: [...resources.values()],
      productOffers: [...this.listings.values()].map((p) => ({
        id: p.productId,
        displayName: p.displayName,
        pricingModel: p.offer.pricingModel,
        suggestedRate: p.offer.suggestedRate,
      })),
    };
  }
}

const here = dirname(fileURLToPath(import.meta.url));
export const defaultServicesDir = join(here, '../../../services');
