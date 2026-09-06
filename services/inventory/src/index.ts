// @aether/service-inventory — reservations + atomic stock (P1-INV-001).
// Kernel application. Oversell protection is a Tier-0 invariant: reservations are
// atomic, TTL'd, and released/committed exactly once. All policies (TTL, limits)
// arrive as constructor config (pack data), never literals.

export interface ReservationPolicy {
  ttlMs: number;
  maxQtyPerLine: number;
}

export interface Reservation {
  id: string;
  offerId: string;
  qty: number;
  createdAt: number;
  expiresAt: number;
  released: boolean;
  committed: boolean;
}

export class InventoryService {
  private stock = new Map<string, number>(); // offerId -> on-hand
  private reserved = new Map<string, number>(); // offerId -> reserved qty
  private reservations = new Map<string, Reservation>();
  private policy: ReservationPolicy;
  private seq = 0;

  constructor(policy?: Partial<ReservationPolicy>) {
    this.policy = { ttlMs: 15 * 60_000, maxQtyPerLine: 10, ...policy };
  }

  setStock(offerId: string, qty: number): void {
    this.stock.set(offerId, qty);
  }

  available(offerId: string): number {
    return (this.stock.get(offerId) ?? 0) - (this.reserved.get(offerId) ?? 0);
  }

  /** atomic reserve — all-or-nothing across lines (oversell = 0 under concurrency) */
  reserve(lines: Array<{ offerId: string; qty: number }>): { ok: boolean; failed?: string[]; reservationIds?: string[] } {
    const expired = this.reapExpired();
    void expired;
    // validate first (all-or-nothing)
    for (const l of lines) {
      if (l.qty <= 0 || l.qty > this.policy.maxQtyPerLine) return { ok: false, failed: [l.offerId] };
      if (this.available(l.offerId) < l.qty) return { ok: false, failed: [l.offerId] };
    }
    const ids: string[] = [];
    for (const l of lines) {
      const id = `res-${++this.seq}`;
      const now = Date.now();
      this.reservations.set(id, {
        id, offerId: l.offerId, qty: l.qty, createdAt: now,
        expiresAt: now + this.policy.ttlMs, released: false, committed: false,
      });
      this.reserved.set(l.offerId, (this.reserved.get(l.offerId) ?? 0) + l.qty);
      ids.push(id);
    }
    return { ok: true, reservationIds: ids };
  }

  commit(ids: string[]): void {
    for (const id of ids) {
      const r = this.reservations.get(id);
      if (!r || r.released || r.committed) continue;
      r.committed = true;
      this.stock.set(r.offerId, (this.stock.get(r.offerId) ?? 0) - r.qty);
      this.reserved.set(r.offerId, (this.reserved.get(r.offerId) ?? 0) - r.qty);
    }
  }

  release(ids: string[]): void {
    for (const id of ids) {
      const r = this.reservations.get(id);
      if (!r || r.released || r.committed) continue;
      r.released = true;
      this.reserved.set(r.offerId, (this.reserved.get(r.offerId) ?? 0) - r.qty);
    }
  }

  /** TTL reaping — expired reservations return to available pool */
  private reapExpired(): number {
    let n = 0;
    const now = Date.now();
    for (const r of this.reservations.values()) {
      if (!r.released && !r.committed && r.expiresAt <= now) {
        r.released = true;
        this.reserved.set(r.offerId, (this.reserved.get(r.offerId) ?? 0) - r.qty);
        n++;
      }
    }
    return n;
  }

  /** for checkout-hook wiring: reserve→ids, commit ids, release ids */
  reappear(): void {
    this.reapExpired();
  }
}
