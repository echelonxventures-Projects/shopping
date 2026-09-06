// @aether/kernel-registry — Metadata Registry with epoch model (P0-KRN-006).
// Source of truth for all entity/relationship/behavior/rule/workflow/policy defs.
// Bitemporal: definitions are versioned, old epochs resolve forever (Doctrine 4).

import {
  validateEntityType,
  isCurrent,
  type RegistryEntry,
  type EpochManifest,
  type EntityTypeDef,
  type EntityInstance,
  type Bitemporal,
} from '@aether/kernel-primitives';

export class Registry {
  private epochs: EpochManifest[] = [];
  private currentEpoch = 0;

  get epoch(): number {
    return this.currentEpoch;
  }

  publishEpoch(entries: RegistryEntry[]): number {
    const next = this.currentEpoch + 1;
    for (const e of entries) {
      if (e.kind === 'entity-type') validateEntityType(e);
    }
    this.epochs.push({
      epoch: next,
      recordedAt: new Date().toISOString(),
      entries,
      supersedes: this.currentEpoch || undefined,
    });
    this.currentEpoch = next;
    return next;
  }

  manifest(atEpoch?: number): EpochManifest {
    if (this.epochs.length === 0) throw new Error('No epochs published');
    const ep = atEpoch ?? this.currentEpoch;
    const m = this.epochs.find((e) => e.epoch === ep);
    if (!m) throw new Error(`Epoch ${ep} not found`);
    return m;
  }

  entriesAt(atEpoch?: number): RegistryEntry[] {
    return this.manifest(atEpoch).entries.filter((e) => isCurrent(e));
  }

  entityType(name: string, atEpoch?: number): EntityTypeDef | undefined {
    return this.entriesAt(atEpoch).find(
      (e): e is EntityTypeDef => e.kind === 'entity-type' && e.name === name
    );
  }
}

export class EntityStore {
  private instances: EntityInstance[] = [];
  private relationships: Array<{
    id: string;
    typeId: string;
    fromId: string;
    toId: string;
    epoch: number;
  } & Bitemporal> = [];

  create(inst: EntityInstance): EntityInstance {
    this.instances.push(inst);
    return inst;
  }

  relate(rel: { id: string; typeId: string; fromId: string; toId: string; epoch: number } & Bitemporal) {
    this.relationships.push(rel);
  }

  byType(typeId: string, at?: string): EntityInstance[] {
    return this.instances.filter((i) => i.typeId === typeId && isCurrent(i, at));
  }

  get(id: string, at?: string): EntityInstance | undefined {
    return this.instances.find((i) => i.id === id && isCurrent(i, at));
  }

  outgoing(fromId: string): Array<{ typeId: string; toId: string }> {
    return this.relationships
      .filter((r) => r.fromId === fromId && isCurrent(r))
      .map((r) => ({ typeId: r.typeId, toId: r.toId }));
  }
}
