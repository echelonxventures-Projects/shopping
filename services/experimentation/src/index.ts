// @aether/service-experimentation — feature flags, A/B/n experiments, governed
// rollout (P1-EXP-001). Module-as-a-Product: rollout steps, promotion confidence,
// guardrail kill-switch are pack data; experiments are bitemporal entities.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface ExpPolicy {
  rolloutSteps: number[];
  autoPromoteConfidence: number;
  minSamplePerArm: number;
  maxConcurrentExperiments: number;
  killSwitchGuardrail: { metric: string; minDrop: number };
}

export interface Experiment {
  id: string;
  tenantId: string;
  name: string;
  variants: string[]; // ['control', 'treatment-a', ...]
  status: 'draft' | 'running' | 'promoted' | 'killed';
  rolloutStep: number; // index into policy.rolloutSteps
  assignments: Record<string, string>; // subjectId -> variant
  results: Record<string, { exposures: number; conversions: number }>;
  createdAt: string;
  killedReason?: string;
}

export class ExperimentationService {
  private experiments = new Map<string, Experiment>();
  private seq = 0;
  private policy: ExpPolicy;

  constructor(policy: ExpPolicy) {
    this.policy = policy;
  }

  create(tenantId: string, name: string, variants: string[]): Experiment {
    if ([...this.experiments.values()].filter((e) => e.tenantId === tenantId && e.status === 'running').length >= this.policy.maxConcurrentExperiments) {
      throw new Error(`maxConcurrentExperiments (${this.policy.maxConcurrentExperiments}) reached for tenant`);
    }
    const exp: Experiment = {
      id: `exp-${++this.seq}`, tenantId, name, variants,
      status: 'draft', rolloutStep: 0, assignments: {},
      results: Object.fromEntries(variants.map((v) => [v, { exposures: 0, conversions: 0 }])),
      createdAt: new Date().toISOString(),
    };
    this.experiments.set(`${tenantId}:${exp.id}`, exp);
    return exp;
  }

  start(tenantId: string, expId: string): Experiment {
    const e = this.get(tenantId, expId);
    e.status = 'running';
    return e;
  }

  /** deterministic assignment (same subject → same variant across requests) */
  assign(tenantId: string, expId: string, subjectId: string): string {
    const e = this.get(tenantId, expId);
    if (e.status !== 'running') throw new Error('experiment not running');
    if (e.assignments[subjectId]) return e.assignments[subjectId]!;
    const rollout = this.policy.rolloutSteps[e.rolloutStep]!;
    if (hash01(`${expId}:${subjectId}`) > rollout) {
      // not in experiment yet at current rollout — holdout returns control
      const variant = e.variants[0]!;
      e.assignments[subjectId] = variant;
      return variant;
    }
    const variant = e.variants[Math.floor(hash01(subjectId) * e.variants.length) % e.variants.length]!;
    e.assignments[subjectId] = variant;
    e.results[variant]!.exposures++;
    return variant;
  }

  record(tenantId: string, expId: string, subjectId: string, converted: boolean): void {
    const e = this.get(tenantId, expId);
    const variant = e.assignments[subjectId];
    if (!variant) return; // subject was holdout (control, not counted)
    if (converted) e.results[variant]!.conversions++;
  }

  /** two-proportion z-test vs control at pack confidence */
  evaluate(tenantId: string, expId: string): { verdict: 'promote' | 'kill' | 'keep-running'; winner?: string; detail: string } {
    const e = this.get(tenantId, expId);
    const control = e.results[e.variants[0]!]!;
    if (control.exposures < this.policy.minSamplePerArm) {
      return { verdict: 'keep-running', detail: `control arm sample ${control.exposures} < ${this.policy.minSamplePerArm}` };
    }
    let bestZ = 0;
    let bestVariant: string | undefined;
    for (const v of e.variants.slice(1)) {
      const t = e.results[v]!;
      if (t.exposures < this.policy.minSamplePerArm) continue;
      const z = zTest(t.conversions, t.exposures, control.conversions, control.exposures);
      if (z > bestZ) {
        bestZ = z;
        bestVariant = v;
      }
    }
    const needed = normSinv(this.policy.autoPromoteConfidence);
    if (bestVariant && bestZ >= needed) {
      e.status = 'promoted';
      return { verdict: 'promote', winner: bestVariant, detail: `z=${bestZ.toFixed(2)} ≥ ${needed.toFixed(2)} at confidence ${this.policy.autoPromoteConfidence}` };
    }
    return { verdict: 'keep-running', detail: `best z=${bestZ.toFixed(2)} < needed ${needed.toFixed(2)}` };
  }

  /** guardrail kill-switch: pack-configured metric drop auto-kills */
  guardrailCheck(tenantId: string, expId: string, observedMetric: { metric: string; controlValue: number; variantValue: number }): { killed: boolean } {
    const g = this.policy.killSwitchGuardrail;
    if (observedMetric.metric !== g.metric) return { killed: false };
    const drop = observedMetric.controlValue - observedMetric.variantValue;
    if (drop >= g.minDrop) {
      const e = this.get(tenantId, expId);
      e.status = 'killed';
      e.killedReason = `${g.metric} dropped ${drop.toFixed(3)} ≥ ${g.minDrop}`;
      return { killed: true };
    }
    return { killed: false };
  }

  advanceRollout(tenantId: string, expId: string): Experiment {
    const e = this.get(tenantId, expId);
    if (e.rolloutStep < this.policy.rolloutSteps.length - 1) e.rolloutStep++;
    return e;
  }

  get(tenantId: string, expId: string): Experiment {
    const e = this.experiments.get(`${tenantId}:${expId}`);
    if (!e) throw new Error(`experiment ${expId} not found`);
    return e;
  }
}

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function zTest(c1: number, n1: number, c2: number, n2: number): number {
  const p1 = c1 / n1;
  const p2 = c2 / n2;
  const p = (c1 + c2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return 0;
  return (p1 - p2) / se;
}

function normSinv(conf: number): number {
  // inverse normal CDF approximation (Abramowitz-Stegun) — sufficient for gate decisions
  const p = 1 - (1 - conf) / 2;
  const t = Math.sqrt(-2 * Math.log(1 - p));
  return t - (2.30753 * t + 0.27061) / (1 + 0.99229 * t + 0.04483 * t * t);
}

const experimentationModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const policy = (Object.values(packs)[0] as { policy: ExpPolicy }).policy;
    const svc = new ExperimentationService(policy);
    const meter = (ev: string) => billing.meter(ev);
    return {
      create: (t: string, n: string, v: string[]) => (meter('experiment.created'), svc.create(t, n, v)),
      start: (t: string, id: string) => svc.start(t, id),
      assign: (t: string, id: string, s: string) => (meter('experiment.exposed'), svc.assign(t, id, s)),
      record: (t: string, id: string, s: string, c: boolean) => svc.record(t, id, s, c),
      evaluate: (t: string, id: string) => (meter('experiment.evaluated'), svc.evaluate(t, id)),
      guardrailCheck: (t: string, id: string, m: { metric: string; controlValue: number; variantValue: number }) => svc.guardrailCheck(t, id, m),
      advanceRollout: (t: string, id: string) => svc.advanceRollout(t, id),
      get: (t: string, id: string) => svc.get(t, id),
      __raw: svc,
    };
  },
};

export default experimentationModule;
