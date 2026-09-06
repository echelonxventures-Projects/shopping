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
const rules = (pack.lintRulePack ?? [])
  // structural product rules are enforced by the dedicated block below, not the regex engine
  .filter((r) => !r.name.startsWith('everything-is-a-product'))
  .map((r) => ({
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

// ---- EVERYTHING IS A PRODUCT: structural product-conformance checks (rules in pack) ----
const productRules = (pack.lintRulePack ?? []).filter((r) => r.name.startsWith('everything-is-a-product'));
const servicesDir = join(root, 'services');
if (existsSync(servicesDir)) {
  for (const rule of productRules) {
    const check = rule.decisionTable.find((row) => row.then)?.then?.check;
    for (const svc of readdirSync(servicesDir)) {
      const svcPath = join(servicesDir, svc);
      if (!statSync(svcPath).isDirectory()) continue;
      if (check === 'requires-module-json') {
        const src = join(svcPath, 'src/index.ts');
        if (existsSync(src) && !existsSync(join(svcPath, 'module.json'))) {
          failures.push(`EVERYTHING-IS-A-PRODUCT: ${svc} ships code but no module.json product manifest (rule "${rule.name}")`);
        }
      }
      if (check === 'requires-bundled-packs') {
        try {
          const manifest = JSON.parse(readFileSync(join(svcPath, 'module.json'), 'utf8'));
          for (const p of manifest.packs ?? []) {
            if (!existsSync(join(svcPath, p))) {
              failures.push(`EVERYTHING-IS-A-PRODUCT: ${svc} manifest references pack "${p}" that is not bundled inside the module`);
            }
          }
          if (!manifest.billing?.meterableEvents) {
            failures.push(`EVERYTHING-IS-A-PRODUCT: ${svc} product must declare billable meterableEvents`);
          }
          if (!manifest.publicApi?.length) {
            failures.push(`EVERYTHING-IS-A-PRODUCT: ${svc} product must expose a publicApi surface`);
          }
        } catch (err) {
          failures.push(`EVERYTHING-IS-A-PRODUCT: ${svc} has invalid module.json (${err.message})`);
        }
      }
      if (check === 'requires-module-default-export') {
        const src = join(svcPath, 'src/index.ts');
        if (existsSync(src)) {
          const code = readFileSync(src, 'utf8');
          if (!/export default \w+Module/.test(code)) {
            failures.push(`EVERYTHING-IS-A-PRODUCT: ${svc} must default-export its AetherModule contract (plug-and-play law)`);
          }
        }
      }
    }
  }
}

if (failures.length) {
  console.error('LINT FAILURES (rules from packs/platform-program/pack.json):\n' + failures.join('\n'));
  process.exit(1);
}
console.log('lint: OK — all rules sourced from platform-program lintRulePack (data, not code); every service is a product');
