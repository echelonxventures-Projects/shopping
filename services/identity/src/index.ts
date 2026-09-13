// @aether/service-identity — customer register/login/sessions (shopper flow).
// Module-as-a-Product: password rules, session TTL, token size are PACK DATA.
// Credentials: scrypt-salted hashes, timing-safe compare — no plaintext at
// rest; tokens are random (demo-grade store; production swaps KMS/JWT-class
// adapter behind the same API). Login never reveals whether email vs
// password failed beyond what the demo needs.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';
import type { StorageEngine } from '@aether/kernel-storage';

export interface IdentityPack {
  pack: { name: string };
  policy: {
    passwordMinLength: number;
    passwordRequireDigit: boolean;
    passwordRequireLetter: boolean;
    sessionTtlMinutes: number;
    tokenBytes: number;
  };
}

export interface Customer {
  customerId: string;
  email: string;
  name: string;
  registeredAt: string;
}

export interface Session {
  token: string;
  customerId: string;
  email: string;
  expiresAt: string;
}

export class IdentityError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = 'IdentityError';
    this.status = status;
  }
}

export class IdentityService {
  private pack: IdentityPack;
  private users = new Map<string, { customerId: string; email: string; name: string; hash: string; salt: string; registeredAt: string }>(); // email → record
  private sessions = new Map<string, Session>(); // token → session (cache; store is durable)
  private store: StorageEngine | null = null; // distributed state (multi-pod); demo runs in-memory
  private seq = 0;

  constructor(pack: IdentityPack) {
    this.pack = pack;
  }

  /** attach a durable session store (Storage SPI — conformance-admitted engines) */
  attachStore(engine: StorageEngine): void {
    this.store = engine;
  }

  private validatePassword(pw: string): void {
    const p = this.pack.policy;
    if (pw.length < p.passwordMinLength) throw new IdentityError(`password must be at least ${p.passwordMinLength} chars`);
    if (p.passwordRequireDigit && !/\d/.test(pw)) throw new IdentityError('password requires a digit');
    if (p.passwordRequireLetter && !/[A-Za-z]/.test(pw)) throw new IdentityError('password requires a letter');
  }

  private newId(): string {
    this.seq++;
    return `cust_${String(this.seq).padStart(5, '0')}`;
  }

  async register(email: string, password: string, name: string): Promise<{ customer: Customer; session: Session }> {
    const norm = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(norm)) throw new IdentityError('invalid email');
    const existing = await this.findUser(norm);
    if (existing) throw new IdentityError('email already registered', 409);
    this.validatePassword(password);
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    const record = {
      customerId: this.newId(),
      email: norm,
      name: name.trim() || norm.split('@')[0]!,
      hash,
      salt,
      registeredAt: new Date().toISOString(),
    };
    this.users.set(norm, record);
    if (this.store) {
      await this.store.put({
        id: `usr_${norm}`, tenantId: 'aether-identity', typeId: 'et_customer',
        validFrom: record.registeredAt, validTo: null, recordedAt: record.registeredAt, epoch: 1,
        attributes: { customerId: record.customerId, email: norm, name: record.name, hash: record.hash, salt: record.salt, registeredAt: record.registeredAt },
      }, { upsert: true });
    }
    return { customer: this.toCustomer(record), session: await this.issueSession(record) };
  }

  async login(email: string, password: string): Promise<{ customer: Customer; session: Session }> {
    const norm = email.trim().toLowerCase();
    const record = await this.findUser(norm);
    if (!record) throw new IdentityError('invalid email or password', 401);
    const candidate = scryptSync(password, record.salt, 64);
    const expected = Buffer.from(record.hash, 'hex');
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      throw new IdentityError('invalid email or password', 401);
    }
    return { customer: this.toCustomer(record), session: await this.issueSession(record) };
  }

  private async findUser(email: string): Promise<{ customerId: string; email: string; name: string; hash: string; salt: string; registeredAt: string } | null> {
    const cached = this.users.get(email);
    if (cached) return cached;
    if (this.store) {
      const rec = await this.store.get(`usr_${email}`, 'aether-identity');
      if (rec) {
        const u = {
          customerId: String(rec.attributes.customerId), email, name: String(rec.attributes.name),
          hash: String(rec.attributes.hash), salt: String(rec.attributes.salt), registeredAt: String(rec.attributes.registeredAt),
        };
        this.users.set(email, u);
        return u;
      }
    }
    return null;
  }

  private async issueSession(record: { customerId: string; email: string; name: string; hash: string; salt: string; registeredAt: string }): Promise<Session> {
    const token = randomBytes(this.pack.policy.tokenBytes).toString('hex');
    const expiresAt = new Date(Date.now() + this.pack.policy.sessionTtlMinutes * 60_000).toISOString();
    const session: Session = { token, customerId: record.customerId, email: record.email, expiresAt };
    this.sessions.set(token, session);
    if (this.store) {
      await this.store.put({
        id: `ses_${token}`, tenantId: 'aether-identity', typeId: 'et_session',
        validFrom: new Date().toISOString(), validTo: null, recordedAt: new Date().toISOString(), epoch: 1,
        attributes: { customerId: session.customerId, email: session.email, expiresAt },
      });
    }
    return session;
  }

  /** resolve a session token → customer (store-durable, cache-fast; null if unknown/expired) */
  async me(token: string): Promise<(Customer & { expiresAt: string }) | null> {
    // with a durable store, the STORE is authoritative (cross-pod logout/expiry visible)
    let session: Session | null = this.store ? null : this.sessions.get(token) ?? null;
    if (this.store) {
      const rec = await this.store.get(`ses_${token}`, 'aether-identity');
      if (rec) session = { token, customerId: String(rec.attributes.customerId), email: String(rec.attributes.email), expiresAt: String(rec.attributes.expiresAt) };
      else this.sessions.delete(token); // store says gone → drop stale cache
    }
    if (!session) return null;
    if (new Date(session.expiresAt) < new Date()) {
      this.sessions.delete(token);
      if (this.store) await this.store.closeVersion(`ses_${token}`, 'aether-identity', new Date().toISOString());
      return null;
    }
    const record = await this.findUser(session.email);
    return record ? { ...this.toCustomer(record), expiresAt: session.expiresAt } : { customerId: session.customerId, email: session.email, name: '', registeredAt: '', expiresAt: session.expiresAt };
  }

  async logout(token: string): Promise<boolean> {
    const had = this.sessions.delete(token);
    if (this.store) {
      const rec = await this.store.get(`ses_${token}`, 'aether-identity');
      if (rec) await this.store.closeVersion(`ses_${token}`, 'aether-identity', new Date().toISOString());
    }
    return had || Boolean(this.store);
  }

  private toCustomer(r: { customerId: string; email: string; name: string; registeredAt: string }): Customer {
    return { customerId: r.customerId, email: r.email, name: r.name, registeredAt: r.registeredAt };
  }
}

// ---------- Module-as-a-Product contract ----------
const identityModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as IdentityPack;
    const svc = new IdentityService(pack);
    const meter = (ev: string) => billing.meter(ev, 1);
    return {
      register: (e: string, p: string, n: string) => (meter('identity.registered'), svc.register(e, p, n)),
      login: (e: string, p: string) => (meter('identity.login'), svc.login(e, p)),
      me: (t: string) => svc.me(t),
      logout: (t: string) => svc.logout(t),
      __raw: svc,
    };
  },
};

export default identityModule;
