// @aether/service-pos — unified commerce / POS as a product (P1-UCA-001).
// Module-as-a-Product: scan formats, tender rules, register policy, BOPIS hold
// windows and offline queue policy are ALL pack data. Offline-first: sales are
// captured locally and queued; the queue replays on reconnect with a pack
// conflict strategy (price-drift protection included). RFID/barcode parsing is
// prefix/length config — no scanner vendor is binding (Total Agnosticism).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

// ---------- pack shapes ----------
export interface ScanFormat {
  id: string;
  kind: 'rfid' | 'barcode' | 'qr' | (string & {});
  prefixes: string[];
  length: number | null;
  payload: 'epc' | 'gtin' | 'sku' | 'badge' | (string & {});
  caseInsensitive: boolean;
}

export interface TenderType {
  id: string;
  kind: 'cash' | 'card' | 'wallet' | 'stored-value' | (string & {});
  changeAllowed: boolean;
  requiresAuth?: boolean;
  settleOnDelivery?: boolean;
  roundingMinor?: number;
}

export interface PosPack {
  pack: { name: string; version: string };
  scanFormats: ScanFormat[];
  scanPolicy: { rejectUnknownFormat: boolean; dedupeWithinSeconds: number; maxScansPerSecond: number };
  tenderTypes: TenderType[];
  registerPolicy: {
    openingFloatDefault: number;
    varianceToleranceMinor: number;
    receiptSeriesPrefix: string;
    maxOpenSessionsPerStore: number;
    requireFloatDeclaration: boolean;
  };
  bopisPolicy: { holdHours: number; pickupCodeLength: number; verifyIdForHighValue: boolean; highValueThreshold: number };
  offlinePolicy: { maxQueuedActions: number; conflictStrategy: string; priceDriftTolerancePct: number; syncPriority: string[] };
}

// ---------- runtime shapes ----------
export interface ScanResult {
  formatId: string;
  kind: string;
  payload: string;
  value: string;
  duplicate: boolean;
}

export interface PosLine {
  sku: string;
  qty: number;
  unitPrice: number;
  currency: string;
  scannedBy?: string;
}

export interface RegisterSession {
  sessionId: string;
  storeId: string;
  registerId: string;
  cashierId: string;
  openedAt: string;
  openingFloat: number;
  status: 'open' | 'closed';
  receiptSeq: number;
  sales: number;
}

export interface Sale {
  saleId: string;
  sessionId: string;
  storeId: string;
  lines: PosLine[];
  total: number;
  currency: string;
  tenders: Array<{ type: string; amount: number; change?: number; authRef?: string }>;
  receiptNo: string;
  at: string;
  offline: boolean;
}

export interface PickupHold {
  holdId: string;
  storeId: string;
  orderId: string;
  code: string;
  lines: PosLine[];
  value: number;
  expiresAt: string;
  status: 'held' | 'picked-up' | 'expired';
}

export interface QueuedAction {
  id: string;
  priority: number;
  kind: string;
  payload: Record<string, unknown>;
  capturedAt: string;
}

export interface SyncOutcome {
  replayed: number;
  held: Array<{ actionId: string; reason: string }>;
  remaining: number;
}

const round = (n: number, unit = 2): number => {
  const f = 10 ** unit;
  return Math.round(n * f) / f;
};

export class PosError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = 'PosError';
    this.status = status;
  }
}

export class PosService {
  private pack: PosPack;
  private sessions = new Map<string, RegisterSession>();
  private sales: Sale[] = [];
  private holds = new Map<string, PickupHold>();
  private queue: QueuedAction[] = [];
  private lastScan = new Map<string, number>();
  private seq = 0;

  constructor(pack: PosPack) {
    this.pack = pack;
  }

  // ---------- register sessions ----------
  openSession(storeId: string, registerId: string, cashierId: string, openingFloat?: number, at?: string): RegisterSession {
    const openInStore = [...this.sessions.values()].filter((s) => s.storeId === storeId && s.status === 'open').length;
    if (openInStore >= this.pack.registerPolicy.maxOpenSessionsPerStore) {
      throw new PosError(`store ${storeId} already has ${openInStore} open registers (policy cap ${this.pack.registerPolicy.maxOpenSessionsPerStore})`);
    }
    if (this.pack.registerPolicy.requireFloatDeclaration && openingFloat === undefined) {
      throw new PosError('opening float must be declared (pack policy)');
    }
    this.seq++;
    const session: RegisterSession = {
      sessionId: `pos-sess-${this.seq}`,
      storeId,
      registerId,
      cashierId,
      openedAt: at ?? new Date().toISOString(),
      openingFloat: openingFloat ?? this.pack.registerPolicy.openingFloatDefault,
      status: 'open',
      receiptSeq: 0,
      sales: 0,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  /** close + reconcile cash drawer against pack variance tolerance */
  closeSession(sessionId: string, countedCash: number, at?: string): RegisterSession & { expectedCash: number; variance: number; withinTolerance: boolean; reviewRequired: boolean } {
    const session = this.requireSession(sessionId);
    const cashIn = this.sales
      .filter((s) => s.sessionId === sessionId)
      .flatMap((s) => s.tenders.filter((t) => t.type === 'cash'))
      .reduce((sum, t) => sum + t.amount - (t.change ?? 0), 0);
    const expectedCash = round(session.openingFloat + cashIn);
    const variance = round(countedCash - expectedCash);
    const tolerance = this.pack.registerPolicy.varianceToleranceMinor / 100;
    session.status = 'closed';
    this.sessions.set(sessionId, session);
    void at;
    return {
      ...session,
      expectedCash,
      variance,
      withinTolerance: Math.abs(variance) <= tolerance,
      reviewRequired: Math.abs(variance) > tolerance,
    };
  }

  private requireSession(sessionId: string): RegisterSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new PosError(`unknown register session "${sessionId}"`, 404);
    if (s.status === 'closed') throw new PosError(`register session "${sessionId}" is closed`);
    return s;
  }

  // ---------- scanning (RFID + barcode; formats are pack data) ----------
  scan(raw: string, atMs = Date.now()): ScanResult {
    const value = raw.trim();
    const format = this.pack.scanFormats.find((f) => {
      const candidate = f.caseInsensitive ? value.toUpperCase() : value;
      const prefixOk = f.prefixes.length === 0 || f.prefixes.some((p) => candidate.startsWith(f.caseInsensitive ? p.toUpperCase() : p));
      if (!prefixOk) return false;
      if (f.length !== null && value.length !== f.length) return false;
      return true;
    });
    if (!format) {
      if (this.pack.scanPolicy.rejectUnknownFormat) {
        throw new PosError(`scan "${value}" matches no registered format — add it to the pack`);
      }
      return { formatId: 'unknown', kind: 'unknown', payload: 'unknown', value, duplicate: false };
    }
    const dedupeMs = this.pack.scanPolicy.dedupeWithinSeconds * 1000;
    const key = `${format.id}:${value}`;
    const prior = this.lastScan.get(key);
    const duplicate = prior !== undefined && atMs - prior < dedupeMs;
    if (!duplicate) this.lastScan.set(key, atMs);
    const payload = format.payload === 'epc' ? value : format.payload === 'gtin' ? value.slice(-13) : value;
    return { formatId: format.id, kind: format.kind, payload: format.payload, value: payload, duplicate };
  }

  addToCart(lines: PosLine[], line: PosLine): PosLine[] {
    if (line.qty <= 0) throw new PosError('qty must be >= 1');
    const existing = lines.find((l) => l.sku === line.sku && l.unitPrice === line.unitPrice);
    if (existing) {
      existing.qty += line.qty;
      return lines;
    }
    return [...lines, { ...line }];
  }

  // ---------- tender + receipt ----------
  tender(sessionId: string, lines: PosLine[], tenders: Array<{ type: string; amount: number; authRef?: string; offline?: boolean }>, currency = 'USD', offline = false): Sale {
    const session = this.requireSession(sessionId);
    const total = round(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0));
    let paid = 0;
    const applied: Sale['tenders'] = [];
    for (const t of tenders) {
      const def = this.pack.tenderTypes.find((x) => x.id === t.type);
      if (!def) throw new PosError(`unknown tender type "${t.type}" — register it in the pack`);
      if (def.requiresAuth && !t.authRef) throw new PosError(`tender "${t.type}" requires an auth reference`);
      paid += t.amount;
      applied.push({ type: t.type, amount: round(t.amount), authRef: t.authRef });
    }
    paid = round(paid);
    if (paid < total) throw new PosError(`underpaid: tendered ${paid} of ${total}`);
    const change = round(paid - total);
    if (change > 0) {
      const cashTender = applied.find((t) => this.pack.tenderTypes.find((x) => x.id === t.type)?.changeAllowed);
      if (!cashTender) throw new PosError(`overpayment of ${change} cannot be returned — no change-allowing tender present`);
      cashTender.change = change;
    }
    session.receiptSeq += 1;
    session.sales += 1;
    const receiptNo = `${this.pack.registerPolicy.receiptSeriesPrefix}-${session.storeId}-${session.registerId}-${String(session.receiptSeq).padStart(6, '0')}`;
    const sale: Sale = {
      saleId: `sale-${this.sales.length + 1}`,
      sessionId,
      storeId: session.storeId,
      lines: [...lines],
      total,
      currency,
      tenders: applied,
      receiptNo,
      at: new Date().toISOString(),
      offline,
    };
    this.sales.push(sale);
    if (offline) this.enqueue('sale', { saleId: sale.saleId, total: sale.total, receiptNo: sale.receiptNo });
    return sale;
  }

  // ---------- BOPIS pickup ----------
  holdForPickup(storeId: string, orderId: string, lines: PosLine[], at?: string): PickupHold {
    const value = round(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0));
    const now = at ? Date.parse(at) : Date.now();
    this.seq++;
    const code = `P${String(this.seq).padStart(this.pack.bopisPolicy.pickupCodeLength - 1, '0')}`;
    const hold: PickupHold = {
      holdId: `hold-${this.seq}`,
      storeId,
      orderId,
      code,
      lines: [...lines],
      value,
      expiresAt: new Date(now + this.pack.bopisPolicy.holdHours * 3600_000).toISOString(),
      status: 'held',
    };
    this.holds.set(hold.holdId, hold);
    return hold;
  }

  confirmPickup(holdId: string, code: string, idVerified = false, at?: string): PickupHold {
    const hold = this.holds.get(holdId);
    if (!hold) throw new PosError(`unknown pickup hold "${holdId}"`, 404);
    const nowMs = at ? Date.parse(at) : Date.now();
    if (hold.status === 'picked-up') throw new PosError('pickup already completed');
    if (nowMs > Date.parse(hold.expiresAt)) {
      hold.status = 'expired';
      throw new PosError(`pickup hold expired at ${hold.expiresAt} (policy hold ${this.pack.bopisPolicy.holdHours}h)`);
    }
    if (code !== hold.code) throw new PosError('pickup code does not match');
    const highValue = hold.value >= this.pack.bopisPolicy.highValueThreshold;
    if (highValue && this.pack.bopisPolicy.verifyIdForHighValue && !idVerified) {
      throw new PosError(`pickup value ${hold.value} requires ID verification (pack threshold ${this.pack.bopisPolicy.highValueThreshold})`);
    }
    hold.status = 'picked-up';
    this.holds.set(holdId, hold);
    return hold;
  }

  // ---------- offline queue ----------
  private enqueue(kind: string, payload: Record<string, unknown>): QueuedAction {
    if (this.queue.length >= this.pack.offlinePolicy.maxQueuedActions) {
      throw new PosError(`offline queue full (${this.pack.offlinePolicy.maxQueuedActions}) — pack policy`);
    }
    const priority = this.pack.offlinePolicy.syncPriority.indexOf(kind);
    const action: QueuedAction = {
      id: `act-${this.queue.length + 1}`,
      priority: priority === -1 ? this.pack.offlinePolicy.syncPriority.length : priority,
      kind,
      payload,
      capturedAt: new Date().toISOString(),
    };
    this.queue.push(action);
    return action;
  }

  captureOffline(kind: string, payload: Record<string, unknown>): QueuedAction {
    return this.enqueue(kind, payload);
  }

  queueDepth(): { total: number; byKind: Record<string, number> } {
    const byKind: Record<string, number> = {};
    for (const a of this.queue) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
    return { total: this.queue.length, byKind };
  }

  /**
   * replay the queue in pack priority order. `livePriceFor` lets the host supply
   * the current price so price-drift beyond tolerance HOLDS the action for review
   * instead of posting a wrong price (same protection as the storefront).
   */
  syncQueue(live: { livePriceFor?: (payload: Record<string, unknown>) => number | undefined } = {}): SyncOutcome {
    const ordered = [...this.queue].sort((a, b) => a.priority - b.priority || a.capturedAt.localeCompare(b.capturedAt));
    const held: SyncOutcome['held'] = [];
    const replayedIds = new Set<string>();
    for (const action of ordered) {
      if (live.livePriceFor) {
        const captured = typeof action.payload['total'] === 'number' ? (action.payload['total'] as number) : undefined;
        const current = live.livePriceFor(action.payload);
        if (captured !== undefined && current !== undefined && captured > 0) {
          const driftPct = Math.abs((current - captured) / captured) * 100;
          if (driftPct > this.pack.offlinePolicy.priceDriftTolerancePct) {
            held.push({ actionId: action.id, reason: `price drift ${round(driftPct, 2)}% exceeds tolerance ${this.pack.offlinePolicy.priceDriftTolerancePct}% (strategy: ${this.pack.offlinePolicy.conflictStrategy})` });
            continue;
          }
        }
      }
      replayedIds.add(action.id);
    }
    this.queue = this.queue.filter((a) => !replayedIds.has(a.id));
    return { replayed: replayedIds.size, held, remaining: this.queue.length };
  }

  sessionReport(sessionId: string): { session: RegisterSession; sales: Sale[]; total: number } {
    const session = this.sessions.get(sessionId);
    if (!session) throw new PosError(`unknown register session "${sessionId}"`, 404);
    const sales = this.sales.filter((s) => s.sessionId === sessionId);
    return { session, sales, total: round(sales.reduce((s, x) => s + x.total, 0)) };
  }

  holdsFor(storeId: string): PickupHold[] {
    return [...this.holds.values()].filter((h) => h.storeId === storeId);
  }
}

// ---------- Module-as-a-Product contract ----------
const posModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as PosPack;
    const svc = new PosService(pack);
    const meter = (ev: string) => billing.meter(ev, 1);
    return {
      openSession: (s: string, r: string, c: string, f?: number, at?: string) => svc.openSession(s, r, c, f, at),
      scan: (raw: string, atMs?: number) => svc.scan(raw, atMs),
      addToCart: (lines: PosLine[], line: PosLine) => svc.addToCart(lines, line),
      tender: (sid: string, lines: PosLine[], tenders: Array<{ type: string; amount: number; authRef?: string; offline?: boolean }>, currency?: string, offline?: boolean) =>
        (meter('pos.sale.completed'), svc.tender(sid, lines, tenders, currency, offline)),
      closeSession: (sid: string, counted: number, at?: string) => (meter('pos.session.closed'), svc.closeSession(sid, counted, at)),
      holdForPickup: (store: string, order: string, lines: PosLine[], at?: string) => svc.holdForPickup(store, order, lines, at),
      confirmPickup: (h: string, code: string, idVerified?: boolean, at?: string) => (meter('pos.pickup.confirmed'), svc.confirmPickup(h, code, idVerified, at)),
      syncQueue: (live?: { livePriceFor?: (p: Record<string, unknown>) => number | undefined }) => svc.syncQueue(live),
      queueDepth: () => svc.queueDepth(),
      captureOffline: (kind: string, payload: Record<string, unknown>) => svc.captureOffline(kind, payload),
      sessionReport: (sid: string) => svc.sessionReport(sid),
      holdsFor: (store: string) => svc.holdsFor(store),
      __raw: svc,
    };
  },
};

export default posModule;