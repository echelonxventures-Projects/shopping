// @aether/kernel-context — Context Resolver (P0-KRN-004/007).
// tenant × market × locale × channel × audience × world × time → applicable
// definition/config. The `world` dimension (Earth/Luna/Mars/any) is a first-class
// context axis — every scoped config can vary per celestial body. Multi-level
// cache toward the <5ms P95 budget (§5).

import { isCurrent, type Bitemporal, type ContextFrame } from '@aether/kernel-primitives';

export type ScopeDimension = 'tenant' | 'market' | 'locale' | 'channel' | 'world';

const DIMS: ScopeDimension[] = ['tenant', 'market', 'locale', 'channel', 'world'];

export interface ContextualEntry extends Bitemporal {
  id: string;
  scope: {
    tenant?: string | null;
    market?: string | null;
    locale?: string | null;
    channel?: string | null;
    world?: string | null;
  };
  value: Record<string, unknown>;
}

export function matchesScope(
  entry: ContextualEntry,
  frame: ContextFrame,
  at?: string
): boolean {
  if (!isCurrent(entry, at ?? frame.atTime)) return false;
  const s = entry.scope;
  for (const dim of DIMS) {
    const scoped = s[dim];
    if (scoped === undefined) continue;
    if (scoped !== null && frame[dim] !== scoped) return false;
    if (scoped === null && frame[dim] !== undefined && frame[dim] !== null) return false;
  }
  return true;
}

export function scopeSpecificity(entry: ContextualEntry): number {
  const s = entry.scope;
  let score = 0;
  for (const dim of DIMS) {
    if (s[dim] !== undefined) score++;
  }
  return score;
}

export class ContextResolver {
  private cache = new Map<string, ContextualEntry[]>();
  private entries: ContextualEntry[];

  constructor(entries: ContextualEntry[]) {
    this.entries = entries;
  }

  private cacheKey(frame: ContextFrame): string {
    return [frame.tenant ?? '*', frame.market ?? '*', frame.locale ?? '*', frame.channel ?? '*', frame.world ?? '*', frame.atTime ?? '*'].join('|');
  }

  resolve(frame: ContextFrame): ContextualEntry[] {
    const key = this.cacheKey(frame);
    let hits = this.cache.get(key);
    if (!hits) {
      // Inheritance precedence (§2.5): most-specific scope wins — Platform → Tenant → Market → Vendor
      hits = this.entries
        .filter((e) => matchesScope(e, frame))
        .sort((a, b) => scopeSpecificity(b) - scopeSpecificity(a));
      this.cache.set(key, hits);
    }
    return hits;
  }

  pick<K extends string>(frame: ContextFrame, name: K):
    | (ContextualEntry & { value: { name: K } & Record<string, unknown> })
    | undefined {
    return this.resolve(frame).find(
      (e) => (e.value as { name?: string }).name === name
    ) as (ContextualEntry & { value: { name: K } & Record<string, unknown> }) | undefined;
  }
}
