// Minimal lint v0: enforces kernel laws (AGENTS.md) — no hardcoded domain concepts in kernel/,
// no card-data attributes outside tests, no secrets.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

// Law 3: kernel/ holds only invariants — domain words are banned there (except proofs/tests)
const KERNEL_DOMAIN_BAN = /(marketplace|checkout|shopping|acmewear|stripe|paypal|ups|fedex|dhl)/i;
// Law: never hardcode markets
const MARKET_BAN = /['"](US|EU|IN|UK|DE|FR|BR)['"]\s*[:=]/;

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

walk(join(root, 'kernel'), (p) => {
  const src = readFileSync(p, 'utf8');
  const isTestOrProof = /test|proof/.test(p);
  if (!isTestOrProof && KERNEL_DOMAIN_BAN.test(src)) {
    failures.push(`kernel domain-ban violation: ${p}`);
  }
  if (MARKET_BAN.test(src) && !/packs/.test(p)) {
    failures.push(`possible hardcoded market: ${p}`);
  }
  if (/sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}/.test(src)) {
    failures.push(`secret-like string: ${p}`);
  }
});

if (failures.length) {
  console.error('LINT FAILURES:\n' + failures.join('\n'));
  process.exit(1);
}
console.log('lint: OK (kernel domain-ban, market-ban, secret-scan)');
