// @aether/service-residency — data-plane residency enforcement (P2-MKT-002).
// Module-as-a-Product: cells, market→cell routing, enforcement policies are
// PACK DATA. The invariant: a tenant-market's data writes are REFUSED outside
// its residency cell (GDPR/DPDP/LGPD/PDPA sovereignty). Cells wrap any
// conformance-admitted StorageEngine — one engine instance per cell.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface ResidencyCell {
  id: string;
  region: string;
  sovereignty: string;
  allowedMarkets: string[];
}

export interface ResidencyPack {
  pack: { name: string };
  cells: ResidencyCell[];
  policies: { enforcement: string; crossCellReadsAllowed: boolean; auditTrail: boolean; fallbackCell: string | null };
}

export class ResidencyViolationError extends Error {
  tenantId: string;
  marketId: string;
  attemptedCell: string;
  requiredCell: string;
  constructor(tenantId: string, marketId: string, attemptedCell: string, requiredCell: string) {
    super(
      `ResidencyViolation: tenant=${tenantId} market=${marketId} data must stay in cell "${requiredCell}" (sovereignty) — write to "${attemptedCell}" refused`
    );
    this.name = 'ResidencyViolationError';
    this.tenantId = tenantId;
    this.marketId = marketId;
    this.attemptedCell = attemptedCell;
    this.requiredCell = requiredCell;
  }
}

/** engine-per-cell factory: the host supplies a StorageEngine per cell id */
export type CellEngineFactory = (cellId: string) => { put(key: string, value: unknown): void; get(key: string): unknown; keys(): string[] };

export class ResidencyService {
  private pack: ResidencyPack;
  private cellForMarket = new Map<string, string>();
  private engines: CellEngineFactory | null = null;
  private audit: Array<{ at: string; tenantId: string; marketId: string; cell: string; op: 'read' | 'write'; result: 'allowed' | 'refused' }> = [];

  constructor(pack: ResidencyPack) {
    this.pack = pack;
    for (const c of pack.cells) {
      for (const m of c.allowedMarkets) this.cellForMarket.set(m, c.id);
    }
  }

  bindEngines(factory: CellEngineFactory): void {
    this.engines = factory;
  }

  cellFor(marketId: string): string {
    const cell = this.cellForMarket.get(marketId);
    if (!cell) throw new Error(`No residency cell mapped for market "${marketId}" — add to residency pack`);
    return cell;
  }

  cellDescriptor(cellId: string): ResidencyCell {
    const c = this.pack.cells.find((x) => x.id === cellId);
    if (!c) throw new Error(`Unknown residency cell "${cellId}"`);
    return c;
  }

  /** enforced write: tenant-market data MUST land in its own cell */
  write(tenantId: string, marketId: string, key: string, value: unknown): void {
    const required = this.cellFor(marketId);
    if (!this.engines) throw new Error('No cell engines bound — bindEngines(factory) first');
    const result: 'allowed' | 'refused' = 'allowed';
    const engine = this.engines(required);
    engine.put(`${tenantId}:${key}`, value);
    if (this.pack.policies.auditTrail) {
      this.audit.push({ at: new Date().toISOString(), tenantId, marketId, cell: required, op: 'write', result });
    }
  }

  /** enforcement probe: attempting to write market data into the WRONG cell */
  attemptWriteTo(tenantId: string, marketId: string, wrongCell: string, key: string, value: unknown): void {
    const required = this.cellFor(marketId);
    if (wrongCell !== required) {
      if (this.pack.policies.auditTrail) {
        this.audit.push({ at: new Date().toISOString(), tenantId, marketId, cell: wrongCell, op: 'write', result: 'refused' });
      }
      if (this.pack.policies.enforcement === 'hard-fail') {
        throw new ResidencyViolationError(tenantId, marketId, wrongCell, required);
      }
      return;
    }
    this.write(tenantId, marketId, key, value);
  }

  /** enforced read: reads served only from the market's own cell */
  read(tenantId: string, marketId: string, key: string): unknown {
    const required = this.cellFor(marketId);
    if (!this.engines) throw new Error('No cell engines bound');
    const engine = this.engines(required);
    const value = engine.get(`${tenantId}:${key}`);
    if (this.pack.policies.auditTrail) {
      this.audit.push({ at: new Date().toISOString(), tenantId, marketId, cell: required, op: 'read', result: 'allowed' });
    }
    return value;
  }

  /** DSR erasure: crypto-shredding hook per cell (delete tenant keys from the cell) */
  eraseTenant(tenantId: string, marketId: string): { erased: number } {
    const required = this.cellFor(marketId);
    if (!this.engines) throw new Error('No cell engines bound');
    const engine = this.engines(required);
    let erased = 0;
    for (const k of engine.keys()) {
      if (k.startsWith(`${tenantId}:`)) {
        engine.put(k, undefined); // cell engines implement delete-as-undefined in dev; real engines tombstone
        erased++;
      }
    }
    return { erased };
  }

  auditTrail(): Array<{ at: string; tenantId: string; marketId: string; cell: string; op: string; result: string }> {
    return [...this.audit];
  }
}

const residencyModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as ResidencyPack;
    const svc = new ResidencyService(pack);
    const meter = (ev: string) => billing.meter(ev);
    return {
      bindEngines: (f: CellEngineFactory) => svc.bindEngines(f),
      cellFor: (m: string) => svc.cellFor(m),
      write: (t: string, m: string, k: string, v: unknown) => (meter('residency.write'), svc.write(t, m, k, v)),
      attemptWriteTo: (t: string, m: string, c: string, k: string, v: unknown) => svc.attemptWriteTo(t, m, c, k, v),
      read: (t: string, m: string, k: string) => (meter('residency.read'), svc.read(t, m, k)),
      eraseTenant: (t: string, m: string) => (meter('residency.erasure'), svc.eraseTenant(t, m)),
      auditTrail: () => svc.auditTrail(),
      __raw: svc,
    };
  },
};

export default residencyModule;
