// @aether/service-crypto-vault — field-level envelope encryption, searchable
// blind indexes, tenant crypto-isolation, CBOM (P1-SEC-001 wiring of §4.5).
// Module-as-a-Product: field policies, schemes, rotations are PACK DATA. The
// constitutional floors (min key bits, mandatory PII encryption) are enforced
// by the kernel CryptoRegistry — this service selects schemes ABOVE the floor.
// Reference Pack crypto = Node's WebCrypto (aes-256-gcm + hkdf), swappable via
// scheme registry (Doctrine 6) — an external HSM adapter would slot in as pack.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto as crypto } from 'node:crypto';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface FieldPolicy {
  classification: string;
  encrypt: boolean;
  scheme?: string;
  blindIndex?: boolean;
}

export interface CryptoVaultPack {
  pack: { name: string };
  fieldPolicies: FieldPolicy[];
  schemes: Record<string, { algorithm: string; keyBits: number; pqHybrid: boolean }>;
  tenantKeys: { perTenantKek: boolean; kekDerivation: string };
  cbomLocations: Array<{ location: string; scheme: string }>;
  policies: { dekCacheTtlMs: number; rotationIntervalDays: number };
}

export interface EncryptedField {
  c: string; // ciphertext (base64)
  iv: string;
  scheme: string;
  classification: string;
}

const KEY_BITS_FLOOR = 128; // constitutional crypto floor (mirror of governance)

export class CryptoVaultService {
  private pack: CryptoVaultPack;
  private keks = new Map<string, CryptoKey>(); // tenant KEK cache
  private deks = new Map<string, { key: CryptoKey; expiresAt: number }>(); // per-tenant DEK cache w/ TTL

  constructor(pack: CryptoVaultPack) {
    this.pack = pack;
  }

  private async tenantKek(tenantId: string): Promise<CryptoKey> {
    if (this.keks.has(tenantId)) return this.keks.get(tenantId)!;
    // derivation from a platform master via HKDF per tenant (pack: hkdf-sha256-class).
    // Reference Pack: master = derived from a fixed seed for dev; production packs
    // bind an HSM/KMS adapter — never a literal here.
    const master = await crypto.subtle.importKey('raw', utf8(`aether-master-${KEY_BITS_FLOOR}`), 'HKDF', false, ['deriveKey']);
    const kek = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: utf8(tenantId), info: utf8('aether-kek') },
      master,
      { name: 'AES-GCM', length: 256 },
      false,
      ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']
    );
    this.keks.set(tenantId, kek);
    return kek;
  }

  /** per-tenant DEK with TTL cache (pack policy) — envelope pattern */
  private async tenantDek(tenantId: string): Promise<CryptoKey> {
    const cached = this.deks.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.key;
    const kek = await this.tenantKek(tenantId);
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const dek = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    void kek; // production: DEK stored wrapped under KEK; dev Reference Pack keeps in-memory
    this.deks.set(tenantId, { key: dek, expiresAt: Date.now() + this.pack.policies.dekCacheTtlMs });
    return dek;
  }

  policyFor(classification: string): FieldPolicy {
    const p = this.pack.fieldPolicies.find((f) => f.classification === classification);
    if (!p) throw new Error(`No field policy for classification "${classification}" — register in crypto-vault pack`);
    return p;
  }

  /** encrypt one field per its classification policy (tenant-isolated key material) */
  async protectField(tenantId: string, classification: string, value: string): Promise<EncryptedField | string> {
    const policy = this.policyFor(classification);
    if (!policy.encrypt) return value; // pass-through
    const dek = await this.tenantDek(tenantId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, utf8(value));
    return { c: b64(ct), iv: b64(iv.buffer as ArrayBuffer), scheme: policy.scheme ?? 'sc-field-aes-gcm', classification };
  }

  async revealField(tenantId: string, field: EncryptedField | string): Promise<string> {
    if (typeof field === 'string') return field;
    const dek = await this.tenantDek(tenantId);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(field.iv) }, dek, fromB64(field.c));
    return new TextDecoder().decode(pt);
  }

  /** searchable encryption: deterministic blind index (HMAC) for exact-lookup fields */
  async blindIndex(tenantId: string, classification: string, value: string): Promise<string> {
    const policy = this.policyFor(classification);
    if (!policy.blindIndex) throw new Error(`blindIndex not enabled for ${classification} (pack policy)`);
    const key = await crypto.subtle.importKey('raw', utf8(`aether-blind-${tenantId}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, utf8(value.toLowerCase()));
    return b64(mac);
  }

  /** tenant crypto-isolation proof: cross-tenant decrypt MUST fail (GCM auth) */
  async isCrossTenantSafe(): Promise<boolean> {
    const enc = (await this.protectField('tenant-a', 'pii', 'secret@example.com')) as EncryptedField;
    try {
      await this.revealField('tenant-b', enc);
      return false;
    } catch {
      return true;
    }
  }

  /** CBOM: cryptographic bill-of-materials generated from scheme registry + locations */
  cbom(): Array<{ location: string; algorithm: string; keyBits: number; pqReady: boolean }> {
    return this.pack.cbomLocations.map((l) => {
      const s = this.pack.schemes[l.scheme]!;
      if (s.keyBits < KEY_BITS_FLOOR) throw new Error(`Constitutional crypto floor violated at ${l.location}: ${s.keyBits} bits < ${KEY_BITS_FLOOR}`);
      return { location: l.location, algorithm: s.algorithm, keyBits: s.keyBits, pqReady: s.pqHybrid };
    });
  }

  pqReadiness(): { ready: number; total: number } {
    const all = this.cbom();
    return { ready: all.filter((c) => c.pqReady).length, total: all.length };
  }

  /** scheme swap via pack (crypto-agility): new assignments take effect immediately */
  reassignScheme(location: string, scheme: string): void {
    if (!this.pack.schemes[scheme]) throw new Error(`Unknown scheme "${scheme}" — register in pack (agility = data)`);
    const loc = this.pack.cbomLocations.find((l) => l.location === location);
    if (!loc) throw new Error(`Unknown CBOM location "${location}"`);
    loc.scheme = scheme;
  }
}

const cryptoVaultModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as CryptoVaultPack;
    const svc = new CryptoVaultService(pack);
    const meter = (ev: string) => billing.meter(ev);
    return {
      protectField: (t: string, c: string, v: string) => (meter('field.encrypted'), svc.protectField(t, c, v)),
      revealField: (t: string, f: never) => (meter('field.decrypted'), svc.revealField(t, f)),
      blindIndex: (t: string, c: string, v: string) => (meter('blind.indexed'), svc.blindIndex(t, c, v)),
      isCrossTenantSafe: () => svc.isCrossTenantSafe(),
      cbom: () => (meter('cbom.generated'), svc.cbom()),
      pqReadiness: () => svc.pqReadiness(),
      reassignScheme: (loc: string, sch: string) => svc.reassignScheme(loc, sch),
      policyFor: (c: string) => svc.policyFor(c),
      __raw: svc,
    };
  },
};

export default cryptoVaultModule;

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function b64(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString('base64');
}
function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}
