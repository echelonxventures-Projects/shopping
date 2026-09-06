// @aether/kernel-program — the build program as kernel data (doctrine recursion).
// WorkItems are entity instances; TIDs are U²IDs (structured scheme from pack config);
// dependencies are relationships; statuses are workflow transitions (guards evaluated);
// the §16 doc table is a *generated projection* of this data. No hand-edited rows.
// Generic Tier-1 platform application — no project-specific logic in this code.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UidAllocator, UDictionary } from '@aether/kernel-uid/src/index.ts';
import { RuleEngine, WorkflowEngine } from '@aether/kernel-runtime/src/index.ts';
import type { EntityInstance, WorkflowDef, RuleDef } from '@aether/kernel-primitives';

export interface WorkItem {
  tid: string;
  title: string;
  phase: string;
  workstream: string;
  status: string;
  dependencies: string[];
  acceptance: string;
}

export interface ProgramPack {
  entityTypes: unknown[];
  relationshipTypes: unknown[];
  workflows: WorkflowDef[];
  idSchemes: Array<Record<string, unknown>>;
  lintRulePack?: RuleDef[];
  workItems?: Array<WorkItem & { sequence: number }>;
}

export function loadPack(packPath: string): ProgramPack {
  return JSON.parse(readFileSync(packPath, 'utf8')) as ProgramPack;
}

export class ProgramStore {
  items = new Map<string, WorkItem>();
  private uid: UidAllocator;
  private dict = new UDictionary();
  private wf: WorkflowEngine;
  private rules: RuleEngine;
  private seq = 0;

  constructor(pack: ProgramPack) {
    this.uid = new UidAllocator();
    for (const scheme of pack.idSchemes) this.uid.registerScheme(scheme as never);
    this.wf = new WorkflowEngine(pack.workflows);
    this.rules = new RuleEngine(
      (pack.lintRulePack ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        priority: r.priority,
        when: r.decisionTable.filter((row) => 'field' in row) as never,
        then: {},
        validFrom: r.validFrom,
        validTo: r.validTo,
        recordedAt: r.recordedAt,
      }))
    );
    for (const w of pack.workItems ?? []) this.add(w);
  }

  attachJsonl(jsonlPath: string): void {
    const raw = readFileSync(jsonlPath, 'utf8').trim();
    let items: Array<Record<string, unknown>>;
    if (raw.startsWith('[')) {
      items = JSON.parse(raw) as Array<Record<string, unknown>>;
    } else {
      items = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    }
    for (const w of items) {
      this.seq = Math.max(this.seq, Number(String(w.tid ?? '').split('-')[2] ?? 0));
      if (!this.items.has(w.tid as string)) this.add(w as never);
      else this.items.set(w.tid as string, { ...this.items.get(w.tid as string)!, ...w } as WorkItem);
    }
  }

  add(w: Partial<WorkItem> & { title: string; phase: string; workstream: string; acceptance: string }): WorkItem {
    this.seq++;
    const tid =
      w.tid ??
      this.uid.allocate('tid-scheme', 'WorkItem', {
        phase: w.phase,
        workstream: w.workstream,
        sequence: this.seq,
      }).value;
    const item: WorkItem = {
      tid,
      title: w.title,
      phase: w.phase,
      workstream: w.workstream,
      status: w.status ?? this.wf.initial('workitem-lifecycle') ?? 'Open',
      dependencies: w.dependencies ?? [],
      acceptance: w.acceptance,
    };
    this.items.set(tid, item);
    this.dict.register(tid, tid, 'WorkItem', 1);
    return item;
  }

  transition(tid: string, to: string, guards: Record<string, boolean> = {}): WorkItem {
    const item = this.items.get(tid);
    if (!item) throw new Error(`Unknown TID ${tid}`);
    const fact = Object.fromEntries(Object.entries(guards).map(([k, v]) => [`guard:${k}`, v]));
    if (!this.wf.canTransition('workitem-lifecycle', item.status, to, fact)) {
      throw new Error(`Workflow guard rejected ${tid}: ${item.status} → ${to} (guards: ${JSON.stringify(guards)})`);
    }
    item.status = to;
    return item;
  }

  dependencyReady(tid: string): boolean {
    const item = this.items.get(tid)!;
    return item.dependencies.every((d) => this.items.get(d)?.status === 'Done');
  }

  lintFact(fact: Record<string, unknown>): Array<{ ruleName: string }> {
    return this.rules.evaluateAll(fact).map((m) => ({ ruleName: m.ruleName }));
  }

  projectMarkdown(): string {
    const rows = [...this.items.values()]
      .sort((a, b) => a.tid.localeCompare(b.tid))
      .map((i) => `| ${i.tid} | ${i.title} | ${i.workstream} | ${i.status} | ${i.acceptance} |`);
    return [
      '### 16.7 Program Data Projection (generated from packs/platform-program — do not hand-edit)',
      '',
      '| TID | Title | Workstream | Status | Acceptance |',
      '|---|---|---|---|---|',
      ...rows,
      '',
      `*Generated ${new Date().toISOString()} · source of truth: packs/platform-program/pack.json + work-items.jsonl*`,
    ].join('\n');
  }
}

export function projectRegisterToDoc(docPath: string, md: string): void {
  const text = readFileSync(docPath, 'utf8');
  const marker = '### 16.7 Program Data Projection';
  const idx = text.indexOf(marker);
  if (idx === -1) throw new Error('Projection marker not found in doc');
  const endMarker = '*Generated';
  const endIdx = text.indexOf(endMarker, idx);
  const end = endIdx === -1 ? text.length : text.indexOf('\n', endIdx) + 1;
  writeFileSync(docPath, text.slice(0, idx) + md + '\n' + text.slice(end).replace(/^\n/, ''));
}

export const programRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const packPath = join(programRoot, 'packs/platform-program/pack.json');

