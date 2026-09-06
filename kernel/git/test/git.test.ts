// Tests: Git-as-ECR — commits/branches/relationships as entities from CONFIG (pack data),
// remotes/policies never in code, deployment context resolution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitStore, type GitConfig } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../../../packs/git-integration/pack.json'), 'utf8'));
const config = pack.git as GitConfig;
const store = new GitStore(config, join(here, '../..'));

test('repository resolved from CONFIG pack (zero URL literals in code)', () => {
  const repo = store.repository('aethercommerce-platform');
  assert.equal(repo.defaultBranch, 'main');
  const remotes = store.remotes({ repository: 'aethercommerce-platform' });
  assert.equal(remotes.length, 1);
  assert.equal(remotes[0]!.name, 'origin');
  assert.equal(remotes[0]!.url, 'https://github.com/echelonxventures-Projects/shopping.git');
  assert.throws(() => store.repository('unknown-repo'), /pack data/);
});

test('commits are entities: sha as U²ID, refs parsed', () => {
  const commits = store.commits({ repository: 'aethercommerce-platform' }, 5);
  assert.ok(commits.length >= 1);
  const c = commits[0]!;
  assert.match(c.id, /^commit:[0-9a-f]{40}$/);
  assert.ok(c.message.length > 0);
  assert.ok(c.timestamp.startsWith('20'));
});

test('relationships derived: parent-of chain + branch-of + tracks-remote', () => {
  const rels = store.relationships({ repository: 'aethercommerce-platform' }, 5);
  assert.ok(rels.some((r) => r.kind === 'parent-of'));
  assert.ok(rels.some((r) => r.kind === 'branch-of' && r.to === 'aethercommerce-platform'));
  assert.ok(rels.some((r) => r.kind === 'tracks-remote' && r.from.includes('origin')));
});

test('deployment context: ref + sha resolved from config frame', () => {
  const ctx = store.deployContext({ repository: 'aethercommerce-platform' });
  assert.equal(ctx.repository, 'aethercommerce-platform');
  assert.match(ctx.sha, /^[0-9a-f]{40}$/);
  assert.ok(ctx.message.length > 0);
});

test('policies are data: protected branches + conventional commits flags from pack', () => {
  assert.deepEqual(config.policies!.protectedBranches, ['main']);
  assert.equal(config.policies!.conventionalCommits, true);
});
