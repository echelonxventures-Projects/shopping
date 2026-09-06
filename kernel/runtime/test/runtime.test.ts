// Tests: rule + workflow engines — mechanics only, all content is registry data (P0-KRN-005).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleEngine, WorkflowEngine } from '../src/index.ts';
import type { WorkflowDef } from '@aether/kernel-primitives';

const rules = [
  {
    id: 'r_high', name: 'high-priority', priority: 100,
    when: [{ field: 'status', equals: 'failing' }],
    then: { action: 'page' },
    validFrom: '2026-01-01', validTo: null, recordedAt: '2026-01-01',
  },
  {
    id: 'r_low', name: 'low-priority', priority: 10,
    when: [{ field: 'team', in: ['kernel', 'sre'] }],
    then: { action: 'notify' },
    validFrom: '2026-01-01', validTo: null, recordedAt: '2026-01-01',
  },
];

test('rule engine: matching, priority order, non-matching excluded', () => {
  const e = new RuleEngine(rules);
  const hits = e.evaluateAll({ status: 'failing', team: 'kernel' });
  assert.deepEqual(hits.map((h) => h.ruleName), ['high-priority', 'low-priority']);
  assert.deepEqual(e.evaluateAll({ status: 'ok', team: 'sre' }).map((h) => h.ruleName), ['low-priority']);
  assert.equal(e.evaluateAll({ status: 'ok', team: 'sales' }).length, 0);
});

test('rule engine: bitemporal — expired rule no longer fires', () => {
  const e = new RuleEngine([
    { ...rules[0]!, validFrom: '2026-01-01', validTo: '2026-06-01' },
  ]);
  assert.equal(e.evaluateAll({ status: 'failing' }, '2026-07-01').length, 0);
  assert.equal(e.evaluateAll({ status: 'failing' }, '2026-05-01').length, 1);
});

const wf: WorkflowDef = {
  id: 'wf_test', kind: 'workflow', name: 'deploy', entityTypeId: 'et_x',
  states: ['open', 'verified', 'done'],
  transitions: [
    { from: 'open', to: 'verified', trigger: 'ci-green' },
    { from: 'verified', to: 'done', trigger: 'release', guardRules: ['approval'] },
  ],
  initial: 'open', epoch: 1,
  validFrom: '2026-01-01', validTo: null, recordedAt: '2026-01-01',
};

test('workflow engine: legal transitions + guard enforcement', () => {
  const w = new WorkflowEngine([wf]);
  assert.equal(w.initial('deploy'), 'open');
  assert.ok(w.canTransition('deploy', 'open', 'verified'));
  assert.equal(w.canTransition('deploy', 'open', 'done'), false);
  assert.equal(w.canTransition('deploy', 'verified', 'done'), false);
  assert.ok(w.canTransition('deploy', 'verified', 'done', { 'guard:approval': true }));
});
