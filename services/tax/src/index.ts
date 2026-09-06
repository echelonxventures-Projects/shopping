// @aether/service-tax — Tax Engine v2 (P1-TAX-001).
// Kernel application: ALL rates/modes/jurisdictions are bitemporal rule-pack data.
// Engine mechanics (Tier-0): rule evaluation, priority resolution, point-in-time
// rates (bitemporal — "what rate applied at transaction time"), inclusive vs
// exclusive math, facilitator-liability flagging, and per-line explainability
// for the Decision-Explainability Service (§10).

import { RuleEngine, type RuleMatch } from '@aether/kernel-runtime/src/index.ts';
import type { RuleDef } from '@aether/kernel-primitives';

export interface TaxFact {
  market: string;
  region?: string;
  audience?: string;
  offerKind?: string; // '1p' | '3p-marketplace' | ...
  vatIdValid?: boolean;
  hsCode?: string;
}

export interface TaxedLine {
  lineId: string;
  netAmount: number; // exclusive-mode base; inclusive-mode gross
}

export interface TaxLineResult {
  lineId: string;
  rate: number;
  jurisdiction: string;
  mode: 'inclusive' | 'exclusive';
  reverseCharge: boolean;
  facilitatorLiable: boolean;
  taxAmount: number;
  net: number;
  gross: number;
  explain: string[];
  ruleId?: string;
}

export interface TaxResult {
  lines: TaxLineResult[];
  totalTax: number;
  totalGross: number;
  displayMode: 'inclusive' | 'exclusive';
  atTime: string;
}

function toEvaluatable(r: RuleDef) {
  return {
    id: r.id, name: r.name, priority: r.priority,
    when: r.decisionTable.filter((row) => 'field' in row) as never,
    then: (r.decisionTable.find((row) => 'then' in row) as { then?: Record<string, unknown> })?.then ?? {},
    validFrom: r.validFrom, validTo: r.validTo, recordedAt: r.recordedAt,
  };
}

export class TaxEngine {
  private rules: RuleEngine;

  constructor(taxRules: RuleDef[]) {
    this.rules = new RuleEngine(taxRules.map(toEvaluatable));
  }

  /** one line: highest-priority matching rule wins (bitemporal as-of transaction time) */
  computeLine(fact: TaxFact, line: TaxedLine, atTime?: string): TaxLineResult {
    const at = atTime ?? new Date().toISOString();
    const hits: RuleMatch[] = this.rules.evaluateAll(
      { fact: 'tax', market: fact.market, region: fact.region ?? null, audience: fact.audience ?? 'b2c', offerKind: fact.offerKind ?? '1p', vatIdValid: fact.vatIdValid ?? false, hsCode: fact.hsCode ?? null },
      { atTime: at }
    );
    const winner = hits[0]; // RuleEngine sorts by priority desc
    const rate = winner ? Number(winner.outputs['rate'] ?? 0) : 0;
    const mode = (winner?.outputs['mode'] as 'inclusive' | 'exclusive') ?? 'exclusive';
    const jurisdiction = String(winner?.outputs['jurisdiction'] ?? fact.market);
    const reverseCharge = winner?.outputs['reverseCharge'] === true;
    const facilitatorLiable = winner?.outputs['facilitatorLiable'] === true;

    let taxAmount: number, net: number, gross: number;
    if (mode === 'inclusive') {
      gross = line.netAmount; // inclusive input is gross
      net = Math.round((gross / (1 + rate)) * 100) / 100;
      taxAmount = Math.round((gross - net) * 100) / 100;
    } else {
      net = line.netAmount;
      taxAmount = Math.round(net * rate * 100) / 100;
      gross = Math.round((net + taxAmount) * 100) / 100;
    }
    if (reverseCharge) taxAmount = 0;

    return {
      lineId: line.lineId,
      rate, jurisdiction, mode, reverseCharge, facilitatorLiable,
      taxAmount, net, gross,
      explain: [
        winner
          ? `rule ${winner.ruleName} (${jurisdiction}) rate=${rate} mode=${mode}${facilitatorLiable ? ' [facilitator-liable]' : ''}${reverseCharge ? ' [reverse-charge]' : ''} as-of ${at}`
          : `no tax rule matched market=${fact.market} — 0 tax`,
      ],
      ruleId: winner?.ruleId,
    };
  }

  compute(fact: TaxFact, lines: TaxedLine[], atTime?: string): TaxResult {
    const at = atTime ?? new Date().toISOString();
    const results = lines.map((l) => this.computeLine(fact, l, at));
    return {
      lines: results,
      totalTax: Math.round(results.reduce((s, r) => s + r.taxAmount, 0) * 100) / 100,
      totalGross: Math.round(results.reduce((s, r) => s + r.gross, 0) * 100) / 100,
      displayMode: results[0]?.mode ?? 'exclusive',
      atTime: at,
    };
  }

  /** bitemporal rate reconstruction: what rate applied at historical T? */
  rateAt(fact: TaxFact, atTime: string): { rate: number; ruleName?: string } {
    const hits = this.rules.evaluateAll(
      { fact: 'tax', market: fact.market, region: fact.region ?? null, audience: fact.audience ?? 'b2c', offerKind: fact.offerKind ?? '1p', vatIdValid: fact.vatIdValid ?? false },
      atTime
    );
    return { rate: hits[0] ? Number(hits[0].outputs['rate'] ?? 0) : 0, ruleName: hits[0]?.ruleName };
  }
}
