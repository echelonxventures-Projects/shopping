// Tests: two-step admission — Step 1 preflight early-reject, Step 2 finalize
// binding re-check, TTL expiry, drift rejection, atomic reserve + release,
// exact BackendAdmissionRejected contract (dp_rank + policies) from user spec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RequestAdmissionService, BackendAdmissionRejected } from '../src/index.ts';
import type { AdmissionPack, AdmissionRequest } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/request-admission.json'), 'utf8')) as AdmissionPack;
const svc = () => new RequestAdmissionService(pack);

function req(over: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return { requestId: 'r1', kind: 'cold-request', dpRank: 3, declaredPrefillTokens: 4096, ...over };
}

test('Step 1 preflight: exact user-spec rejection — cold-request, dp_rank=3, policy=prefill_pressure', () => {
  const s = svc();
  // rank 3 already at the 32k pending-token limit (pack data) → prefill_pressure fails
  const live = {
    pendingPrefillTokens: { 3: 30_000 },
    concurrentPrefills: { 3: 0 },
    queueDepth: { 3: 0 },
    activeSlices: 0,
    tokensInSlices: 0,
  };
  assert.throws(
    () => s.preflight(req({ declaredPrefillTokens: 4096 }), live),
    (err: unknown) => {
      assert.ok(err instanceof BackendAdmissionRejected);
      assert.equal(err.stage, 'preflight');
      assert.equal(err.dpRank, 3);
      assert.deepEqual(err.policies, ['prefill_pressure']);
      assert.match(err.message, /BackendAdmissionRejected: Engine cold-request admission rejected: dp_rank=3, policies=prefill_pressure/);
      return true;
    }
  );
});

test('happy path: preflight grant → finalize reserves atomically → release unwinds', () => {
  const s = svc();
  const pre = s.preflight(req({ requestId: 'ok-1', declaredPrefillTokens: 8192 }));
  assert.equal(pre.ok, true);
  assert.ok(pre.expiresAt > Date.now());

  const fin = s.finalize(req({ requestId: 'ok-1', declaredPrefillTokens: 8192 }));
  assert.equal(fin.ok, true);
  const snap = s.currentSnapshot();
  assert.equal(snap.pendingPrefillTokens[3], 8192);
  assert.equal(snap.concurrentPrefills[3], 1);

  s.release(req({ requestId: 'ok-1', declaredPrefillTokens: 8192 }));
  const after = s.currentSnapshot();
  assert.equal(after.pendingPrefillTokens[3], 0);
  assert.equal(after.concurrentPrefills[3], 0);
});

test('TWO-STEP is enforced: finalize without preflight is rejected', () => {
  const s = svc();
  assert.throws(
    () => s.finalize(req({ requestId: 'no-pre' })),
    /no preflight grant/ // two-step admission contract
  );
});

test('Step 2 drift: preflight passed, but live state changed → finalize rejects with policies', () => {
  const s = svc();
  s.preflight(req({ requestId: 'drift-1', declaredPrefillTokens: 4096 }));
  // another request runs BOTH steps in between, consuming the same rank's budget
  s.preflight(req({ requestId: 'other', declaredPrefillTokens: 28_000 }));
  const fin1 = s.finalize(req({ requestId: 'other', declaredPrefillTokens: 28_000 }));
  assert.equal(fin1.ok, true);
  assert.throws(
    () => s.finalize(req({ requestId: 'drift-1', declaredPrefillTokens: 4096 })),
    (err: unknown) => {
      assert.ok(err instanceof BackendAdmissionRejected);
      assert.equal(err.stage, 'finalize');
      assert.equal(err.dpRank, 3);
      assert.ok(err.policies.includes('prefill_pressure'));
      return true;
    }
  );
  // the failing grant is consumed; the winner remains reserved
  assert.equal(s.currentSnapshot().pendingPrefillTokens[3], 28_000);
});

test('TTL expiry: expired preflight grant rejected at finalize with explicit policy', () => {
  const s = new RequestAdmissionService({ ...pack, twoStep: { ...pack.twoStep, preflightTtlMs: 0 } });
  s.preflight(req({ requestId: 'ttl-1' }));
  assert.throws(
    () => s.finalize(req({ requestId: 'ttl-1' })),
    (err: unknown) => {
      assert.ok(err instanceof BackendAdmissionRejected);
      assert.deepEqual(err.policies, ['preflight_ttl_expired']);
      return true;
    }
  );
});

test('queue_saturation policy from pack: declared depth over limit fails preflight', () => {
  const s = svc();
  assert.throws(
    () => s.preflight(req({ declaredQueueDepth: 600 })), // > 512 pack limit
    (err: unknown) => {
      assert.ok(err instanceof BackendAdmissionRejected);
      assert.ok(err.policies.includes('queue_saturation'));
      return true;
    }
  );
});

test('concurrent-prefill cap from pack: 9th concurrent on a rank fails', () => {
  const s = svc();
  // seed 8 concurrent prefills on rank 3 (below token cap: 8 * 1000 < 32000)
  const seeded = {
    pendingPrefillTokens: { 3: 8000 },
    concurrentPrefills: { 3: 8 },
    queueDepth: { 3: 0 },
    activeSlices: 0,
    tokensInSlices: 0,
  };
  assert.throws(
    () => s.preflight(req({ declaredPrefillTokens: 1000 }), seeded),
    (err: unknown) => {
      assert.ok(err instanceof BackendAdmissionRejected);
      assert.equal(err.policies[0], 'prefill_pressure');
      return true;
    }
  );
});

test('policy scoping: warm-request policies do not apply to cold-requests (pack appliesTo)', () => {
  const s = svc();
  // tpu_slice_occupancy applies only to warm-request — a cold-request ignores it
  const pre = s.preflight(req({ declaredPrefillTokens: 100 }));
  assert.ok(!pre.checkedPolicies.includes('tpu_slice_occupancy'));
  assert.ok(pre.checkedPolicies.includes('prefill_pressure'));
});
