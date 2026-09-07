// @aether/service-consent-dsr — purpose-based consent + Data-Subject-Rights
// engine (P2-MKT-003). Module-as-a-Product: purposes, regulation SLAs, lawful
// bases, erasure exemptions, retention windows are ALL PACK DATA. Wires to the
// residency module for cell-scoped erasure. Adding a regulation = pack entry.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface Purpose {
  id: string;
  requireConsent: boolean;
  description: string;
}

export interface Regulation {
  id: string;
  appliesTo: string[]; // market ids
  dsrSlaDays: Record<string, number>;
  lawfulBases: string[];
  erasureExemptions: string[];
  rightTo: string[];
}

export interface RetentionRule {
  dataClass: string;
  retainDays: number;
  basis: string;
  survivesErasure: boolean;
}

export interface ConsentDsrPack {
  pack: { name: string };
  purposes: Purpose[];
  regulations: Regulation[];
  retention: RetentionRule[];
}

export interface ConsentRecord {
  tenantId: string;
  subjectId: string;
  purpose: string;
  granted: boolean;
  market: string;
  at: string;
}

export interface DsrRequest {
  dsrId: string;
  tenantId: string;
  subjectId: string;
  market: string;
  right: string; // access | erasure | portability | rectification | object-profiling | opt-out-sale
  status: 'received' | 'in-progress' | 'completed' | 'rejected';
  receivedAt: string;
  dueAt: string;
  completedAt?: string;
  outcome?: string;
  dataExport?: Record<string, unknown>; // access/portability payload
}

export class ConsentService {
  private pack: ConsentDsrPack;
  private consents = new Map<string, ConsentRecord>(); // key: tenant:subject:purpose
  private dsrs: DsrRequest[] = [];
  private dataStore = new Map<string, Map<string, Record<string, unknown>>>(); // tenant → subject → data classes
  private seq = 0;

  constructor(pack: ConsentDsrPack) {
    this.pack = pack;
  }

  regulationFor(market: string): Regulation {
    const reg = this.pack.regulations.find((r) => r.appliesTo.includes(market));
    if (!reg) throw new Error(`No privacy regulation mapped for market "${market}" — add to consent-dsr pack`);
    return reg;
  }

  purposeOf(purposeId: string): Purpose {
    const p = this.pack.purposes.find((x) => x.id === purposeId);
    if (!p) throw new Error(`Unknown consent purpose "${purposeId}" — register in pack`);
    return p;
  }

  /** grant/deny consent per purpose (essential purposes need no consent — always granted) */
  setConsent(tenantId: string, subjectId: string, purpose: string, granted: boolean, market: string): ConsentRecord {
    const p = this.purposeOf(purpose);
    if (!p.requireConsent && !granted) {
      throw new Error(`Purpose "${purpose}" is essential — consent cannot be withheld`);
    }
    const rec: ConsentRecord = { tenantId, subjectId, purpose, granted: p.requireConsent ? granted : true, market, at: new Date().toISOString() };
    this.consents.set(`${tenantId}:${subjectId}:${purpose}`, rec);
    return rec;
  }

  /** the runtime gate every consumer of personal data MUST call (Doctrine: consent-gated) */
  hasConsent(tenantId: string, subjectId: string, purpose: string): boolean {
    const p = this.purposeOf(purpose);
    if (!p.requireConsent) return true; // essential purposes always allowed
    return this.consents.get(`${tenantId}:${subjectId}:${purpose}`)?.granted === true;
  }

  /** store a subject's data class (simulates the data plane; retention policy applies on read) */
  storeData(tenantId: string, subjectId: string, dataClass: string, payload: Record<string, unknown>, at = new Date().toISOString()): void {
    const rule = this.pack.retention.find((r) => r.dataClass === dataClass);
    if (!rule) throw new Error(`Unknown data class "${dataClass}" — register retention rule in pack`);
    if (!this.dataStore.has(tenantId)) this.dataStore.set(tenantId, new Map());
    const subjects = this.dataStore.get(tenantId)!;
    if (!subjects.has(subjectId)) subjects.set(subjectId, new Map() as never);
    (subjects.get(subjectId) as unknown as Map<string, { payload: Record<string, unknown>; at: string }>).set(dataClass, { payload, at });
  }

  /** open a DSR request: SLA clock from the market's regulation (pack data) */
  openDsr(tenantId: string, subjectId: string, market: string, right: string): DsrRequest {
    const reg = this.regulationFor(market);
    if (!reg.rightTo.includes(right)) {
      throw new Error(`Right "${right}" not granted under ${reg.id} for market ${market}`);
    }
    const slaDays = reg.dsrSlaDays[right === 'opt-out-sale' ? 'access' : right] ?? reg.dsrSlaDays['access']!;
    const now = new Date();
    const req: DsrRequest = {
      dsrId: `dsr-${++this.seq}`, tenantId, subjectId, market, right,
      status: 'received',
      receivedAt: now.toISOString(),
      dueAt: new Date(now.getTime() + slaDays * 86_400_000).toISOString(),
    };
    this.dsrs.push(req);
    return req;
  }

  /** fulfil a DSR — access/portability export or erasure honoring exemptions */
  fulfil(dsrId: string): DsrRequest {
    const req = this.dsrs.find((d) => d.dsrId === dsrId);
    if (!req) throw new Error(`DSR ${dsrId} not found`);
    req.status = 'in-progress';
    if (req.right === 'access' || req.right === 'portability') {
      const subject = this.dataStore.get(req.tenantId)?.get(req.subjectId) as Map<string, { payload: Record<string, unknown>; at: string }> | undefined;
      const exportData: Record<string, unknown> = {};
      if (subject) {
        for (const [dataClass, entry] of subject) {
          const rule = this.pack.retention.find((r) => r.dataClass === dataClass)!;
          const ageDays = (Date.now() - Date.parse(entry.at)) / 86_400_000;
          if (ageDays <= rule.retainDays) exportData[dataClass] = entry.payload;
        }
      }
      req.dataExport = exportData;
      req.outcome = `${Object.keys(exportData).length} data classes exported`;
    } else if (req.right === 'erasure') {
      const reg = this.regulationFor(req.market);
      const subject = this.dataStore.get(req.tenantId)?.get(req.subjectId);
      let erased = 0;
      let retained: string[] = [];
      if (subject) {
        for (const [dataClass, rule] of this.pack.retention.map((r) => [r.dataClass, r] as const)) {
          if (!subject.has(dataClass)) continue;
          if (rule.survivesErasure && reg.erasureExemptions.includes(rule.basis)) {
            retained.push(dataClass); // legal hold (tax/order records)
            continue;
          }
          subject.delete(dataClass);
          erased++;
        }
      }
      // revoke all optional consents
      for (const [k, c] of this.consents) {
        if (c.tenantId === req.tenantId && c.subjectId === req.subjectId && c.granted) c.granted = false;
      }
      req.outcome = `erased ${erased} data classes; retained ${retained.length} under legal hold (${retained.join(', ') || 'none'})`;
    } else if (req.right === 'rectification') {
      req.outcome = 'rectification workflow queued (per data class)';
    } else if (req.right === 'object-profiling' || req.right === 'opt-out-sale') {
      for (const p of this.pack.purposes.filter((x) => ['profiling', 'marketing', 'analytics'].includes(x.id))) {
        this.setConsent(req.tenantId, req.subjectId, p.id, false, req.market);
      }
      req.outcome = 'profiling/marketing consents revoked';
    }
    req.status = 'completed';
    req.completedAt = new Date().toISOString();
    return req;
  }

  /** SLA check: any request past due and not completed = breach */
  slaBreaches(at = new Date().toISOString()): DsrRequest[] {
    return this.dsrs.filter((d) => d.status !== 'completed' && d.dueAt < at);
  }

  dsr(dsrId: string): DsrRequest {
    const d = this.dsrs.find((x) => x.dsrId === dsrId);
    if (!d) throw new Error(`DSR ${dsrId} not found`);
    return d;
  }
}

const consentDsrModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as ConsentDsrPack;
    const svc = new ConsentService(pack);
    const meter = (ev: string) => billing.meter(ev);
    return {
      setConsent: (t: string, s: string, p: string, g: boolean, m: string) => (meter('consent.set'), svc.setConsent(t, s, p, g, m)),
      hasConsent: (t: string, s: string, p: string) => svc.hasConsent(t, s, p),
      storeData: (t: string, s: string, c: string, p: Record<string, unknown>, at?: string) => svc.storeData(t, s, c, p, at),
      openDsr: (t: string, s: string, m: string, r: string) => (meter('dsr.opened'), svc.openDsr(t, s, m, r)),
      fulfil: (id: string) => (meter('dsr.fulfilled'), svc.fulfil(id)),
      slaBreaches: () => svc.slaBreaches(),
      dsr: (id: string) => svc.dsr(id),
      regulationFor: (m: string) => svc.regulationFor(m),
      __raw: svc,
    };
  },
};

export default consentDsrModule;
