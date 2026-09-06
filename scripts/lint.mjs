// Lint — ALL rules sourced from packs/platform-program/pack.json lintRulePack (data, not code).
// Rule semantics: ALL rows of a decision table must match for the rule to fire (AND logic):
// a "path" row scopes WHERE the rule applies; a "content" row defines WHAT violates.
// Adding/changing a lint rule = editing the pack. This file is generic Tier-0 mechanics only.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleEngine } from '@aether/kernel-runtime/src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pack = JSON.parse(readFileSync(join(root, 'packs/platform-program/pack.json'), 'utf8'));

const rules = (pack.lintRulePack ?? []).map((r) => ({
  id: r.id,
  name: r.name,
  priority: r.priority,
  when: r.decisionTable.map((row) => ({
    field: row.field,
    matches: row.matches,
  })),
  then: {},
  validFrom: r.validFrom,
  validTo: r.validTo,
  recordedAt: r.recordedAt,
}));

const engine = new RuleEngine(rules);
const failures = [];

function walk(dir, cb) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f === 'node_modules' || f === '.git') continue;
      walk(p, cb);
    } else if (/\.(ts|mjs|json)$/.test(f)) {
      cb(p);
    }
  }
}

const targetDirs = process.argv.includes('--kernel-only')
  ? ['kernel']
  : ['kernel', 'services', 'packs'].filter((d) => existsSync(join(root, d)));

for (const dir of targetDirs) {
  walk(join(root, dir), (p) => {
    const relPath = p.replace(root + '/', '');
    const content = readFileSync(p, 'utf8');
    const fact = { path: relPath, content };
    for (const _hit of engine.evaluateAll(fact)) {
      if (!failures.includes(`${relPath}: rule "${_hit.ruleName}"`)) {
        failures.push(`${relPath}: rule "${_hit.ruleName}"`);
      }
    }
  });
}

if (failures.length) {
  console.error('LINT FAILURES (rules from packs/platform-program/pack.json):\n' + failures.join('\n'));
  process.exit(1);
}
console.log('lint: OK — all rules sourced from platform-program lintRulePack (data, not code)');
