// @aether/kernel-uid — U²ID allocation (P0-KRN-010, §3.15).
// ID schemes are registry config (infinite & unlimited): format grammar, alphabet,
// prefixes, opacity, sortability. A Reference Pack default (UUIDv7-class) is swappable.
// Auto-allocation at entity creation; collision-free without coordination.

export interface IdScheme {
  name: string;
  format: 'uuidv7' | 'opaque-random' | 'prefixed-ulid' | 'namespaced' | (string & {});
  prefix?: string;
  length?: number;
  alphabet?: string;
}

export const REFERENCE_SCHEME: IdScheme = { name: 'reference-uuidv7', format: 'uuidv7' };

export interface AllocatedId {
  value: string;
  scheme: string;
  allocatedAt: string;
}

export class UidAllocator {
  schemes: Record<string, IdScheme>;
  constructor(schemes: Record<string, IdScheme> = { 'reference-uuidv7': REFERENCE_SCHEME }) {
    this.schemes = schemes;
  }

  registerScheme(scheme: IdScheme): void {
    this.schemes[scheme.name] = scheme;
  }

  allocate(schemeName: string, entityType?: string): AllocatedId {
    const s = this.schemes[schemeName];
    if (!s) throw new Error(`Unknown ID scheme "${schemeName}" — register it first (registry config)`);
    const value = this.generate(s, entityType);
    return { value, scheme: s.name, allocatedAt: new Date().toISOString() };
  }

  private generate(s: IdScheme, entityType?: string): string {
    switch (s.format) {
      case 'uuidv7': {
        const ts = BigInt(Date.now()) << 16n;
        const rand = crypto.getRandomValues(new Uint8Array(10));
        let r = 0n;
        for (const b of rand) r = (r << 8n) | BigInt(b);
        return `${(ts | (r & 0xffffn)).toString(16).padStart(12, '0')}-${(r >> 16n).toString(16).padStart(10, '0').slice(0, 8)}-${(r >> 48n).toString(16).padStart(8, '0').slice(0, 4).padStart(4, '0')}-a${(r >> 80n).toString(16).slice(0, 3).padStart(3, '0')}-${(r >> 92n).toString(16).slice(0, 10).padStart(10, '0')}`;
      }
      case 'prefixed-ulid': {
        const prefix = s.prefix ?? entityType?.slice(0, 4) ?? 'obj';
        return `${prefix}_${this.generate({ ...s, format: 'uuidv7' }).replace(/-/g, '').slice(0, 20)}`;
      }
      case 'opaque-random': {
        const len = s.length ?? 32;
        const alphabet = s.alphabet ?? '0123456789abcdef';
        const bytes = crypto.getRandomValues(new Uint8Array(len));
        return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
      }
      case 'namespaced': {
        const ns = s.prefix ?? 'us';
        return `${ns}:${this.generate({ ...s, format: 'uuidv7' })}`;
      }
      default:
        throw new Error(`Scheme format "${s.format}" not in Reference Pack — register an adapter (conformance harness, §2.7)`);
    }
  }
}

export class UDictionary {
  // U²D — global dictionary: every ID + external alias → entity. Never reused; retired-not-deleted.
  private map = new Map<string, { entityId: string; entityType: string; epoch: number; retired: boolean }>();
  private canonical = new Map<string, string>();

  register(id: string, entityId: string, entityType: string, epoch: number): void {
    if (this.map.has(id) && this.map.get(id)!.entityId !== entityId) {
      throw new Error(`U²D collision: "${id}" already bound (never-reuse invariant)`);
    }
    this.map.set(id, { entityId, entityType, epoch, retired: false });
  }

  alias(externalId: string, canonicalEntityId: string): void {
    this.canonical.set(externalId, canonicalEntityId);
  }

  resolve(id: string): { entityId: string; entityType: string } | undefined {
    const viaAlias = this.canonical.get(id) ?? id;
    const hit = this.map.get(viaAlias);
    if (!hit || hit.retired) return undefined;
    return { entityId: hit.entityId, entityType: hit.entityType };
  }

  retire(id: string): void {
    const hit = this.map.get(id);
    if (hit) hit.retired = true;
  }

  merge(fromId: string, intoId: string): void {
    const from = this.map.get(fromId);
    const to = this.map.get(intoId);
    if (!from || !to) throw new Error('merge requires both IDs registered');
    from.retired = true;
    this.canonical.set(fromId, intoId);
  }
}
