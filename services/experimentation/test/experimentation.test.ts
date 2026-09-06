// Tests: experimentation — deterministic assignment, significance promotion,
// guardrail kill-switch, rollout steps (P1-EXP-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExperimentationService } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/experimentation-core.json'), 'utf8'));
const svc = () => new ExperimentationService(pack.policy);

test('deterministic assignment: same subject always gets the same variant', () => {
  const s = svc();
  const e = s.create('t1', 'checkout-button-color', ['control', 'blue', 'green']);
  s.start('t1', e.id);
  s.advanceRollout('t1', e.id); // 5%
  s.advanceRollout('t1', e.id); // 10%
  s.advanceRollout('t1', e.id); // 25%
  s.advanceRollout('t1', e.id); // 50%
  const a1 = s.assign('t1', e.id, 'user-42');
  const a2 = s.assign('t1', e.id, 'user-42');
  assert.equal(a1, a2);
  assert.ok(['control', 'blue', 'green'].includes(a1));
});

test('full rollout (100%) exposes every subject; holdout at low rollout returns control uncounted', () => {
  const s = svc();
  const e = s.create('t1', 'hero-banner', ['control', 'new']);
  s.start('t1', e.id);
  for (let i = 0; i < 5; i++) s.advanceRollout('t1', e.id); // → 1.0
  for (let i = 0; i < 50; i++) s.assign('t1', e.id, `u${i}`);
  const control = e.results['control']!.exposures;
  const treatment = e.results['new']!.exposures;
  assert.equal(control + treatment, 50);
});

test('significance promotion: strong winner auto-promotes at pack confidence', () => {
  const s = svc();
  const e = s.create('t1', 'pricing-page', ['control', 'treatment']);
  s.start('t1', e.id);
  for (let i = 0; i < 5; i++) s.advanceRollout('t1', e.id);
  // control: 10% conversion; treatment: 15% conversion over 3000 subjects (arms ~1500 > minSample 1000)
  for (let i = 0; i < 3000; i++) {
    const v = s.assign('t1', e.id, `s${i}`);
    const converted = v === 'treatment' ? i % 100 < 15 : i % 100 < 10;
    s.record('t1', e.id, `s${i}`, converted);
  }
  const verdict = s.evaluate('t1', e.id);
  assert.equal(verdict.verdict, 'promote');
  assert.equal(verdict.winner, 'treatment');
  assert.equal(s.get('t1', e.id).status, 'promoted');
});

test('keep-running: insufficient sample does not promote', () => {
  const s = svc();
  const e = s.create('t1', 'early-exp', ['control', 't']);
  s.start('t1', e.id);
  s.assign('t1', e.id, 'a');
  const verdict = s.evaluate('t1', e.id);
  assert.equal(verdict.verdict, 'keep-running');
  assert.match(verdict.detail, /sample \d+ </);
});

test('guardrail kill-switch: checkout success drop ≥ 2% auto-kills the experiment', () => {
  const s = svc();
  const e = s.create('t1', 'risky-change', ['control', 'variant']);
  s.start('t1', e.id);
  const r = s.guardrailCheck('t1', e.id, { metric: 'checkout_success_rate', controlValue: 0.94, variantValue: 0.90 });
  assert.equal(r.killed, true);
  assert.equal(s.get('t1', e.id).status, 'killed');
  assert.match(s.get('t1', e.id).killedReason!, /dropped/);
  const benign = s.guardrailCheck('t1', e.id, { metric: 'checkout_success_rate', controlValue: 0.94, variantValue: 0.935 });
  assert.equal(benign.killed, false);
});
