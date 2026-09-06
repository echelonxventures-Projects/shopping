// §16.7 projection — generates the register section in docs/PLATFORM-PLAN.md from
// packs/platform-program (work-items.jsonl). The doc table is a projection, never hand-edited.
// Usage: npm run register:project
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { ProgramStore, loadPack, projectRegisterToDoc } = await import(
  '@aether/kernel-program/src/index.ts'
);

const pack = loadPack(join(root, 'packs/platform-program/pack.json'));
const store = new ProgramStore(pack);
store.attachJsonl(join(root, 'packs/platform-program/work-items.jsonl'));

const counts = {};
for (const item of store.items.values()) counts[item.status] = (counts[item.status] ?? 0) + 1;

const md = [
  '### 16.7 Program Data Projection (generated from packs/platform-program — do not hand-edit)',
  '',
  'Per the ECR-recursion doctrine, the build program itself is kernel data: work items are `WorkItem` entity instances; TIDs are U²IDs from the `tid-scheme` (structured ID scheme); dependencies are `depends-on` relationships; statuses are `workitem-lifecycle` workflow states guarded by lint/tests green. §16.1–16.6 tables below remain the historical/human projection of the same program — this section is the machine-synced source of truth for status.',
  '',
  '| TID | Title | Workstream | Status | Acceptance |',
  '|---|---|---|---|---|',
  ...[...store.items.values()]
    .sort((a, b) => a.tid.localeCompare(b.tid))
    .map((i) => `| ${i.tid} | ${i.title} | ${i.workstream} | ${i.status} | ${i.acceptance} |`),
  '',
  `**Status counts:** ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')} · total ${store.items.size}`,
  '',
  `*Generated ${new Date().toISOString()} by \`npm run register:project\` · source: packs/platform-program/{pack.json, work-items.jsonl}*`,
].join('\n');

const docPath = join(root, 'docs/PLATFORM-PLAN.md');
let text = readFileSync(docPath, 'utf8');
const marker = '### 16.7 Program Data Projection';
if (!text.includes(marker)) {
  const snapshot = '**Register status snapshot';
  const idx = text.indexOf(snapshot);
  if (idx === -1) throw new Error('Snapshot paragraph not found for first insertion');
  text = text.slice(0, idx) + md + '\n\n' + text.slice(idx);
} else {
  const start = text.indexOf(marker);
  const endMarker = '*Generated';
  const endIdx = text.indexOf(endMarker, start);
  const end = text.indexOf('\n', endIdx) + 1;
  text = text.slice(0, start) + md + '\n' + text.slice(end).replace(/^\n+/, '');
}
writeFileSync(docPath, text);
console.log(`projected ${store.items.size} work items to §16.7`);
