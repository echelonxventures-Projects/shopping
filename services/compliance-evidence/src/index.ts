// @aether/service-compliance-evidence — SOC 2 / ISO 27001 continuous-evidence
// engine (P4-AUD-001). Module-as-a-Product: control catalogs, module→control
// evidence maps, freshness policies are ALL PACK DATA. Evidence providers are
// a swappable EvidencePort — this platform wires module conformance results;
// any host wires its own sources. Adding a framework = pack entry, zero code.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface EvidenceSource {
  module: string;
  check: string;
}

export interface ControlDef {
  id: string;
  criterion: string;
  evidenceFrom: EvidenceSource[];
}

export interface Framework {
  id: string;
  name: string;
  controls: ControlDef[];
}

export interface EvidencePack {
  pack: { name: string };
  frameworks: Framework[];
  evidencePolicies: { collectionIntervalDays: number; acceptableAgeDays: number; gapAlertThreshold: number; exportFormats: string[] };
}

/** EvidencePort — the host supplies proof artifacts per (module, check) */
export interface EvidencePort {
  /** returns the freshest evidence artifact for a module check, or null if none */
  probe(source: EvidenceSource): { artifact: string; collectedAt: string } | null;
}

export interface EvidenceRecord {
  controlId: string;
  frameworkId: string;
  sources: Array<{ module: string; check: string; artifact: string | null; collectedAt: string | null }>;
  satisfied: boolean;
  gapReason?: string;
}

export interface AuditReport {
  frameworkId: string;
  generatedAt: string;
  controlsTotal: number;
  controlsSatisfied: number;
  gaps: Array<{ controlId: string; reason: string }>;
  freshnessBreaches: Array<{ controlId: string; ageDays: number }>;
  report: 'clean' | 'gaps-present';
}

export class ComplianceEvidenceService {
  private pack: EvidencePack;
  private port: EvidencePort | null = null;

  constructor(pack: EvidencePack) {
    this.pack = pack;
  }

  bindEvidencePort(port: EvidencePort): void {
    this.port = port;
  }

  framework(id: string): Framework {
    const f = this.pack.frameworks.find((x) => x.id === id);
    if (!f) throw new Error(`Unknown compliance framework "${id}" — add to pack`);
    return f;
  }

  frameworks(): Framework[] {
    return [...this.pack.frameworks];
  }

  /** collect evidence for one framework — freshness per pack policy */
  collect(frameworkId: string, now = new Date().toISOString()): AuditReport {
    const fw = this.framework(frameworkId);
    if (!this.port) throw new Error('No EvidencePort bound — bindEvidencePort(port) first');
    const maxAge = this.pack.evidencePolicies.acceptableAgeDays * 86_400_000;
    const gaps: Array<{ controlId: string; reason: string }> = [];
    const freshnessBreaches: Array<{ controlId: string; ageDays: number }> = [];
    let satisfied = 0;
    for (const control of fw.controls) {
      const sources = control.evidenceFrom.map((src) => {
        const hit = this.port!.probe(src);
        return { module: src.module, check: src.check, artifact: hit?.artifact ?? null, collectedAt: hit?.collectedAt ?? null };
      });
      const missing = sources.filter((s) => s.artifact === null);
      const stale = sources.filter((s) => s.collectedAt && Date.parse(now) - Date.parse(s.collectedAt) > maxAge);
      if (missing.length > 0) {
        gaps.push({ controlId: control.id, reason: `no evidence from ${missing.map((m) => m.module).join(', ')}` });
      } else if (stale.length > 0) {
        const ageDays = Math.round((Date.parse(now) - Date.parse(stale[0]!.collectedAt!)) / 86_400_000);
        freshnessBreaches.push({ controlId: control.id, ageDays });
        gaps.push({ controlId: control.id, reason: `evidence stale (${ageDays}d > ${this.pack.evidencePolicies.acceptableAgeDays}d)` });
      } else {
        satisfied++;
      }
    }
    return {
      frameworkId,
      generatedAt: now,
      controlsTotal: fw.controls.length,
      controlsSatisfied: satisfied,
      gaps,
      freshnessBreaches,
      report: gaps.length === 0 ? 'clean' : 'gaps-present',
    };
  }

  /** audit-readiness score across ALL frameworks (gate: gaps < threshold per framework) */
  readiness(now = new Date().toISOString()): { ready: boolean; perFramework: Array<{ frameworkId: string; gaps: number }> } {
    const perFramework = this.pack.frameworks.map((fw) => {
      const r = this.collect(fw.id, now);
      return { frameworkId: fw.id, gaps: r.gaps.length };
    });
    const threshold = this.pack.evidencePolicies.gapAlertThreshold;
    return { ready: perFramework.every((p) => p.gaps < threshold), perFramework };
  }

  exportReport(frameworkId: string, format: string, now = new Date().toISOString()): { format: string; payload: string } {
    if (!this.pack.evidencePolicies.exportFormats.includes(format)) {
      throw new Error(`Export format "${format}" not enabled (pack policy)`);
    }
    const report = this.collect(frameworkId, now);
    return { format, payload: JSON.stringify(report, null, 2) };
  }
}

const complianceEvidenceModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as EvidencePack;
    const svc = new ComplianceEvidenceService(pack);
    const meter = (ev: string) => billing.meter(ev);
    return {
      bindEvidencePort: (p: EvidencePort) => svc.bindEvidencePort(p),
      frameworks: () => svc.frameworks(),
      collect: (fw: string, now?: string) => (meter('evidence.collected'), svc.collect(fw, now)),
      readiness: (now?: string) => (meter('readiness.scored'), svc.readiness(now)),
      exportReport: (fw: string, fmt: string, now?: string) => (meter('report.exported'), svc.exportReport(fw, fmt, now)),
      __raw: svc,
    };
  },
};

export default complianceEvidenceModule;
