// @aether/kernel-governance — Config Store + Constitution + Crypto-registry v0
// (P0-GOV-001/002/003, P0-SEC-001). Tier-0 mechanics: publish-with-validation,
// tier gating, floors. All actual policies/keys/schemes are pack data.

// ---- Config Store (P0-GOV-001) ----
export type ConfigTier = 'T0' | 'T1' | 'T2' | 'T3' | 'T-C';

export interface ConfigEntry {
  key: string;
  tier: ConfigTier;
  value: unknown;
  scope: { tenant?: string | null; market?: string | null };
  validFrom: string;
  validTo: string | null;
  publishedBy: string;
}

export interface ConfigValidator {
  (key: string, value: unknown): void;
}

export class ConfigStore {
  private entries: ConfigEntry[] = [];
  private validators = new Map<string, ConfigValidator>();
  private audit: Array<{ at: string; action: string; key: string; actor: string; result: 'accepted' | 'rejected' }> = [];

  registerValidator(keyPrefix: string, v: ConfigValidator): void {
    this.validators.set(keyPrefix, v);
  }

  private validate(key: string, value: unknown): void {
    for (const [prefix, v] of this.validators) {
      if (key.startsWith(prefix)) v(key, value);
    }
  }

  publish(e: Omit<ConfigEntry, 'validFrom' | 'validTo'> & { validFrom?: string }): ConfigEntry {
    this.validate(e.key, e.value);
    const now = new Date().toISOString();
    // supersede only the same key+tier+SCOPE entry (scope-aware versioning)
    const prior = this.entries.find(
      (x) =>
        x.key === e.key && x.tier === e.tier && x.validTo === null &&
        x.scope.tenant === e.scope.tenant && x.scope.market === e.scope.market
    );
    if (prior) prior.validTo = now;
    const entry: ConfigEntry = { ...e, validFrom: e.validFrom ?? now, validTo: null };
    this.entries.push(entry);
    this.audit.push({ at: now, action: 'publish', key: e.key, actor: e.publishedBy, result: 'accepted' });
    return entry;
  }

  reject(key: string, actor: string, reason: string): never {
    this.audit.push({ at: new Date().toISOString(), action: 'publish', key, actor, result: 'rejected' });
    throw new Error(`Config rejected: ${reason}`);
  }

  resolve(key: string, scope?: { tenant?: string | null; market?: string | null }): ConfigEntry | undefined {
    const candidates = this.entries.filter(
      (x) => x.key === key && x.validTo === null &&
        (x.scope.tenant === undefined || x.scope.tenant === null || x.scope.tenant === scope?.tenant) &&
        (x.scope.market === undefined || x.scope.market === null || x.scope.market === scope?.market)
    );
    // most-specific scope wins (tenant+market > tenant > platform)
    return candidates.sort((a, b) => specificity(b) - specificity(a))[0];
  }

  history(key: string): ConfigEntry[] {
    return this.entries.filter((x) => x.key === key);
  }

  auditTrail() {
    return [...this.audit];
  }
}

function specificity(e: ConfigEntry): number {
  let s = 0;
  if (e.scope.tenant !== undefined && e.scope.tenant !== null) s++;
  if (e.scope.market !== undefined && e.scope.market !== null) s++;
  return s;
}

// ---- Constitution (P0-GOV-002) ----
export interface ConstitutionalFloor {
  id: string;
  name: string;
  check: (key: string, value: unknown) => true | string; // true=pass, string=violation msg
}

export interface AmendmentProposal {
  id: string;
  title: string;
  changes: unknown;
  verification: 'pending' | 'verified' | 'failed';
  approvals: string[]; // super-admin principal ids (M-of-N)
  status: 'proposed' | 'enacted' | 'rejected' | 'auto-reverted';
}

export class Constitution {
  floors: ConstitutionalFloor[] = [];
  private proposals: AmendmentProposal[] = [];
  private quorum: { of: number; need: number } = { of: 3, need: 2 }; // M-of-N config

  ratify(floors: ConstitutionalFloor[], quorum: { of: number; need: number }): void {
    this.floors = floors;
    this.quorum = quorum;
  }

  /** automated verification: every floor must pass against every affected config key */
  verify(key: string, value: unknown): { ok: boolean; violations: string[] } {
    const violations: string[] = [];
    for (const f of this.floors) {
      const r = f.check(key, value);
      if (r !== true) violations.push(`${f.name}: ${r}`);
    }
    return { ok: violations.length === 0, violations };
  }

  propose(title: string, changes: unknown): AmendmentProposal {
    const p: AmendmentProposal = { id: `amend-${this.proposals.length + 1}`, title, changes, verification: 'pending', approvals: [], status: 'proposed' };
    this.proposals.push(p);
    return p;
  }

  approve(proposalId: string, principal: string): AmendmentProposal {
    const p = this.proposals.find((x) => x.id === proposalId);
    if (!p) throw new Error('unknown proposal');
    if (!p.approvals.includes(principal)) p.approvals.push(principal);
    if (p.approvals.length >= this.quorum.need && p.verification === 'verified') {
      p.status = 'enacted';
    }
    return p;
  }

  enactAfterVerification(proposalId: string): AmendmentProposal {
    const p = this.proposals.find((x) => x.id === proposalId);
    if (!p) throw new Error('unknown proposal');
    p.verification = 'verified';
    if (p.approvals.length >= this.quorum.need) p.status = 'enacted';
    return p;
  }

  autoRevert(proposalId: string): AmendmentProposal {
    const p = this.proposals.find((x) => x.id === proposalId)!;
    p.status = 'auto-reverted';
    return p;
  }

  enacted(): AmendmentProposal[] {
    return this.proposals.filter((p) => p.status === 'enacted');
  }
}

// ---- Crypto-agility registry (P0-SEC-001) ----
export interface CryptoScheme {
  id: string;
  purpose: 'in-transit' | 'at-rest' | 'field' | 'signing' | 'hashing' | (string & {});
  algorithm: string;
  keyBits: number;
  pqHybrid?: boolean;
  validFrom: string;
  validTo: string | null;
}

export interface CbomEntry {
  purpose: string;
  algorithm: string;
  keyBits: number;
  pqReady: boolean;
  location: string;
}

export class CryptoRegistry {
  private schemes = new Map<string, CryptoScheme>();
  private locations = new Map<string, string>(); // location -> schemeId
  private floors = { minKeyBits: 128, requirePqHybridExternally: false };

  register(s: Omit<CryptoScheme, 'validFrom' | 'validTo'> & { validFrom?: string }): CryptoScheme {
    if (s.keyBits < this.floors.minKeyBits) {
      throw new Error(`Constitutional crypto floor: keyBits ${s.keyBits} < minimum ${this.floors.minKeyBits}`);
    }
    const scheme: CryptoScheme = { ...s, validFrom: s.validFrom ?? new Date().toISOString(), validTo: null };
    this.schemes.set(s.id, scheme);
    return scheme;
  }

  assign(location: string, schemeId: string): void {
    if (!this.schemes.has(schemeId)) throw new Error(`unknown scheme ${schemeId}`);
    this.locations.set(location, schemeId);
  }

  schemeFor(location: string): CryptoScheme {
    const id = this.locations.get(location);
    if (!id) throw new Error(`no scheme assigned for ${location}`);
    return this.schemes.get(id)!;
  }

  /** CBOM: cryptographic bill-of-materials (auto-generated) */
  cbom(): CbomEntry[] {
    return [...this.locations.entries()].map(([location, id]) => {
      const s = this.schemes.get(id)!;
      return { purpose: s.purpose, algorithm: s.algorithm, keyBits: s.keyBits, pqReady: !!s.pqHybrid, location };
    });
  }

  pqReadiness(): { ready: number; total: number } {
    const all = this.cbom();
    return { ready: all.filter((c) => c.pqReady).length, total: all.length };
  }
}
