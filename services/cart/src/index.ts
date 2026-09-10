// @aether/service-cart — session-scoped shopping carts (shopper flow).
// Module-as-a-Product: line/qty caps are pack data; store is swappable.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface CartPack {
  pack: { name: string };
  policy: { maxLines: number; maxQtyPerLine: number };
}

export interface CartLine {
  offerId: string;
  productId: string;
  title: string;
  sellerId: string;
  price: number;
  currency: string;
  qty: number;
}

export interface CartView {
  customerId: string;
  lines: CartLine[];
  total: number;
  currency: string;
}

export class CartError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = 'CartError';
    this.status = status;
  }
}

export class CartService {
  private pack: CartPack;
  private carts = new Map<string, CartLine[]>(); // customerId → lines

  constructor(pack: CartPack) {
    this.pack = pack;
  }

  add(customerId: string, line: Omit<CartLine, 'currency'> & { currency?: string }): CartView {
    const cart = this.carts.get(customerId) ?? [];
    const existing = cart.find((l) => l.offerId === line.offerId);
    if (existing) {
      existing.qty = Math.min(existing.qty + line.qty, this.pack.policy.maxQtyPerLine);
    } else {
      if (cart.length >= this.pack.policy.maxLines) throw new CartError(`cart full (max ${this.pack.policy.maxLines} lines)`);
      if (line.qty < 1) throw new CartError('qty must be >= 1');
      if (line.qty > this.pack.policy.maxQtyPerLine) throw new CartError(`qty cap is ${this.pack.policy.maxQtyPerLine}`);
      cart.push({ ...line, currency: line.currency ?? 'USD' } as CartLine);
    }
    this.carts.set(customerId, cart);
    return this.view(customerId);
  }

  update(customerId: string, offerId: string, qty: number): CartView {
    const cart = this.carts.get(customerId);
    if (!cart) throw new CartError('no cart', 404);
    const line = cart.find((l) => l.offerId === offerId);
    if (!line) throw new CartError('no such line', 404);
    if (qty < 1) return this.remove(customerId, offerId);
    if (qty > this.pack.policy.maxQtyPerLine) throw new CartError(`qty cap is ${this.pack.policy.maxQtyPerLine}`);
    line.qty = qty;
    return this.view(customerId);
  }

  remove(customerId: string, offerId: string): CartView {
    const cart = this.carts.get(customerId);
    if (!cart) throw new CartError('no cart', 404);
    this.carts.set(customerId, cart.filter((l) => l.offerId !== offerId));
    return this.view(customerId);
  }

  get(customerId: string): CartView {
    return this.view(customerId);
  }

  clear(customerId: string): CartView {
    this.carts.set(customerId, []);
    return this.view(customerId);
  }

  /** consume the cart for checkout (returns lines, clears cart) */
  take(customerId: string): CartLine[] {
    const lines = [...(this.carts.get(customerId) ?? [])];
    this.carts.set(customerId, []);
    return lines;
  }

  private view(customerId: string): CartView {
    const lines = this.carts.get(customerId) ?? [];
    const total = Math.round(lines.reduce((s, l) => s + l.qty * l.price, 0) * 100) / 100;
    return { customerId, lines, total, currency: lines[0]?.currency ?? 'USD' };
  }
}

// ---------- Module-as-a-Product contract ----------
const cartModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as CartPack;
    const svc = new CartService(pack);
    const meter = (ev: string) => billing.meter(ev, 1);
    return {
      add: (c: string, l: Omit<CartLine, 'currency'> & { currency?: string }) => (meter('cart.line.added'), svc.add(c, l)),
      update: (c: string, o: string, q: number) => svc.update(c, o, q),
      remove: (c: string, o: string) => svc.remove(c, o),
      get: (c: string) => svc.get(c),
      clear: (c: string) => svc.clear(c),
      take: (c: string) => svc.take(c),
      __raw: svc,
    };
  },
};

export default cartModule;
