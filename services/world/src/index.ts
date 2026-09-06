// @aether/service-world — World-as-ECR (Earth/Luna/Mars/any, zero hardcoding).
// Worlds are ENTITY INSTANCES (World entity type from the pack), orbits and
// trade-lanes are RELATIONSHIPS, per-world SLA/display policy is CONTEXTUAL
// CONFIG (ContextResolver, world dimension), calendars/units/physics are
// CONFIGURATION attributes. The ONLY Tier-0 invariant: the atomic-seconds
// spine (monotonic SI seconds) — all local calendars/units project over it.
// Adding a world = one pack entry. No code changes. Ever.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Registry } from '@aether/kernel-registry/src/index.ts';
import { ContextResolver, type ContextualEntry } from '@aether/kernel-context/src/index.ts';
import type { EntityTypeDef, ContextFrame } from '@aether/kernel-primitives';

export interface WorldsEcrPack {
  pack: { name: string };
  entityTypes: EntityTypeDef[];
  relationshipTypes: unknown[];
  worlds: Array<Record<string, unknown> & { id: string }>;
  relationships: Array<{ typeId: string; fromId: string; toId: string }>;
  worldConfig: ContextualEntry[];
}

export const SPINE_EPOCH_ISO = '1970-01-01T00:00:00Z';

export function isoToSpineSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

export function spineSecondsToIso(spineSeconds: number): string {
  return new Date(spineSeconds * 1000).toISOString();
}

export class WorldService {
  private registry = new Registry();
  private worlds = new Map<string, Record<string, unknown>>();
  private rels: Array<{ typeId: string; fromId: string; toId: string }> = [];
  private resolver: ContextResolver;
  private worldTypeId: string;

  constructor(packPath?: string) {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = packPath ?? join(here, 'packs/worlds.json');
    this.loadPack(path);
    const worldType = this.registry.entityType('World');
    this.worldTypeId = worldType?.id ?? 'et_world';
  }

  /** load an ECR worlds pack: entities, relationships, scoped world config */
  loadPack(path: string): void {
    const pack = JSON.parse(readFileSync(path, 'utf8')) as WorldsEcrPack;
    // publish entity types + relationship types as a registry epoch (bitemporal definitions)
    this.registry.publishEpoch([...pack.entityTypes, ...pack.relationshipTypes]);
    for (const w of pack.worlds) this.worlds.set(w.id, w);
    this.rels = pack.relationships ?? [];
    this.resolver = new ContextResolver(pack.worldConfig ?? []);
  }

  world(id: string): Record<string, unknown> {
    const w = this.worlds.get(id);
    if (!w) throw new Error(`Unknown world "${id}" — register it in the worlds pack (World-as-ECR)`);
    return w;
  }

  list(): Array<{ id: string; displayName: string }> {
    return [...this.worlds.entries()].map(([id, w]) => ({ id, displayName: String(w.displayName) }));
  }

  // ---- relationships ----
  orbits(worldId: string): string[] {
    return this.rels.filter((r) => r.typeId === 'rel_orbits' && r.fromId === worldId).map((r) => r.toId);
  }

  tradeLanes(worldId: string): string[] {
    return this.rels
      .filter((r) => r.typeId === 'rel_trade_lane' && (r.fromId === worldId || r.toId === worldId))
      .map((r) => (r.fromId === worldId ? r.toId : r.fromId));
  }

  // ---- spine <-> local (calendar math is data-driven; spine is the invariant) ----
  private cal(worldId: string): { daySeconds: number; daysPerYear: number; anchor: number; format: string; epochName: string } {
    const w = this.world(worldId);
    return {
      daySeconds: Number(w['daySeconds']),
      daysPerYear: Number(w['daysPerYear']),
      anchor: Number(w['epochAnchorSpineSeconds'] ?? 0),
      format: String(w['displayFormat']),
      epochName: String(w['epochName'] ?? ''),
    };
  }

  toLocalDay(worldId: string, spineSeconds: number): { localDays: number; fractionOfDay: number; localYear: number; dayOfYear: number } {
    const c = this.cal(worldId);
    const sinceEpoch = spineSeconds - c.anchor;
    const localDays = Math.floor(sinceEpoch / c.daySeconds);
    const fractionOfDay = (sinceEpoch % c.daySeconds) / c.daySeconds;
    const localYear = Math.floor(localDays / c.daysPerYear) + 1;
    const dayOfYear = (localDays % c.daysPerYear) + 1;
    return { localDays, fractionOfDay, localYear, dayOfYear };
  }

  formatLocal(worldId: string, spineSeconds: number): string {
    const c = this.cal(worldId);
    const { localYear, dayOfYear } = this.toLocalDay(worldId, spineSeconds);
    return c.format
      .replace('{y}', String(localYear))
      .replace('{doy}', String(dayOfYear).padStart(3, '0'))
      .replace('{u}', String(this.world(worldId)['deliverySlaUnit']));
  }

  formatLocalClock(worldId: string, spineSeconds: number, timeZoneId?: string): string {
    const c = this.cal(worldId);
    let secs = spineSeconds % c.daySeconds;
    if (timeZoneId) {
      const tz = (this.world(worldId)['timeZones'] as Array<{ id: string; offsetSeconds: number }> | undefined)?.find((z) => z.id === timeZoneId);
      if (tz) secs = (((spineSeconds + tz.offsetSeconds) % c.daySeconds) + c.daySeconds) % c.daySeconds;
    }
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // ---- SLA: local units <-> spine seconds ----
  slaToSpineSeconds(worldId: string, qty: number, unit: string): number {
    const w = this.world(worldId);
    if (unit === w['deliverySlaUnit'] || unit === 'local-day') return qty * this.cal(worldId).daySeconds;
    const conv = (w['units'] as { conversions?: Record<string, Record<string, number>> }).conversions?.[unit];
    if (conv?.['spine-seconds']) return qty * conv['spine-seconds'];
    throw new Error(`World ${worldId}: no conversion for SLA unit "${unit}" — add to world pack (configuration)`);
  }

  spineToSlaDisplay(worldId: string, spineSeconds: number): string {
    const unit = String(this.world(worldId)['deliverySlaUnit']);
    const qty = spineSeconds / this.cal(worldId).daySeconds;
    return `${Math.round(qty * 100) / 100} ${unit}${qty === 1 ? '' : 's'}`;
  }

  // ---- units ----
  convertUnit(worldId: string, value: number, from: string, to: string): number {
    if (from === to) return value;
    const units = this.world(worldId)['units'] as { conversions?: Record<string, Record<string, number>> };
    const f = units.conversions?.[from];
    if (!f?.[to]) throw new Error(`World ${worldId}: no conversion ${from} → ${to} (world pack data)`);
    return value * f[to]!;
  }

  // ---- physics-aware logistics (constraints are entity attributes) ----
  logisticsConstraints(worldId: string): Array<{ code: string; rule: string }> {
    return (this.world(worldId)['physics'] as { logisticsConstraints: Array<{ code: string; rule: string }> }).logisticsConstraints;
  }

  shipmentModeAllowed(worldId: string, modeCode: string): boolean {
    return !this.logisticsConstraints(worldId).some((c) => c.code === modeCode && c.rule === 'forbidden');
  }

  // ---- per-world contextual config (SLA policy, weight display basis, ...) ----
  config(frame: ContextFrame, name: string): Record<string, unknown> | undefined {
    return this.resolver.pick(frame, name as never)?.value;
  }

  slaPolicy(worldId: string, tenantId?: string | null): Record<string, unknown> | undefined {
    return this.config({ world: worldId, tenant: tenantId ?? null }, 'sla-policy');
  }

  weightDisplayBasis(worldId: string): { basis: string; factor: number } | undefined {
    return this.config({ world: worldId }, 'weight-display') as { basis: string; factor: number } | undefined;
  }

  get contextResolver(): ContextResolver {
    return this.resolver;
  }
}

// ---------- Module-as-a-Product contract (plug-and-play, billable, configurable) ----------
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

const worldModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, _packs: Record<string, unknown>) {
    const here = dirname(fileURLToPath(import.meta.url));
    const svc = new WorldService(join(here, '../packs/worlds.json'));
    const meter = (ev: string) => billing.meter(ev);
    return {
      world: (id: string) => svc.world(id),
      list: () => svc.list(),
      orbits: (id: string) => svc.orbits(id),
      tradeLanes: (id: string) => svc.tradeLanes(id),
      toLocalDay: (w: string, s: number) => svc.toLocalDay(w, s),
      formatLocal: (w: string, s: number) => (meter('world.format'), svc.formatLocal(w, s)),
      formatLocalClock: (w: string, s: number, tz?: string) => svc.formatLocalClock(w, s, tz),
      slaToSpineSeconds: (w: string, q: number, u: string) => svc.slaToSpineSeconds(w, q, u),
      spineToSlaDisplay: (w: string, s: number) => svc.spineToSlaDisplay(w, s),
      convertUnit: (w: string, v: number, f: string, t: string) => svc.convertUnit(w, v, f, t),
      logisticsConstraints: (w: string) => svc.logisticsConstraints(w),
      shipmentModeAllowed: (w: string, m: string) => svc.shipmentModeAllowed(w, m),
      slaPolicy: (w: string, t?: string | null) => svc.slaPolicy(w, t),
      weightDisplayBasis: (w: string) => svc.weightDisplayBasis(w),
      __raw: svc,
    };
  },
};

export default worldModule;
