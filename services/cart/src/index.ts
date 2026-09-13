// @aether/service-cart — session-scoped shopping carts (shopper flow).
// Module-as-a-Product: line/qty caps are pack data; store is swappable.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';
import type { StorageEngine } from '@aether/kernel-storage';

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
  private carts = new Map<string, CartLine[]>(); // customerId → lines (cache)
  private cartValidFrom = new Map<string, string>(); // stable record window per cart
  private store: StorageEngine | null = null; // distributed carts (multi-pod)

  constructor(pack: CartPack) {
    this.pack = pack;
  }

  /** attach a durable cart store (Storage SPI — conformance-admitted engines) */
  attachStore(engine: StorageEngine): void {
    this.store = engine;
  }

  private async loadCart(customerId: string): Promise<{ lines: CartLine[]; validFrom: string | null }> {
    if (!this.store) return { lines: this.carts.get(customerId) ?? [], validFrom: null };
    const rec = await this.store.get(`cart_${customerId}`, 'aether-carts');
    return rec ? { lines: rec.attributes.lines as CartLine[], validFrom: rec.validFrom } : { lines: [], validFrom: null };
  }

  private async saveLines(customerId: string, lines: CartLine[], validFrom?: string | null): Promise<void> {
    this.carts.set(customerId, lines);
    if (!this.store) return;
    const now = new Date().toISOString();
    const stableFrom = validFrom ?? this.cartValidFrom.get(customerId) ?? now; // reuse record window → single current row
    this.cartValidFrom.set(customerId, stableFrom);
    await this.store.put({
      id: `cart_${customerId}`, tenantId: 'aether-carts', typeId: 'et_cart',
      validFrom: stableFrom, validTo: null, recordedAt: now, epoch: 1,
      attributes: { lines },
    }, { upsert: true }); // cart replaces its own current version
  }

  async add(customerId: string, line: Omit<CartLine, 'currency'> & { currency?: string }): Promise<CartView> {
    const { lines: cart, validFrom } = await this.loadCart(customerId);
    const existing = cart.find((l) => l.offerId === line.offerId);
    if (existing) {
      existing.qty = Math.min(existing.qty + line.qty, this.pack.policy.maxQtyPerLine);
    } else {
      if (cart.length >= this.pack.policy.maxLines) throw new CartError(`cart full (max ${this.pack.policy.maxLines} lines)`);
      if (line.qty < 1) throw new CartError('qty must be >= 1');
      if (line.qty > this.pack.policy.maxQtyPerLine) throw new CartError(`qty cap is ${this.pack.policy.maxQtyPerLine}`);
      cart.push({ ...line, currency: line.currency ?? 'USD' } as CartLine);
    }
    await this.saveLines(customerId, cart, validFrom);
    return this.view(customerId);
  }

  async update(customerId: string, offerId: string, qty: number): Promise<CartView> {
    const { lines: cart, validFrom } = await this.loadCart(customerId);
    const line = cart.find((l) => l.offerId === offerId);
    if (!line) throw new CartError('no such line', 404);
    if (qty < 1) return this.remove(customerId, offerId);
    if (qty > this.pack.policy.maxQtyPerLine) throw new CartError(`qty cap is ${this.pack.policy.maxQtyPerLine}`);
    line.qty = qty;
    await this.saveLines(customerId, cart, validFrom);
    return this.view(customerId);
  }

  async remove(customerId: string, offerId: string): Promise<CartView> {
    const { lines: cart, validFrom } = await this.loadCart(customerId);
    if (cart.length === 0) throw new CartError('no cart', 404);
    await this.saveLines(customerId, cart.filter((l) => l.offerId !== offerId), validFrom);
    return this.view(customerId);
  }

  async get(customerId: string): Promise<CartView> {
    const { lines } = await this.loadCart(customerId);
    this.carts.set(customerId, lines);
    return this.view(customerId);
  }

  async clear(customerId: string): Promise<CartView> {
    const { validFrom } = await this.loadCart(customerId);
    await this.saveLines(customerId, [], validFrom);
    return this.view(customerId);
  }

  /** consume the cart for checkout (returns lines, clears cart) */
  async take(customerId: string): Promise<CartLine[]> {
    const { lines, validFrom } = await this.loadCart(customerId);
    await this.saveLines(customerId, [], validFrom);
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
