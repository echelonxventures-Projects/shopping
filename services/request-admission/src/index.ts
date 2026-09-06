// @aether/service-request-admission — TWO-STEP engine request admission.
//
// Step 1 (PREFLIGHT): non-binding early evaluation against admission policies
//   (prefill_pressure, queue_saturation, ...) using the requester's declared
//   estimates. Cheap. Rejects early with BackendAdmissionRejected BEFORE any
//   engine resources are touched.
// Step 2 (FINALIZE): binding re-check against LIVE counters at commit time
//   (declared vs actual drift), reserves the slot atomically, and only then
//   hands the request to the engine. A request that passed preflight can still
//   be rejected at finalize if state changed in between.
//
// Doctrine compliance: policy names, thresholds, TTLs are PACK DATA; dp_rank
// is a context fact; the error contract (BackendAdmissionRejected with failed
// policies + rank) is the public surface. Kernel mechanics only here.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface AdmissionPolicy {
  name: string;
  appliesTo: string; // 'cold-request' | 'warm-request' | any
  limits: Record<string, number>;
}

export interface AdmissionPack {
  pack: { name: string };
  policies: AdmissionPolicy[];
  twoStep: { preflightTtlMs: number; finalizaRecheckRequired: boolean; holdSlotOnPreflight: boolean };
}

export interface AdmissionRequest {
  requestId: string;
  kind: string; // 'cold-request' | 'warm-request' | ...
  dpRank: number; // data-parallel rank — a CONTEXT FACT, never a code constant
  declaredPrefillTokens: number;
  declaredQueueDepth?: number;
  declaredSliceTokens?: number;
}

export interface AdmissionSnapshot {
  pendingPrefillTokens: Record<number, number>; // per dpRank
  concurrentPrefills: Record<number, number>;
  queueDepth: Record<number, number>;
  activeSlices: number;
  tokensInSlices: number;
}

/** the exact public error contract from the user's spec */
export class BackendAdmissionRejected extends Error {
  readonly requestId: string;
  readonly dpRank: number;
  readonly policies: string[];
  readonly stage: 'preflight' | 'finalize';

  constructor(init: { requestId: string; dpRank: number; policies: string[]; stage: 'preflight' | 'finalize' }) {
    // canonical contract message (user spec); stage is carried on the typed field, not in the message
    super(
      `BackendAdmissionRejected: Engine cold-request admission rejected: dp_rank=${init.dpRank}, policies=${init.policies.join(', ')}`
    );
    this.name = 'BackendAdmissionRejected';
    this.requestId = init.requestId;
    this.dpRank = init.dpRank;
    this.policies = init.policies;
    this.stage = init.stage;
  }
}

export interface PreflightResult {
  ok: boolean;
  requestId: string;
  expiresAt: number; // spine ms — preflight grant TTL
  checkedPolicies: string[];
}

export interface FinalizeResult {
  ok: boolean;
  requestId: string;
  reserved: { prefillTokens: number; sliceTokens: number };
  recheckedPolicies: string[];
}

export class RequestAdmissionService {
  private policies: AdmissionPolicy[];
  private twoStep: AdmissionPack['twoStep'];
  private snapshot: AdmissionSnapshot = {
    pendingPrefillTokens: {},
    concurrentPrefills: {},
    queueDepth: {},
    activeSlices: 0,
    tokensInSlices: 0,
  };
  private grants = new Map<string, { expiresAt: number; request: AdmissionRequest }>();

  constructor(pack: AdmissionPack) {
    this.policies = pack.policies;
    this.twoStep = pack.twoStep;
  }

  /** ---- Step 1: PREFLIGHT (non-binding, cheap, early-reject) ---- */
  preflight(req: AdmissionRequest, live: AdmissionSnapshot = this.snapshot): PreflightResult {
    const now = Date.now();
    const checked: string[] = [];
    const failed: string[] = [];

    for (const p of this.policies) {
      if (p.appliesTo !== req.kind && p.appliesTo !== 'any') continue;
      checked.push(p.name);
      const reason = this.checkPolicy(p, req, { ...live }, 'declared');
      if (reason) failed.push(p.name);
    }
    if (failed.length > 0) {
      throw new BackendAdmissionRejected({ requestId: req.requestId, dpRank: req.dpRank, policies: failed, stage: 'preflight' });
    }
    const expiresAt = now + this.twoStep.preflightTtlMs;
    if (!this.twoStep.holdSlotOnPreflight) {
      this.grants.set(req.requestId, { expiresAt, request: req });
    }
    return { ok: true, requestId: req.requestId, expiresAt, checkedPolicies: checked };
  }

  /** ---- Step 2: FINALIZE (binding, live re-check, atomic reserve) ---- */
  finalize(req: AdmissionRequest, liveOverrides?: Partial<AdmissionSnapshot>): FinalizeResult {
    const grant = this.grants.get(req.requestId);
    if (!grant) {
      throw new Error(`finalize rejected: no preflight grant for ${req.requestId} — run Step 1 first (two-step admission contract)`);
    }
    if (Date.now() >= grant.expiresAt) {
      this.grants.delete(req.requestId);
      throw new BackendAdmissionRejected({ requestId: req.requestId, dpRank: req.dpRank, policies: ['preflight_ttl_expired'], stage: 'finalize' });
    }
    // merge host-provided live truth over internal counters
    const live: AdmissionSnapshot = { ...this.snapshot, ...liveOverrides };
    const checked: string[] = [];
    const failed: string[] = [];

    if (this.twoStep.finalizaRecheckRequired) {
      for (const p of this.policies) {
        if (p.appliesTo !== req.kind && p.appliesTo !== 'any') continue;
        checked.push(p.name);
        const reason = this.checkPolicy(p, req, live, 'live');
        if (reason) failed.push(p.name);
      }
      if (failed.length > 0) {
        this.grants.delete(req.requestId);
        throw new BackendAdmissionRejected({ requestId: req.requestId, dpRank: req.dpRank, policies: failed, stage: 'finalize' });
      }
    }

    // atomic reserve against internal counters
    this.snapshot.pendingPrefillTokens[req.dpRank] = (this.snapshot.pendingPrefillTokens[req.dpRank] ?? 0) + req.declaredPrefillTokens;
    this.snapshot.concurrentPrefills[req.dpRank] = (this.snapshot.concurrentPrefills[req.dpRank] ?? 0) + 1;
    if (req.declaredSliceTokens) {
      this.snapshot.activeSlices += 1;
      this.snapshot.tokensInSlices += req.declaredSliceTokens;
    }
    this.grants.delete(req.requestId);
    return {
      ok: true,
      requestId: req.requestId,
      reserved: { prefillTokens: req.declaredPrefillTokens, sliceTokens: req.declaredSliceTokens ?? 0 },
      recheckedPolicies: checked,
    };
  }

  /** release a finalized reservation (request completed — counters unwind) */
  release(req: AdmissionRequest): void {
    this.snapshot.pendingPrefillTokens[req.dpRank] = Math.max(0, (this.snapshot.pendingPrefillTokens[req.dpRank] ?? 0) - req.declaredPrefillTokens);
    this.snapshot.concurrentPrefills[req.dpRank] = Math.max(0, (this.snapshot.concurrentPrefills[req.dpRank] ?? 0) - 1);
    if (req.declaredSliceTokens) {
      this.snapshot.activeSlices = Math.max(0, this.snapshot.activeSlices - 1);
      this.snapshot.tokensInSlices = Math.max(0, this.snapshot.tokensInSlices - req.declaredSliceTokens);
    }
  }

  currentSnapshot(): AdmissionSnapshot {
    return this.snapshot;
  }

  private checkPolicy(
    p: AdmissionPolicy,
    req: AdmissionRequest,
    live: AdmissionSnapshot,
    mode: 'declared' | 'live'
  ): string | null {
    const r = req.dpRank;
    switch (p.name) {
      case 'prefill_pressure': {
        const pending = live.pendingPrefillTokens[r] ?? 0;
        const concurrent = live.concurrentPrefills[r] ?? 0;
        if (pending + req.declaredPrefillTokens > p.limits['maxPendingPrefillTokensPerRank']!) {
          return `pending(${pending})+${req.declaredPrefillTokens} > ${p.limits['maxPendingPrefillTokensPerRank']}`;
        }
        if (concurrent + 1 > p.limits['maxConcurrentPrefillsPerRank']!) {
          return `concurrent(${concurrent})+1 > ${p.limits['maxConcurrentPrefillsPerRank']}`;
        }
        return null;
      }
      case 'queue_saturation': {
        const depth = mode === 'live' ? (live.queueDepth[r] ?? req.declaredQueueDepth ?? 0) : (req.declaredQueueDepth ?? live.queueDepth[r] ?? 0);
        if (depth > p.limits['maxQueueDepthPerRank']!) return `queueDepth(${depth}) > ${p.limits['maxQueueDepthPerRank']}`;
        return null;
      }
      case 'tpu_slice_occupancy': {
        if (live.activeSlices + 1 > p.limits['maxActiveSlices']!) return `activeSlices(${live.activeSlices})+1 > ${p.limits['maxActiveSlices']}`;
        if (live.tokensInSlices + (req.declaredSliceTokens ?? 0) > p.limits['maxTokensPerSlice']!) {
          return `sliceTokens overflow`;
        }
        return null;
      }
      default:
        return null; // unknown policy names are inert — pack-conformance gates registration
    }
  }
}

const requestAdmissionModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as AdmissionPack;
    const svc = new RequestAdmissionService(pack);
    const meter = (ev: string) => billing.meter(ev);
    return {
      preflight: (req: AdmissionRequest, live?: AdmissionSnapshot) => (meter('admission.preflight'), svc.preflight(req, live)),
      finalize: (req: AdmissionRequest, live?: Partial<AdmissionSnapshot>) => (meter('admission.finalize'), svc.finalize(req, live)),
      release: (req: AdmissionRequest) => svc.release(req),
      currentSnapshot: () => svc.currentSnapshot(),
      __raw: svc,
    };
  },
};

export default requestAdmissionModule;
