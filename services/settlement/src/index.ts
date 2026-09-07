// @aether/service-settlement — region-pinned ledger writes + cross-region
// settlement + DR promotion (P3-SCL-002, §3.6 locked decision: "tenant
// home-region pinned serializable writes + global settlement service").
// Module-as-a-Product: region pinning patterns, settlement windows, FX spread,
// DR promotion thresholds are ALL PACK DATA. Ledger invariants (sum-to-zero)
// enforced per region; cross-region positions settle through the global
// settlement service with FX conversion.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger } from '@aether/service-checkout/src/index.ts';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface RegionDef {
  id: string;
  role: string;
  tenants: string[]; // glob patterns; '*' = default home
  currency: string;
}

export interface SettlementPack {
  pack: { name: string };
  regions: RegionDef[];
  settlement: {
    window: { periodicity: string; hourUtc: number };
    crossRegion: { mode: string; fxSpreadPct: number };
    dr: { rpoSeconds: number; rtoSeconds: number; promoteAfterPrimaryDownSec: number };
  };
}

export class RegionPinnedError extends Error {
  constructor(tenantId: string, requiredRegion: string, attemptedRegion: string) {
    super(`RegionPinned: tenant "${tenantId}" ledger writes pinned to region "${requiredRegion}" — write to "${attemptedRegion}" refused`);
    this.name = 'RegionPinnedError';
  }
}

export interface DrState {
  regionId: string;
  status: 'primary' | 'secondary' | 'promoted' | 'failed-over';
}

export class SettlementService {
  private pack: SettlementPack;
  private regionLedgers = new Map<string, Ledger>();
  private homeRegion = new Map<string, string>(); // tenantId -> home region
  private crossRegionPositions: Array<{ from: string; to: string; amount: number; currency: string; settled: boolean }> = [];
  private drStates = new Map<string, DrState>();
  private primaryDownSince: Map<string, number> = new Map();

  constructor(pack: SettlementPack) {
    this.pack = pack;
    for (const r of pack.regions) {
      this.regionLedgers.set(r.id, new Ledger());
      this.drStates.set(r.id, { regionId: r.id, status: 'primary' });
    }
  }

  /** resolve tenant home region by pack glob patterns (most-specific first) */
  homeRegionFor(tenantId: string): RegionDef {
    const matches = this.pack.regions.filter((r) =>
      r.tenants.some((pat) => (pat === '*' ? true : new RegExp('^' + pat.replace(/\*/g, '.*') + '$').test(tenantId)))
    );
    // non-wildcard match wins over '*'
    const specific = matches.find((r) => !r.tenants.includes('*'));
    const region = specific ?? matches[0];
    if (!region) throw new Error(`No home region for tenant "${tenantId}" — add pattern to settlement pack`);
    this.homeRegion.set(tenantId, region.id);
    return region;
  }

  /** region-pinned ledger write: tenant's journal posts ONLY in its home region */
  postInRegion(tenantId: string, regionId: string, transactionId: string, lines: Array<{ account: string; debit?: number; credit?: number; memo?: string }>): void {
    const home = this.homeRegionFor(tenantId);
    if (home.id !== regionId) {
      throw new RegionPinnedError(tenantId, home.id, regionId);
    }
    const ledger = this.regionLedgers.get(regionId)!;
    ledger.post(transactionId, lines); // sum-to-zero invariant enforced per region
  }

  /** cross-region transfer: debit home ledger, register settlement position */
  queueCrossRegion(fromRegion: string, toRegion: string, amount: number, currency: string): void {
    if (!this.regionLedgers.has(fromRegion) || !this.regionLedgers.has(toRegion)) {
      throw new Error(`Unknown region in transfer ${fromRegion}→${toRegion}`);
    }
    this.crossRegionPositions.push({ from: fromRegion, to: toRegion, amount, currency, settled: false });
  }

  /** daily settlement window (pack hourUtc): settle positions w/ FX spread */
  runSettlementWindow(atHourUtc: number, fxRateToUsd: Record<string, number>): { settled: number; totalUsd: number } {
    if (atHourUtc !== this.pack.settlement.window.hourUtc) {
      throw new Error(`Settlement window runs at ${this.pack.settlement.window.hourUtc}:00 UTC (pack policy) — not ${atHourUtc}:00`);
    }
    const spread = this.pack.settlement.crossRegion.fxSpreadPct / 100;
    let settled = 0;
    let totalUsd = 0;
    for (const pos of this.crossRegionPositions) {
      if (pos.settled) continue;
      const rate = fxRateToUsd[pos.currency] ?? 1;
      const usd = pos.amount * rate * (1 - spread);
      pos.settled = true;
      settled++;
      totalUsd += usd;
    }
    return { settled, totalUsd: Math.round(totalUsd * 100) / 100 };
  }

  // ---- DR lifecycle (pack thresholds) ----
  reportPrimaryDown(regionId: string, atSec: number): void {
    this.primaryDownSince.set(regionId, atSec);
    const st = this.drStates.get(regionId);
    if (st) st.status = 'failed-over';
  }

  /** promotion check: after promoteAfterPrimaryDownSec, the secondary may promote */
  tryPromote(regionId: string, atSec: number): { promoted: boolean; reason: string } {
    const downSince = this.primaryDownSince.get(regionId);
    if (downSince === undefined) return { promoted: false, reason: 'primary healthy' };
    const downSec = atSec - downSince;
    const threshold = this.pack.settlement.dr.promoteAfterPrimaryDownSec;
    if (downSec < threshold) {
      return { promoted: false, reason: `down ${downSec}s < ${threshold}s promote threshold` };
    }
    const st = this.drStates.get(regionId)!;
    st.status = 'promoted';
    return { promoted: true, reason: `down ${downSec}s ≥ ${threshold}s — promoted` };
  }

  regionDrState(regionId: string): DrState {
    const st = this.drStates.get(regionId);
    if (!st) throw new Error(`Unknown region "${regionId}"`);
    return { ...st };
  }

  regionLedgerInvariant(regionId: string): boolean {
    const ledger = this.regionLedgers.get(regionId);
    if (!ledger) throw new Error(`Unknown region "${regionId}"`);
    return ledger.invariantsHold();
  }

  positions(): Array<{ from: string; to: string; amount: number; currency: string; settled: boolean }> {
    return [...this.crossRegionPositions];
  }
}

const settlementModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as SettlementPack;
    const svc = new SettlementService(pack);
    const meter = (ev: string) => billing.meter(ev);
    return {
      homeRegionFor: (t: string) => svc.homeRegionFor(t),
      postInRegion: (t: string, r: string, tx: string, l: Array<{ account: string; debit?: number; credit?: number }>) => (meter('ledger.posted'), svc.postInRegion(t, r, tx, l)),
      queueCrossRegion: (f: string, to: string, a: number, c: string) => svc.queueCrossRegion(f, to, a, c),
      runSettlementWindow: (h: number, fx: Record<string, number>) => (meter('settlement.window'), svc.runSettlementWindow(h, fx)),
      reportPrimaryDown: (r: string, at: number) => svc.reportPrimaryDown(r, at),
      tryPromote: (r: string, at: number) => (meter('dr.promoted'), svc.tryPromote(r, at)),
      regionDrState: (r: string) => svc.regionDrState(r),
      regionLedgerInvariant: (r: string) => svc.regionLedgerInvariant(r),
      positions: () => svc.positions(),
      __raw: svc,
    };
  },
};

export default settlementModule;
