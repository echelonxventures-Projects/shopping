// @aether/service-onboarding — tenant onboarding + catalog/customer/order
// migration from external platforms (P1-ONB-001). Module-as-a-Product: source
// adapters (field maps, batch limits, duplicate strategy) are PACK DATA —
// a new platform = new pack entry, zero code. Dry-run + reconciliation report
// by default; progress-safe (resumable by external-id checkpoints).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface SourcePlatform {
  platform: string;
  entityMaps: Record<string, { externalType: string; fieldMap: Record<string, string> }>;
  limits: { maxBatchSize: number; rateLimitPerSec: number };
}

export interface OnboardingPack {
  pack: { name: string };
  sources: SourcePlatform[];
  policies: { dryRunDefault: boolean; reconciliationReport: boolean; duplicateStrategy: string; abortOnErrorCount: number };
}

export interface ImportRecord {
  externalId: string;
  entityType: string;
  data: Record<string, unknown>;
}

export interface ImportOutcome {
  record: ImportRecord;
  status: 'imported' | 'skipped-duplicate' | 'error';
  mapped: Record<string, unknown>;
  errors?: string[];
}

export interface MigrationReport {
  platform: string;
  dryRun: boolean;
  total: number;
  imported: number;
  skippedDuplicates: number;
  errors: Array<{ externalId: string; messages: string[] }>;
  aborted: boolean;
  checkpoint: { lastExternalId: string; processed: number } | null;
  reconciliation: { sourceCount: number; targetCount: number; matches: boolean; drift: Array<{ externalId: string; reason: string }> } | null;
}

export class OnboardingService {
  private sources = new Map<string, SourcePlatform>();
  private imported = new Set<string>(); // dedupe by `${platform}:${entityType}:${externalId}` (skip-by-external-id policy)
  private pack: OnboardingPack;

  constructor(pack: OnboardingPack) {
    this.pack = pack;
    for (const s of pack.sources) this.sources.set(s.platform, s);
  }

  /** map one external record through the platform's field map (pack data) */
  mapRecord(platform: string, record: ImportRecord): Record<string, unknown> {
    const src = this.sources.get(platform);
    if (!src) throw new Error(`Unknown source platform "${platform}" — register an adapter in the onboarding pack`);
    const em = src.entityMaps[record.entityType];
    if (!em) throw new Error(`Platform "${platform}" has no entity map for "${record.entityType}" (pack data)`);
    const out: Record<string, unknown> = {};
    for (const [extField, localField] of Object.entries(em.fieldMap)) {
      if (record.data[extField] !== undefined) out[localField] = record.data[extField];
    }
    return out;
  }

  /** batch import with dry-run, dedupe, error budget, checkpointing */
  importBatch(
    platform: string,
    entityType: string,
    records: ImportRecord[],
    opts: { dryRun?: boolean; resumeFrom?: string } = {}
  ): MigrationReport {
    const src = this.sources.get(platform)!;
    const dryRun = opts.dryRun ?? this.pack.policies.dryRunDefault;
    const report: MigrationReport = {
      platform, dryRun, total: records.length,
      imported: 0, skippedDuplicates: 0, errors: [], aborted: false, checkpoint: null,
      reconciliation: null,
    };
    let processed = 0;
    for (const r of records) {
      if (opts.resumeFrom && processed === 0 && r.externalId !== opts.resumeFrom) continue; // fast-forward checkpoint
      processed++;
      const key = `${platform}:${entityType}:${r.externalId}`;
      try {
        const mapped = this.mapRecord(platform, r);
        if (this.imported.has(key)) {
          report.skippedDuplicates++;
          continue;
        }
        if (!dryRun) this.imported.add(key);
        report.imported++;
      } catch (err) {
        report.errors.push({ externalId: r.externalId, messages: [(err as Error).message] });
        if (report.errors.length >= this.pack.policies.abortOnErrorCount) {
          report.aborted = true;
          break;
        }
      }
    }
    report.checkpoint = { lastExternalId: records[Math.min(processed, records.length) - 1]?.externalId ?? '', processed };
    if (this.pack.policies.reconciliationReport) {
      report.reconciliation = {
        sourceCount: records.length,
        targetCount: report.imported + report.skippedDuplicates,
        matches: report.imported + report.skippedDuplicates === records.length && !report.aborted,
        drift: report.errors.map((e) => ({ externalId: e.externalId, reason: e.messages.join(';') })),
      };
    }
    void src;
    return report;
  }

  /** tenant onboarding checklist driven by pack policy */
  onboardingProgress(tenantId: string, steps: Array<{ id: string; done: boolean }>): { pctComplete: number; nextStep: string | null } {
    const done = steps.filter((s) => s.done).length;
    const next = steps.find((s) => !s.done);
    void tenantId;
    return { pctComplete: Math.round((done / steps.length) * 100), nextStep: next?.id ?? null };
  }
}

const onboardingModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as OnboardingPack;
    const svc = new OnboardingService(pack);
    const meter = (ev: string) => billing.meter(ev);
    return {
      mapRecord: (p: string, r: ImportRecord) => (meter('migration.record_mapped'), svc.mapRecord(p, r)),
      importBatch: (p: string, e: string, r: ImportRecord[], o?: { dryRun?: boolean; resumeFrom?: string }) => (meter('migration.batch'), svc.importBatch(p, e, r, o)),
      onboardingProgress: (t: string, s: Array<{ id: string; done: boolean }>) => svc.onboardingProgress(t, s),
      __raw: svc,
    };
  },
};

export default onboardingModule;
