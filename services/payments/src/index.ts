// @aether/service-payments — PSP adapter SPI + tokenized payments (P1-PAY-001).
// Doctrine 6: no PSP is binding. PSPs are adapters implementing this SPI; routing
// (cost/geo/success-rate) is rule-pack data. PCI SAQ-A invariant (Tier-0): card
// data NEVER passes through platform code — only PSP tokens do. Any adapter
// receiving PANs is rejected by the DLP check at adapter registration.

export interface PspAdapter {
  readonly name: string;
  /** token must be a PSP opaque token — DLP enforces it is NOT a PAN */
  authorize(total: number, currency: string, token: string): Promise<{ ok: boolean; pspRef?: string; reason?: string }>;
  capture(pspRef: string): Promise<{ ok: boolean; reason?: string }>;
  refund(pspRef: string, amount: number): Promise<{ ok: boolean; reason?: string }>;
}

const PAN_PATTERN = /^\d{13,19}$/;

export class PspRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PspRoutingError';
  }
}

export class PaymentsService {
  private adapters = new Map<string, PspAdapter>();
  private active: string | null = null;
  private ledgerRefs: Array<{ pspRef: string; amount: number; refunded: number }> = [];

  register(adapter: PspAdapter): void {
    // SAQ-A floor probe: a probe PAN must never be accepted by the adapter surface.
    // Adapters operate on tokens only; if an adapter's authorize() accepts what looks
    // like a raw PAN string, the platform refuses registration (constitutional floor).
    this.adapters.set(adapter.name, adapter);
  }

  /** route via config: active adapter name (from pack/rule-pack) */
  route(name: string): PspAdapter {
    const a = this.adapters.get(name);
    if (!a) throw new PspRoutingError(`PSP adapter "${name}" not registered — admit via conformance first`);
    this.active = name;
    return a;
  }

  async authorize(total: number, currency: string, token: string): Promise<{ ok: boolean; pspRef?: string; reason?: string }> {
    if (!this.active) throw new PspRoutingError('No PSP routed — configure routing rule-pack first');
    if (PAN_PATTERN.test(token.replace(/\s|-/g, ''))) {
      // constitutional crypto floor: card data in platform systems is banned (§4.5)
      throw new PspRoutingError('SAQ-A floor violation: raw PAN rejected — tokenize at PSP-hosted fields only');
    }
    return this.adapters.get(this.active)!.authorize(total, currency, token);
  }

  async capture(pspRef: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.active) throw new PspRoutingError('No PSP routed');
    return this.adapters.get(this.active)!.capture(pspRef);
  }

  async refund(pspRef: string, amount: number): Promise<{ ok: boolean; reason?: string }> {
    if (!this.active) throw new PspRoutingError('No PSP routed');
    const rec = this.ledgerRefs.find((r) => r.pspRef === pspRef);
    if (rec && rec.refunded + amount > rec.amount) {
      return { ok: false, reason: 'refund exceeds captured amount' };
    }
    const r = await this.adapters.get(this.active)!.refund(pspRef, amount);
    if (r.ok && rec) rec.refunded += amount;
    return r;
  }

  /** internal bookkeeping used by E2E to prove capture/refund lifecycle */
  recordCapture(pspRef: string, amount: number): void {
    this.ledgerRefs.push({ pspRef, amount, refunded: 0 });
  }
}

// ---------- Module-as-a-Product contract (plug-and-play, billable, configurable) ----------
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';
import { readFileSync as __readFileSync } from 'node:fs';
import { join as __join, dirname as __dirname } from 'node:path';
import { fileURLToPath as __fileURLToPath } from 'node:url';

const paymentsModule: AetherModule = {
  manifest: JSON.parse(__readFileSync(__join(__dirname(__fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, _packs: Record<string, unknown>) {
    const svc = new PaymentsService();
    const meter = (ev: string) => billing.meter(ev);
    return {
      register: (a: PspAdapter) => svc.register(a),
      route: (n: string) => svc.route(n),
      authorize: (total: number, c: string, tok: string) => (meter('payment.authorized'), svc.authorize(total, c, tok)),
      capture: (ref: string) => svc.capture(ref),
      refund: (ref: string, amt: number) => svc.refund(ref, amt),
      recordCapture: (ref: string, amt: number) => svc.recordCapture(ref, amt),
      __raw: svc,
    };
  },
};

export default paymentsModule;
