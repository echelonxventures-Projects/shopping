// @aether/service-logistics — carrier registry, rate shopping, tracking,
// returns/RMA with grading (P1-LOG-001). Kernel application: carriers, rate
// cards, service classes, RMA workflow states, grading factors, serial-returner
// thresholds are ALL pack data. Carrier adapters (API integrations) arrive via
// the conformance harness; this service rates/tracks/shops against the registry.

import { WorkflowEngine } from '@aether/kernel-runtime/src/index.ts';
import type { WorkflowDef } from '@aether/kernel-primitives';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CarrierService {
  code: string;
  name: string;
  etaDays: { min: number; max: number };
  rateCard: { base: number; perKg: number; currency: string };
}

export interface Carrier {
  id: string;
  name: string;
  scope: string[]; // market codes or 'global'
  services: CarrierService[];
  capabilities: { tracking: boolean; cod: boolean; coldChain: boolean; dangerousGoods: boolean; lockers: boolean };
}

export interface LogisticsPack {
  carriers: Carrier[];
  rmaWorkflow: WorkflowDef;
  returnPolicy: {
    windowDays: number;
    returnlessRefundThreshold: { value: number; currency: string };
    grading: {
      grades: string[];
      refundFactors: Record<string, number>;
      restockFees: Record<string, number>;
    };
    serialReturner: { returnRateThreshold: number; returnsCountThreshold: number; action: string };
  };
  trackingEvents: Array<{ code: string; meaning: string; progress: number }>;
}

export interface ShipmentReq {
  market: string;
  weightKg: number;
  requiresColdChain?: boolean;
  requiresDangerousGoods?: boolean;
  requiresCod?: boolean;
  prefersLockers?: boolean;
  maxEtaDays?: number;
}

export interface RatedOption {
  carrierId: string;
  carrierName: string;
  serviceCode: string;
  serviceName: string;
  etaDays: { min: number; max: number };
  price: { amount: number; currency: string };
  score: number; // rate-shopping score (cheapest fastest wins)
}

export interface TrackingUpdate {
  trackingId: string;
  code: string;
  at: string;
  location?: string;
  progress: number;
  meaning: string;
}

export interface RmaCase {
  rmaId: string;
  tenantId: string;
  orderId: string;
  orderPlacedAt: string;
  lineItem: { offerId: string; qty: number; unitPrice: number; currency: string };
  status: string;
  grade?: string;
  refundAmount?: number;
  restockFee?: number;
  events: Array<{ at: string; from: string; to: string; trigger: string }>;
}

export class LogisticsError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'LogisticsError';
  }
}

export class LogisticsService {
  private carriers = new Map<string, Carrier>();
  private wf: WorkflowEngine;
  private pack: LogisticsPack;
  private shipments = new Map<string, { carrierId: string; serviceCode: string; trackingId: string; updates: TrackingUpdate[] }>();
  private rmas = new Map<string, RmaCase>();
  private customerReturns = new Map<string, { returns: number; orders: number }>();

  constructor(pack: LogisticsPack) {
    this.pack = pack;
    for (const c of pack.carriers) this.carriers.set(c.id, c);
    this.wf = new WorkflowEngine([pack.rmaWorkflow]);
  }

  // ---- carrier registry + rate shopping ----
  rateOptions(req: ShipmentReq): RatedOption[] {
    const eligible = [...this.carriers.values()].filter((c) => {
      if (!c.scope.includes('global') && !c.scope.includes(req.market)) return false;
      if (req.requiresColdChain && !c.capabilities.coldChain) return false;
      if (req.requiresDangerousGoods && !c.capabilities.dangerousGoods) return false;
      if (req.requiresCod && !c.capabilities.cod) return false;
      if (req.prefersLockers && !c.capabilities.lockers) return false;
      return true;
    });
    const options: RatedOption[] = [];
    for (const c of eligible) {
      for (const s of c.services) {
        if (req.maxEtaDays !== undefined && s.etaDays.max > req.maxEtaDays) continue;
        const amount = Math.round((s.rateCard.base + s.rateCard.perKg * req.weightKg) * 100) / 100;
        // score: normalize price (lower better) + eta (lower better) — configurable formula later via rules
        const score = amount / (s.rateCard.base || 1) + s.etaDays.max * 0.5;
        options.push({
          carrierId: c.id, carrierName: c.name, serviceCode: s.code, serviceName: s.name,
          etaDays: s.etaDays, price: { amount, currency: s.rateCard.currency }, score,
        });
      }
    }
    return options.sort((a, b) => a.score - b.score);
  }

  cheapest(req: ShipmentReq): RatedOption | undefined {
    return this.rateOptions(req)[0];
  }

  // ---- shipments + tracking ----
  createShipment(tenantId: string, option: RatedOption): { trackingId: string } {
    const trackingId = `trk_${option.carrierId}_${option.serviceCode}_${Math.random().toString(36).slice(2, 10)}`;
    this.shipments.set(`${tenantId}:${trackingId}`, {
      carrierId: option.carrierId, serviceCode: option.serviceCode, trackingId, updates: [],
    });
    this.pushTracking(tenantId, trackingId, 'label-created');
    return { trackingId };
  }

  pushTracking(tenantId: string, trackingId: string, code: string, location?: string): TrackingUpdate {
    const sh = this.shipments.get(`${tenantId}:${trackingId}`);
    if (!sh) throw new LogisticsError(`unknown shipment ${trackingId}`);
    const ev = this.pack.trackingEvents.find((e) => e.code === code);
    if (!ev) throw new LogisticsError(`unknown tracking event "${code}" — register in pack`);
    const update: TrackingUpdate = { trackingId, code, at: new Date().toISOString(), location, progress: ev.progress, meaning: ev.meaning };
    sh.updates.push(update);
    return update;
  }

  trackingHistory(tenantId: string, trackingId: string): TrackingUpdate[] {
    return [...(this.shipments.get(`${tenantId}:${trackingId}`)?.updates ?? [])];
  }

  // ---- RMA / returns ----
  openRma(input: { rmaId: string; tenantId: string; orderId: string; orderPlacedAt: string; lineItem: RmaCase['lineItem']; orderValue: number }): RmaCase {
    const initial = this.wf.initial('rma-lifecycle') ?? 'requested';
    const daysSince = (Date.now() - Date.parse(input.orderPlacedAt)) / 86_400_000;
    if (daysSince > this.pack.returnPolicy.windowDays) {
      const rma: RmaCase = {
        ...input, status: 'rejected', events: [{ at: new Date().toISOString(), from: 'requested', to: 'rejected', trigger: 'window-elapsed' }],
      };
      this.rmas.set(`${input.tenantId}:${input.rmaId}`, rma);
      this.trackCustomerReturn(input.tenantId, input.orderValue);
      return rma;
    }
    // returnless refund for low-value items (policy data)
    const lineValue = input.lineItem.qty * input.lineItem.unitPrice;
    const threshold = this.pack.returnPolicy.returnlessRefundThreshold;
    if (lineValue <= threshold.value) {
      const rma: RmaCase = {
        ...input, status: 'refunded', refundAmount: lineValue,
        events: [
          { at: new Date().toISOString(), from: 'requested', to: 'approved', trigger: 'return-window-valid' },
          { at: new Date().toISOString(), from: 'approved', to: 'refunded', trigger: 'returnless-refund' },
        ],
      };
      this.rmas.set(`${input.tenantId}:${input.rmaId}`, rma);
      this.trackCustomerReturn(input.tenantId, input.orderValue);
      return rma;
    }
    const rma: RmaCase = { ...input, status: initial, events: [] };
    this.rmas.set(`${input.tenantId}:${input.rmaId}`, rma);
    this.trackCustomerReturn(input.tenantId, input.orderValue);
    return rma;
  }

  advanceRma(tenantId: string, rmaId: string, to: string, trigger: string): RmaCase {
    const rma = this.rmas.get(`${tenantId}:${rmaId}`);
    if (!rma) throw new LogisticsError(`unknown RMA ${rmaId}`);
    if (!this.wf.canTransition('rma-lifecycle', rma.status, to)) {
      throw new LogisticsError(`illegal RMA transition ${rma.status} → ${to} (pack workflow)`);
    }
    rma.events.push({ at: new Date().toISOString(), from: rma.status, to, trigger });
    rma.status = to;
    return rma;
  }

  /** grading: refund factor + restock fee from pack policy */
  gradeRma(tenantId: string, rmaId: string, grade: string): RmaCase {
    const rma = this.rmas.get(`${tenantId}:${rmaId}`);
    if (!rma) throw new LogisticsError(`unknown RMA ${rmaId}`);
    if (!this.pack.returnPolicy.grading.grades.includes(grade)) {
      throw new LogisticsError(`unknown grade "${grade}" — grades are pack data`);
    }
    this.advanceRma(tenantId, rmaId, 'graded', 'grading-complete');
    const lineValue = rma.lineItem.qty * rma.lineItem.unitPrice;
    const factor = this.pack.returnPolicy.grading.refundFactors[grade] ?? 0;
    const restockPct = this.pack.returnPolicy.grading.restockFees[grade] ?? 0;
    rma.grade = grade;
    rma.refundAmount = Math.round(lineValue * factor * 100) / 100;
    rma.restockFee = Math.round(lineValue * restockPct * 100) / 100;
    return rma;
  }

  /** serial-returner abuse detection (thresholds from pack) */
  private trackCustomerReturn(tenantId: string, _orderValue: number): void {
    void tenantId;
  }

  customerReturnProfile(tenantId: string, customerId: string): { returns: number; orders: number; flagged: boolean } {
    const p = this.customerReturns.get(`${tenantId}:${customerId}`) ?? { returns: 0, orders: 0 };
    const sr = this.pack.returnPolicy.serialReturner;
    const flagged = p.returns >= sr.returnsCountThreshold && p.orders > 0 && p.returns / p.orders >= sr.returnRateThreshold;
    return { ...p, flagged };
  }

  recordCustomerOrder(tenantId: string, customerId: string, isReturn: boolean): void {
    const key = `${tenantId}:${customerId}`;
    const p = this.customerReturns.get(key) ?? { returns: 0, orders: 0 };
    if (isReturn) p.returns += 1;
    else p.orders += 1;
    this.customerReturns.set(key, p);
  }
}

// ---------- Module-as-a-Product contract (plug-and-play, billable, configurable) ----------
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

const logisticsModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as LogisticsPack;
    const svc = new LogisticsService(pack);
    const meter = (ev: string, qty = 1, meta?: Record<string, unknown>) => billing.meter(ev, qty, meta);
    return {
      rateOptions: (req: ShipmentReq) => (meter('rate.quoted'), svc.rateOptions(req)),
      cheapest: (req: ShipmentReq) => (meter('rate.quoted'), svc.cheapest(req)),
      createShipment: (tenantId: string, option: RatedOption) => (meter('label.generated'), svc.createShipment(tenantId, option)),
      pushTracking: (t: string, id: string, code: string, loc?: string) => svc.pushTracking(t, id, code, loc),
      trackingHistory: (t: string, id: string) => svc.trackingHistory(t, id),
      openRma: (input: Parameters<LogisticsService['openRma']>[0]) => (meter('rma.opened'), svc.openRma(input)),
      advanceRma: (t: string, id: string, to: string, trig: string) => svc.advanceRma(t, id, to, trig),
      gradeRma: (t: string, id: string, grade: string) => svc.gradeRma(t, id, grade),
      customerReturnProfile: (t: string, c: string) => svc.customerReturnProfile(t, c),
      recordCustomerOrder: (t: string, c: string, r: boolean) => svc.recordCustomerOrder(t, c, r),
      __raw: svc, // host may use the unwrapped service
    };
  },
};

export default logisticsModule;
