// Tests: program-as-data — TIDs as U²IDs, workflow-guarded transitions, lint rules from pack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProgramStore, loadPack, packPath } from '../src/index.ts';

const pack = loadPack(packPath);
const store = new ProgramStore(pack);

test('TID scheme allocates structured U²IDs from pack config', () => {
  const item = store.add({
    title: 'Conformance harness v1',
    phase: 'P0',
    workstream: 'CTR',
    acceptance: 'admits/rejects adapter packs',
  });
  assert.match(item.tid, /^P0-CTR-\d{3}$/);
});

test('workflow guards: Done requires lint-green + tests-green via In-Progress', () => {
  const item = store.add({
    title: 'Guard demo',
    phase: 'P0',
    workstream: 'KRN',
    acceptance: 'x',
  });
  store.transition(item.tid, 'In-Progress');
  assert.throws(
    () => store.transition(item.tid, 'Done', {}),
    /guard/i
  );
  assert.throws(
    () => store.transition(item.tid, 'Done', { 'lint-green': true }),
    /guard/i
  );
  const ok = store.transition(item.tid, 'Done', { 'lint-green': true, 'tests-green': true });
  assert.equal(ok.status, 'Done');
});

test('dependency relationship gates readiness', () => {
  const dep = store.add({ title: 'dep', phase: 'P0', workstream: 'KRN', acceptance: 'x' });
  const item = store.add({ title: 'child', phase: 'P0', workstream: 'KRN', acceptance: 'y', dependencies: [dep.tid] });
  assert.equal(store.dependencyReady(item.tid), false);
  store.transition(dep.tid, 'In-Progress');
  store.transition(dep.tid, 'Done', { 'lint-green': true, 'tests-green': true });
  assert.equal(store.dependencyReady(item.tid), true);
});

test('lint rules are pack data: secret-scan fires on fact', () => {
  const fakeSecretPattern = ['sk-', 'a'.repeat(24)].join('');
  const hits = store.lintFact({ content: `token ${fakeSecretPattern}` });
  assert.ok(hits.some((h) => h.ruleName === 'secret-scan'));
});
