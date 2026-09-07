// @aether/service-market-registry — Market-as-Data (§3.2b, P2-MKT-001).
// Module-as-a-Product: every market is ONE pack entry — currencies, locales,
// tax regime descriptors, payment rails, compliance refs, capability flags,
// residency cells, consumer-law windows. Tenant×market activation matrix.
// Onboarding a new market = append to the pack. ZERO CODE.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface MarketEntry {
  id: string;
  displayName: string;
  locales: string[];
  currency: string;
  taxRegime: { kind: string; display: string; facilitatorLiable: boolean; adapter: string; eInvoicing?: string };
  paymentRails: string[];
  compliancePacks: string[];
  capabilities: Record<string, boolean>;
  residency: { dataResidency: string; sovereignty: string };
  consumerLaw: { returnWindowDays: number; withdrawalRight?: boolean };
  idDocumentSchemes: string[];
}

export interface TenantActivation {
  tenantId: string;
  marketId: string;
  status: string;
}

export interface MarketsPack {
  pack: { name: string };
  markets: MarketEntry[];
  tenantActivations: TenantActivation[];
}

export interface ResolvedMarket {
  market: MarketEntry;
  /** effective consumer law: max(platform floor 14 for withdrawal markets is NOT a floor — market's own law applies) */
  returnWindowDays: number;
  eInvoicing: string | null;
  facilitatorLiable: boolean;
  taxDisplay: 'inclusive' | 'exclusive';
  residency: string;
}

export class MarketRegistryService {
  private markets = new Map<string, MarketEntry>();
  private activations: TenantActivation[] = [];

  constructor(pack?: MarketsPack) {
    if (pack) this.loadPack(pack);
    else {
      const here = dirname(fileURLToPath(import.meta.url));
      this.loadPack(JSON.parse(readFileSync(join(here, '../packs/markets.json'), 'utf8')) as MarketsPack);
    }
  }

  loadPack(pack: MarketsPack): void {
    for (const m of pack.markets) this.markets.set(m.id, m);
    this.activations.push(...(pack.tenantActivations ?? []));
  }

  /** register a NEW market at runtime — the config-only onboarding path */
  registerMarket(entry: MarketEntry): void {
    if (this.markets.has(entry.id)) throw new Error(`Market "${entry.id}" already registered`);
    this.validateMarket(entry);
    this.markets.set(entry.id, entry);
  }

  /** market validation: required descriptor fields (constitution-grade schema) */
  private validateMarket(m: MarketEntry): void {
    const required = ['id', 'displayName', 'locales', 'currency', 'taxRegime', 'paymentRails', 'compliancePacks', 'capabilities', 'residency', 'consumerLaw'] as const;
    for (const f of required) {
      if ((m as unknown as Record<string, unknown>)[f] === undefined) {
        throw new Error(`Market descriptor missing "${f}" — markets are validated config (§3.2b)`);
      }
    }
    if (m.locales.length === 0) throw new Error(`${m.id}: at least one locale required`);
    if (m.paymentRails.length === 0) throw new Error(`${m.id}: at least one payment rail required`);
  }

  get(marketId: string): MarketEntry {
    const m = this.markets.get(marketId);
    if (!m) throw new Error(`Unknown market "${marketId}" — register it in the markets pack (Market-as-Data)`);
    return m;
  }

  list(): Array<{ id: string; displayName: string; currency: string }> {
    return [...this.markets.values()].map((m) => ({ id: m.id, displayName: m.displayName, currency: m.currency }));
  }

  /** activate a market for a tenant (activation matrix; bitemporal in production storage) */
  activateMarket(tenantId: string, marketId: string): void {
    this.get(marketId); // must exist
    if (this.activations.some((a) => a.tenantId === tenantId && a.marketId === marketId)) return; // idempotent
    this.activations.push({ tenantId, marketId, status: 'active' });
  }

  deactivateMarket(tenantId: string, marketId: string): void {
    const a = this.activations.find((x) => x.tenantId === tenantId && x.marketId === marketId);
    if (a) a.status = 'inactive';
  }

  activeMarkets(tenantId: string): MarketEntry[] {
    return this.activations
      .filter((a) => a.tenantId === tenantId && a.status === 'active')
      .map((a) => this.get(a.marketId));
  }

  isMarketActiveFor(tenantId: string, marketId: string): boolean {
    return this.activations.some((a) => a.tenantId === tenantId && a.marketId === marketId && a.status === 'active');
  }

  /** resolve the full context-effective market config for a tenant */
  resolve(tenantId: string, marketId: string): ResolvedMarket {
    if (!this.isMarketActiveFor(tenantId, marketId)) {
      throw new Error(`Market "${marketId}" not activated for tenant "${tenantId}" — activation matrix (§3.2b)`);
    }
    const m = this.get(marketId);
    return {
      market: m,
      returnWindowDays: m.consumerLaw.returnWindowDays,
      eInvoicing: m.taxRegime.eInvoicing ?? null,
      facilitatorLiable: m.taxRegime.facilitatorLiable,
      taxDisplay: m.taxRegime.display as 'inclusive' | 'exclusive',
      residency: m.residency.dataResidency,
    };
  }

  /** capability gating: COD only where the market allows it (data, not code) */
  capability(marketId: string, cap: string): boolean {
    return this.get(marketId).capabilities[cap] === true;
  }

  /** residency routing: which cell must hold this tenant-market's data */
  residencyFor(marketId: string): string {
    return this.get(marketId).residency.dataResidency;
  }
}

const marketRegistryModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as MarketsPack;
    const svc = new MarketRegistryService(pack);
    const meter = (ev: string) => billing.meter(ev);
    return {
      registerMarket: (m: MarketEntry) => (meter('market.registered'), svc.registerMarket(m)),
      get: (id: string) => svc.get(id),
      list: () => svc.list(),
      activateMarket: (t: string, m: string) => (meter('market.activated'), svc.activateMarket(t, m)),
      deactivateMarket: (t: string, m: string) => svc.deactivateMarket(t, m),
      activeMarkets: (t: string) => svc.activeMarkets(t),
      isMarketActiveFor: (t: string, m: string) => svc.isMarketActiveFor(t, m),
      resolve: (t: string, m: string) => (meter('market.resolved'), svc.resolve(t, m)),
      capability: (m: string, c: string) => svc.capability(m, c),
      residencyFor: (m: string) => svc.residencyFor(m),
      __raw: svc,
    };
  },
};

export default marketRegistryModule;
