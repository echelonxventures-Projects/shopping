// Register-consistency gate: §16.1-16.6 historical tables must never contradict
// the live work-items data (§16.7 source). Any TID marked Done in data but Open
// in doc tables (or vice versa) fails CI. Living-Document Protocol enforcement.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const items = JSON.parse(readFileSync(join(root, 'packs/platform-program/work-items.jsonl'), 'utf8'));
const doc = readFileSync(join(root, 'docs/PLATFORM-PLAN.md'), 'utf8');

const statusByTid = new Map(items.map((i) => [i.tid, i.status]));
const failures = [];
for (const line of doc.split('\n')) {
  const m = line.match(/^\| (P[0-4X]-[A-Z]{3}-\d{3}) \|/);
  if (!m) continue;
  const tid = m[1];
  const live = statusByTid.get(tid);
  if (live === undefined) continue;
  if (line.includes('| Done |') && live !== 'Done') {
    failures.push(`${tid}: doc says Done but data says ${live}`);
  }
  if (line.includes('| Open |') && live === 'Done') {
    failures.push(`${tid}: doc says Open but data says Done (stale WBS row — run scripts/fix-wbs-rows)`);
  }
}
if (failures.length) {
  console.error('REGISTER CONSISTENCY FAILURES:\n' + failures.join('\n'));
  process.exit(1);
}
console.log(`register-consistency: OK (${statusByTid.size} tracked TIDs agree between §16 tables and work-items data)`);
