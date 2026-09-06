// @aether/kernel-runtime — Rule + Workflow engines (P0-KRN-005 runtime half).
// Tier-0 invariant code: generic evaluation/transition mechanics only.
// All actual rules/workflows/lint-policies are registry data — never code here.

import {
  isCurrent,
  type RuleDef,
  type WorkflowDef,
  type ContextFrame,
  type Bitemporal,
} from '@aether/kernel-primitives';

export type RuleMatch = {
  ruleId: string;
  ruleName: string;
  priority: number;
  outputs: Record<string, unknown>;
};

export interface Evaluatable {
  id: string;
  name: string;
  priority: number;
  when: Array<{ field: string; equals?: unknown; in?: unknown[]; gte?: unknown; lte?: unknown; matches?: string }>;
  then: Record<string, unknown>;
  validFrom: string;
  validTo: string | null;
  recordedAt: string;
}

export function ruleDefToEvaluatable(def: RuleDef): Evaluatable {
  return {
    id: def.id,
    name: def.name,
    priority: def.priority,
    when: def.decisionTable.map((row) => row as Evaluatable['when'][number]),
    then: (def.decisionTable as Array<{ then?: Record<string, unknown> }>).find((r) => r.then)?.then ?? {},
    validFrom: def.validFrom,
    validTo: def.validTo,
    recordedAt: def.recordedAt,
  };
}

function conditionMet(cond: Evaluatable['when'][number], fact: Record<string, unknown>): boolean {
  const value = fact[cond.field];
  if (cond.equals !== undefined && value !== cond.equals) return false;
  if (cond.in !== undefined && !cond.in.includes(value)) return false;
  if (cond.gte !== undefined && !(Number(value) >= Number(cond.gte))) return false;
  if (cond.lte !== undefined && !(Number(value) <= Number(cond.lte))) return false;
  if (cond.matches !== undefined && !(new RegExp(cond.matches).test(String(value)))) return false;
  return true;
}

export class RuleEngine {
  private rules: Evaluatable[];
  constructor(rules: Evaluatable[]) {
    this.rules = rules;
  }

  evaluate(fact: Record<string, unknown>, frame?: ContextFrame, at?: string): RuleMatch[] {
    const now = at ?? frame?.atTime ?? new Date().toISOString();
    const hits = this.rules
      .filter((r) => isCurrent(r as Bitemporal, now))
      .filter((r) => r.when.every((c) => conditionMet(c, fact)))
      .sort((a, b) => b.priority - a.priority);
    return hits.map((r) => ({ ruleId: r.id, ruleName: r.name, priority: r.priority, outputs: r.then }));
  }

  evaluateAll(fact: Record<string, unknown>, at?: string): RuleMatch[] {
    return this.evaluate(fact, undefined, at);
  }
}

export class WorkflowEngine {
  private defs: WorkflowDef[];
  constructor(defs: WorkflowDef[]) {
    this.defs = defs;
  }

  def(name: string, at?: string): WorkflowDef | undefined {
    return this.defs.find((d) => d.name === name && isCurrent(d, at));
  }

  canTransition(workflowName: string, from: string, to: string, fact?: Record<string, unknown>, at?: string): boolean {
    const def = this.def(workflowName, at);
    if (!def) return false;
    const t = def.transitions.find((tr) => tr.from === from && tr.to === to);
    if (!t) return false;
    if (!t.guardRules || t.guardRules.length === 0) return true;
    if (!fact) return false;
    return t.guardRules.every((g) => fact[`guard:${g}`] === true);
  }

  initial(workflowName: string, at?: string): string | undefined {
    return this.def(workflowName, at)?.initial;
  }
}
