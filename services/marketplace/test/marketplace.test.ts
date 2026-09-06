// Tests: marketplace — onboarding workflow (KYC/AML gates), scorecard tiers,
// enforcement ladder, reserves, commission effects (P1-MKT-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MarketplaceService, OnboardingError } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../../../packs/marketplace-seller/pack.json'), 'utf8'));

function svc(): MarketplaceService {
  return new MarketplaceService(pack);
}

test('onboarding happy path: applied → kyc_pending → verified → screening → approved', () => {
  const m = svc();
  m.apply('t1', 's1');
  m.advance('t1', 's1', 'kyc_pending', 'documents-submitted');
  m.advance('t1', 's1', 'kyc_verified', 'kyc-passed', { 'identity-verified': true });
  m.advance('t1', 's1', 'aml_screening', 'screening-started');
  m.advance('t1', 's1', 'approved', 'sanctions-clear', { 'identity-verified': true });
  assert.equal(m.get('t1', 's1').status, 'approved');
  assert.ok(m.get('t1', 's1').onboardedAt);
});

test('KYC guard enforced: cannot pass kyc without identity-verified', () => {
  const m = svc();
  m.apply('t1', 's2');
  m.advance('t1', 's2', 'kyc_pending', 'documents-submitted');
  assert.throws(() => m.advance('t1', 's2', 'kyc_verified', 'kyc-passed', {}), OnboardingError);
});

test('sanctions hit → rejected (pack transition)', () => {
  const m = svc();
  m.apply('t1', 's3');
  m.advance('t1', 's3', 'kyc_pending', 'documents-submitted');
  m.advance('t1', 's3', 'kyc_verified', 'kyc-passed', { 'identity-verified': true });
  m.advance('t1', 's3', 'aml_screening', 'screening-started');
  m.advance('t1', 's3', 'rejected', 'sanctions-hit');
  assert.equal(m.get('t1', 's3').status, 'rejected');
});

test('scorecard tiers from pack weights: elite vs watch', () => {
  const m = svc();
  m.apply('t1', 's4');
  const elite = m.score('t1', 's4', { defect_rate: 0.01, cancellation_rate: 0.01, sla_adherence: 0.99, fraud_flags: 0 });
  assert.equal(elite.tier, 'elite');
  // score = 0.396+0.2475+0.2475+0.1 = 0.991 ≥ 0.9
  const watch = m.score('t1', 's4', { defect_rate: 0.6, cancellation_rate: 0.7, sla_adherence: 0.2, fraud_flags: 0.9 });
  // score = 0.16+0.075+0.05+0.01 = 0.295 → below watch floor 0.3... bump sla slightly
  const watch2 = m.score('t1', 's4', { defect_rate: 0.6, cancellation_rate: 0.7, sla_adherence: 0.4, fraud_flags: 0.9 });
  // score = 0.16+0.075+0.1+0.01 = 0.345 ∈ [0.3, 0.6) → watch
  assert.equal(watch2.tier, 'watch');
});

test('enforcement ladder: terrible metrics suspend an approved seller (pack effect)', () => {
  const m = svc();
  m.apply('t1', 's5');
  m.advance('t1', 's5', 'kyc_pending', 'documents-submitted');
  m.advance('t1', 's5', 'kyc_verified', 'kyc-passed', { 'identity-verified': true });
  m.advance('t1', 's5', 'aml_screening', 'screening-started');
  m.advance('t1', 's5', 'approved', 'sanctions-clear', { 'identity-verified': true });
  // persist terrible metrics via score() (metrics stick on the seller), then enforce
  m.score('t1', 's5', { defect_rate: 0.85, cancellation_rate: 0.95, sla_adherence: 0, fraud_flags: 1 });
  const r = m.enforce('t1', 's5');
  assert.equal(r.tier, 'enforcement');
  assert.equal(r.action, 'suspended');
  assert.equal(m.get('t1', 's5').status, 'suspended');
});

test('appeal path: suspended → approved (pack transition)', () => {
  const m = svc();
  m.apply('t1', 's6');
  const s = m.get('t1', 's6');
  s.status = 'suspended';
  m.advance('t1', 's6', 'approved', 'appeal-accepted');
  assert.equal(m.get('t1', 's6').status, 'approved');
});

test('rolling reserves + commission discount by tier are pack policy', () => {
  const m = svc();
  m.apply('t1', 's7');
  m.score('t1', 's7', { defect_rate: 0.02, cancellation_rate: 0.02, sla_adherence: 0.95, fraud_flags: 0 }); // elite
  assert.equal(m.rollingReservePct('t1', 's7'), 0); // elite reserve
  assert.ok(m.commissionAdjust('t1', 's7') > 0); // elite discount feeds commission engine
  m.score('t1', 's7', { defect_rate: 0.35, cancellation_rate: 0.3, sla_adherence: 0.5, fraud_flags: 1 }); // watch
  assert.equal(m.rollingReservePct('t1', 's7'), 0.05); // watch reserve
});
