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
  private sessions = new Map<string, Session>(); // token → session
  private seq = 0;

  constructor(pack: IdentityPack) {
    this.pack = pack;
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

  register(email: string, password: string, name: string): { customer: Customer; session: Session } {
    const norm = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(norm)) throw new IdentityError('invalid email');
    if (this.users.has(norm)) throw new IdentityError('email already registered', 409);
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
    return { customer: this.toCustomer(record), session: this.issueSession(record) };
  }

  login(email: string, password: string): { customer: Customer; session: Session } {
    const norm = email.trim().toLowerCase();
    const record = this.users.get(norm);
    if (!record) throw new IdentityError('invalid email or password', 401);
    const candidate = scryptSync(password, record.salt, 64);
    const expected = Buffer.from(record.hash, 'hex');
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      throw new IdentityError('invalid email or password', 401);
    }
    return { customer: this.toCustomer(record), session: this.issueSession(record) };
  }

  private issueSession(record: { customerId: string; email: string; name: string; hash: string; salt: string; registeredAt: string }): Session {
    const token = randomBytes(this.pack.policy.tokenBytes).toString('hex');
    const expiresAt = new Date(Date.now() + this.pack.policy.sessionTtlMinutes * 60_000).toISOString();
    const session: Session = { token, customerId: record.customerId, email: record.email, expiresAt };
    this.sessions.set(token, session);
    return session;
  }

  /** resolve a session token → customer (null if unknown/expired) */
  me(token: string): (Customer & { expiresAt: string }) | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (new Date(s.expiresAt) < new Date()) {
      this.sessions.delete(token);
      return null;
    }
    const record = this.users.get(s.email)!;
    return { ...this.toCustomer(record), expiresAt: s.expiresAt };
  }

  logout(token: string): boolean {
    return this.sessions.delete(token);
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
