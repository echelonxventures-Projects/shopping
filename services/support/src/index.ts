// @aether/service-support — tickets, AI triage, SLA clocks, decision-explainability
// (P1-SUP-001). Kernel application BORN AS A MODULE: workflow + SLA tiers +
// triage rules are pack data; the explainability journal reconstructs "why"
// for any charge/refund/fee decision by joining bitemporal records.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkflowEngine, RuleEngine } from '@aether/kernel-runtime/src/index.ts';
import type { WorkflowDef, RuleDef } from '@aether/kernel-primitives';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface SupportPack {
  workflows: WorkflowDef[];
  slaTiers: Array<{ severity: string; firstResponseMinutes: number; resolutionMinutes: number }>;
  triageRules: RuleDef[];
}

export interface Ticket {
  ticketId: string;
  tenantId: string;
  customerId: string;
  subject: string;
  text: string;
  status: string;
  severity?: string;
  queue?: string;
  category?: string;
  autoResolveAction?: string;
  createdAt: string;
  firstResponseDueAt?: string;
  resolutionDueAt?: string;
  events: Array<{ at: string; from: string; to: string; trigger: string }>;
}

export interface TriageResult {
  severity: string;
  queue: string;
  category: string;
  autoResolve?: string;
  ruleName: string;
  explain: string[];
}

/** Decision-Explainability journal — "why was I charged this" for any decision */
export interface ExplainEntry {
  subject: string; // e.g. 'order:ord_123:line:0'
  decisionType: string; // 'tax' | 'fee' | 'price' | 'refund' | 'buybox' | ...
  at: string;
  summary: string;
  ruleTrails: Array<{ source: string; detail: string }>; // joins rule pack + context frame
  contextFrame: Record<string, unknown>; // tenant/market/world/time resolved at decision time
}

export class SupportService {
  private wf: WorkflowEngine;
  private triageEngine: RuleEngine;
  private pack: SupportPack;
  private tickets = new Map<string, Ticket>();
  private explainJournal: ExplainEntry[] = [];
  private seq = 0;

  constructor(pack: SupportPack) {
    this.pack = pack;
    this.wf = new WorkflowEngine(pack.workflows);
    this.triageEngine = new RuleEngine(
      pack.triageRules.map((r) => ({
        id: r.id, name: r.name, priority: r.priority,
        when: r.decisionTable.filter((row) => 'field' in row) as never,
        then: (r.decisionTable.find((row) => 'then' in row) as { then?: Record<string, unknown> })?.then ?? {},
        validFrom: r.validFrom, validTo: r.validTo, recordedAt: r.recordedAt,
      }))
    );
  }

  /** open a ticket: workflow initial state + SLA clock from severity tier */
  open(tenantId: string, customerId: string, subject: string, text: string, severity?: string): Ticket {
    const initial = this.wf.initial('ticket-lifecycle') ?? 'new';
    const t: Ticket = {
      ticketId: `tkt-${++this.seq}`, tenantId, customerId, subject, text,
      status: initial, createdAt: new Date().toISOString(), events: [],
    };
    this.tickets.set(`${tenantId}:${t.ticketId}`, t);
    if (severity) this.applySla(t, severity);
    return t;
  }

  /** AI triage: rule-pack classification w/ explainability */
  triage(tenantId: string, ticketId: string): TriageResult {
    const t = this.get(tenantId, ticketId);
    const hits = this.triageEngine.evaluateAll({ fact: 'triage', text: t.text, subject: t.subject });
    const winner = hits[0]!;
    const severity = String(winner.outputs['severity'] ?? 'normal');
    const result: TriageResult = {
      severity,
      queue: String(winner.outputs['queue'] ?? 'general'),
      category: String(winner.outputs['category'] ?? 'general'),
      autoResolve: winner.outputs['autoResolve'] as string | undefined,
      ruleName: winner.ruleName,
      explain: [`triage rule "${winner.ruleName}" (priority ${winner.priority}) matched`],
    };
    t.severity = severity;
    t.queue = result.queue;
    t.category = result.category;
    t.autoResolveAction = result.autoResolve;
    this.applySla(t, severity);
    this.advance(tenantId, ticketId, 'triaged', 'triage-complete');
    return result;
  }

  private applySla(t: Ticket, severity: string): void {
    const tier = this.pack.slaTiers.find((s) => s.severity === severity);
    if (!tier) return;
    const now = Date.now();
    t.severity = severity;
    t.firstResponseDueAt = new Date(now + tier.firstResponseMinutes * 60_000).toISOString();
    t.resolutionDueAt = new Date(now + tier.resolutionMinutes * 60_000).toISOString();
  }

  get(tenantId: string, ticketId: string): Ticket {
    const t = this.tickets.get(`${tenantId}:${ticketId}`);
    if (!t) throw new Error(`Ticket ${ticketId} not found`);
    return t;
  }

  advance(tenantId: string, ticketId: string, to: string, trigger: string): Ticket {
    const t = this.get(tenantId, ticketId);
    if (!this.wf.canTransition('ticket-lifecycle', t.status, to)) {
      throw new Error(`illegal ticket transition ${t.status} → ${to}`);
    }
    t.events.push({ at: new Date().toISOString(), from: t.status, to, trigger });
    t.status = to;
    return t;
  }

  slaBreached(tenantId: string, ticketId: string, at = new Date().toISOString()): { firstResponse: boolean; resolution: boolean } {
    const t = this.get(tenantId, ticketId);
    return {
      firstResponse: !!t.firstResponseDueAt && t.firstResponseDueAt < at && !t.events.some((e) => e.trigger === 'agent-assigned'),
      resolution: !!t.resolutionDueAt && t.resolutionDueAt < at && !['resolved', 'closed'].includes(t.status),
    };
  }

  /** Decision-Explainability: record + query "why" for any platform decision */
  recordExplain(entry: Omit<ExplainEntry, 'at'> & { at?: string }): ExplainEntry {
    const full: ExplainEntry = { ...entry, at: entry.at ?? new Date().toISOString() };
    this.explainJournal.push(full);
    return full;
  }

  explain(subject: string): ExplainEntry[] {
    return this.explainJournal.filter((e) => e.subject === subject);
  }

  /** reconstruct an order-line explanation from tax/fee/buybox services (bitemporal join) */
  explainCharge(subject: string, decisionType: string): ExplainEntry[] {
    return this.explainJournal.filter((e) => e.subject === subject && e.decisionType === decisionType);
  }
}

const supportModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as SupportPack;
    const svc = new SupportService(pack);
    const meter = (ev: string) => billing.meter(ev);
    return {
      open: (t: string, c: string, s: string, x: string, sev?: string) => (meter('ticket.opened'), svc.open(t, c, s, x, sev)),
      triage: (t: string, id: string) => (meter('ticket.triaged'), svc.triage(t, id)),
      get: (t: string, id: string) => svc.get(t, id),
      advance: (t: string, id: string, to: string, trig: string) => (meter('ticket.transitioned'), svc.advance(t, id, to, trig)),
      slaBreached: (t: string, id: string) => svc.slaBreached(t, id),
      recordExplain: (e: Parameters<SupportService['recordExplain']>[0]) => (meter('explain.recorded'), svc.recordExplain(e)),
      explain: (s: string) => svc.explain(s),
      explainCharge: (s: string, d: string) => svc.explainCharge(s, d),
      __raw: svc,
    };
  },
};

export default supportModule;
