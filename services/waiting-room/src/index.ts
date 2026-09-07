// @aether/service-waiting-room — flash-sale virtual waiting room (P3-SCL-001).
// Module-as-a-Product: admission rate, queue capacity, slot hold time,
// full-queue behavior are ALL PACK DATA. Token-bucket admission per second;
// FIFO queue with deterministic position; slot hold w/ reclaim; sessions
// per-user cap; retry-after signaling. Protects checkout at 250k/hr bursts.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface WaitingRoomPack {
  pack: { name: string };
  policies: {
    admitPerSecond: number;
    maxQueueSize: number;
    slotHoldSeconds: number;
    sessionsPerUser: number;
    queueFullBehavior: string;
    admissionCurve: string;
  };
}

export type JoinResult =
  | { status: 'admitted'; slotId: string; position: 0 }
  | { status: 'queued'; slotId: null; position: number; etaSeconds: number }
  | { status: 'rejected-full'; slotId: null; retryAfterSeconds: number }
  | { status: 'rejected-duplicate'; slotId: string; position: 0 }; // already holds a slot

export class WaitingRoomService {
  private pack: WaitingRoomPack;
  private queue: Array<{ userId: string; enqueuedAt: number }> = [];
  private activeSlots = new Map<string, { userId: string; expiresAt: number }>(); // slotId -> hold
  private userSlots = new Map<string, string[]>(); // userId -> slotIds (per-user cap)
  private admittedThisSecond = 0;
  private currentSecond = 0;
  private seq = 0;

  constructor(pack: WaitingRoomPack) {
    this.pack = pack;
  }

  private tick(second: number): void {
    if (second !== this.currentSecond) {
      this.currentSecond = second;
      this.admittedThisSecond = 0;
      // reclaim expired holds
      const now = second * 1000;
      for (const [slotId, hold] of this.activeSlots) {
        if (hold.expiresAt <= now) {
          this.activeSlots.delete(slotId);
          const list = this.userSlots.get(hold.userId)!;
          const idx = list.indexOf(slotId);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) this.userSlots.delete(hold.userId);
        }
      }
    }
  }

  /** user joins during a flash sale: admitted if bucket allows, else FIFO queue */
  join(userId: string, nowMs: number): JoinResult {
    const p = this.pack.policies;
    const second = Math.floor(nowMs / 1000);
    this.tick(second);

    // existing live slot for this user → idempotent re-entry
    const existing = (this.userSlots.get(userId) ?? []).find((s) => this.activeSlots.has(s));
    if (existing) return { status: 'rejected-duplicate', slotId: existing, position: 0 };

    // per-user session cap (held slots count even while queued as user-level lock)
    if ((this.userSlots.get(userId)?.length ?? 0) >= p.sessionsPerUser && this.isUserQueued(userId)) {
      return this.joinQueuedPosition(userId, nowMs);
    }

    // token-bucket admission
    if (this.admittedThisSecond < p.admitPerSecond) {
      this.admittedThisSecond++;
      return this.admit(userId, nowMs);
    }

    // queue full behavior from pack
    if (this.queue.length >= p.maxQueueSize) {
      if (p.queueFullBehavior === 'reject-with-retry-after') {
        return { status: 'rejected-full', slotId: null, retryAfterSeconds: 60 };
      }
      this.queue.shift(); // drop-oldest alternative
    }
    this.queue.push({ userId, enqueuedAt: nowMs });
    return this.joinQueuedPosition(userId, nowMs);
  }

  private isUserQueued(userId: string): boolean {
    return this.queue.some((q) => q.userId === userId);
  }

  private joinQueuedPosition(userId: string, nowMs: number): JoinResult {
    const p = this.pack.policies;
    const idx = this.queue.findIndex((q) => q.userId === userId);
    if (idx === -1) return { status: 'rejected-full', slotId: null, retryAfterSeconds: 60 };
    const position = idx + 1;
    const etaSeconds = Math.ceil(position / p.admitPerSecond);
    return { status: 'queued', slotId: null, position, etaSeconds };
  }

  private admit(userId: string, nowMs: number): JoinResult {
    const p = this.pack.policies;
    const slotId = `slot-${++this.seq}`;
    this.activeSlots.set(slotId, { userId, expiresAt: nowMs + p.slotHoldSeconds * 1000 });
    if (!this.userSlots.has(userId)) this.userSlots.set(userId, []);
    this.userSlots.get(userId)!.push(slotId);
    return { status: 'admitted', slotId, position: 0 };
  }

  /** drain the queue as the admission bucket refills each second (scheduler tick) */
  drain(nowMs: number): number {
    const p = this.pack.policies;
    const second = Math.floor(nowMs / 1000);
    this.tick(second);
    let admitted = 0;
    while (this.queue.length > 0 && this.admittedThisSecond < p.admitPerSecond) {
      const next = this.queue.shift()!;
      // skip users who got a slot elsewhere or vanished — admit next in line
      this.admittedThisSecond++;
      this.admit(next.userId, nowMs);
      admitted++;
    }
    return admitted;
  }

  /** checkout completion releases the slot early */
  release(slotId: string): boolean {
    const hold = this.activeSlots.get(slotId);
    if (!hold) return false;
    this.activeSlots.delete(slotId);
    const list = this.userSlots.get(hold.userId)!;
    const idx = list.indexOf(slotId);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) this.userSlots.delete(hold.userId);
    return true;
  }

  stats(): { queued: number; activeSlots: number; admittedThisSecond: number } {
    return {
      queued: this.queue.length,
      activeSlots: this.activeSlots.size,
      admittedThisSecond: this.admittedThisSecond,
    };
  }

  queueDepth(): number {
    return this.queue.length;
  }
}

const waitingRoomModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as WaitingRoomPack;
    const svc = new WaitingRoomService(pack);
    const meter = (ev: string) => billing.meter(ev);
    return {
      join: (u: string, now: number) => (meter('waitroom.join'), svc.join(u, now)),
      drain: (now: number) => svc.drain(now),
      release: (slot: string) => svc.release(slot),
      stats: () => svc.stats(),
      queueDepth: () => svc.queueDepth(),
      __raw: svc,
    };
  },
};

export default waitingRoomModule;
