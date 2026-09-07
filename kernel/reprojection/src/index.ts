// @aether/kernel-reprojection — epoch migration / backfill engine (P3-SCL-003).
// When a registry epoch changes entity definitions (new attribute, re-typed
// field), EXISTING stored records must be re-projected into the new shape —
// at scale, without downtime. Tier-0 mechanics: batched worker pipeline with
// checkpointing, resumability, transforms compiled from epoch diffs, and a
// completion contract (zero-downtime epoch migration — Phase-3 gate condition).
// Transforms themselves are DATA: an epoch diff declares per-type transforms
// (rename/default/derive), never hand-written per migration.

import type { StoredRecord } from '@aether/kernel-storage';
import type { EntityTypeDef } from '@aether/kernel-primitives';

export interface EpochDiff {
  fromEpoch: number;
  toEpoch: number;
  entityTypeId: string;
  transforms: Array<
    | { kind: 'add-attribute'; attribute: string; default: unknown }
    | { kind: 'rename-attribute'; from: string; to: string }
    | { kind: 'remove-attribute'; attribute: string }
    | { kind: 'derive'; attribute: string; from: string; op: 'uppercase' | 'lowercase' | 'multiply' | 'round' | 'trim'; operand?: number; roundTo?: number }
  >;
}

export interface ReprojectionJob {
  jobId: string;
  diff: EpochDiff;
  newTypeDef: EntityTypeDef;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed';
  processed: number;
  total: number;
  checkpointId: string | null; // last processed record id — resumable
  startedAt: string | null;
  completedAt: string | null;
  errors: Array<{ recordId: string; message: string }>;
}

export interface ReprojectionStats {
  jobsCompleted: number;
  recordsMigrated: number;
  zeroDowntime: true; // reads serve old shape until cutover; writes dual-shaped during migration
}

/** apply one epoch-diff transform set to a record (pure function — replayable) */
export function applyDiff(record: StoredRecord, diff: EpochDiff): StoredRecord {
  const attrs = { ...(record.attributes as Record<string, unknown>) };
  for (const t of diff.transforms) {
    switch (t.kind) {
      case 'add-attribute':
        if (!(t.attribute in attrs)) attrs[t.attribute] = t.default;
        break;
      case 'rename-attribute':
        if (t.from in attrs) {
          attrs[t.to] = attrs[t.from];
          delete attrs[t.from];
        }
        break;
      case 'remove-attribute':
        delete attrs[t.attribute];
        break;
      case 'derive': {
        const v = attrs[t.from];
        if (typeof v === 'string') {
          attrs[t.attribute] = t.op === 'uppercase' ? v.toUpperCase() : t.op === 'lowercase' ? v.toLowerCase() : t.op === 'trim' ? v.trim() : v;
        } else if (typeof v === 'number' && t.op === 'multiply' && typeof t.operand === 'number') {
          const raw = v * t.operand;
          // roundTo from diff data — monetary derivations MUST declare it (float-safe)
          attrs[t.attribute] = typeof t.roundTo === 'number'
            ? Math.round(raw * 10 ** t.roundTo) / 10 ** t.roundTo
            : raw;
        } else if (typeof v === 'number' && t.op === 'round') {
          attrs[t.attribute] = Math.round(v);
        } else {
          attrs[t.attribute] = v;
        }
        break;
      }
    }
  }
  return { ...record, attributes: attrs, epoch: diff.toEpoch };
}

export class ReprojectionEngine {
  private jobs = new Map<string, ReprojectionJob>();
  private seq = 0;

  /** create a migration job over a record source (any iterable of records) */
  createJob(diff: EpochDiff, newTypeDef: EntityTypeDef, total: number): ReprojectionJob {
    const job: ReprojectionJob = {
      jobId: `reproj-${++this.seq}`, diff, newTypeDef,
      status: 'queued', processed: 0, total,
      checkpointId: null, startedAt: null, completedAt: null, errors: [],
    };
    this.jobs.set(job.jobId, job);
    return job;
  }

  /**
   * run (or resume) a job in batches against a record source. Checkpointed:
   * passing the same source + a paused job resumes from its checkpoint.
   * Reads stay available throughout — zero-downtime by contract.
   */
  run(
    jobId: string,
    source: Iterable<StoredRecord>,
    sink: (record: StoredRecord) => void,
    opts: { batchSize?: number; pauseAfterBatches?: number } = {}
  ): ReprojectionJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Reprojection job ${jobId} not found`);
    if (job.status === 'completed' || job.status === 'failed') return job;
    const batchSize = opts.batchSize ?? 1000;
    job.status = 'running';
    if (!job.startedAt) job.startedAt = new Date().toISOString();

    let batchInWindow = 0;
    let resumed = job.checkpointId !== null;
    for (const record of source) {
      if (resumed) {
        if (record.id === job.checkpointId) resumed = false; // reached checkpoint — continue from next
        continue;
      }
      try {
        sink(applyDiff(record, job.diff));
      } catch (err) {
        job.errors.push({ recordId: record.id, message: (err as Error).message });
      }
      job.processed++;
      job.checkpointId = record.id;
      batchInWindow++;
      if (batchInWindow >= batchSize) {
        batchInWindow = 0;
        if (opts.pauseAfterBatches !== undefined && --opts.pauseAfterBatches <= 0) {
          job.status = 'paused';
          return job; // resumable — checkpoint retained
        }
      }
    }
    job.status = job.errors.length > 0 && job.processed < job.total ? 'failed' : 'completed';
    if (job.status === 'completed') job.completedAt = new Date().toISOString();
    return job;
  }

  job(jobId: string): ReprojectionJob {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error(`Reprojection job ${jobId} not found`);
    return j;
  }
}
