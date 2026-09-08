// One-command repair: reconciles historical WBS table rows against the live register.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const items = JSON.parse(readFileSync(join(root, 'packs/platform-program/work-items.jsonl'), 'utf8'));
const done = new Set(items.filter((i) => i.status === 'Done').map((i) => i.tid));
const docPath = join(root, 'docs/PLATFORM-PLAN.md');
const lines = readFileSync(docPath, 'utf8').split('\n');
let fixed = 0;
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\| (P[0-4X]-[A-Z]{3}-\d{3}) \|/);
  if (m && done.has(m[1]) && lines[i].includes('| Open |')) {
    lines[i] = lines[i].replace('| Open |', '| Done ✓ |');
    fixed++;
  }
}
writeFileSync(docPath, lines.join('\n'));
console.log(`reconciled ${fixed} rows`);
