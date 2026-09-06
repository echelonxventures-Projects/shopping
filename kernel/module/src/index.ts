// @aether/kernel-module — Module-as-a-Product runtime (Doctrine 5 extension).
//
// Every module in this platform is a SELF-CONTAINED product:
//   - carries its own manifest (name, version, capabilities, pack files, public API)
//   - bundles its own packs (entity types, workflows, rules — zero host coupling)
//   - exposes a typed public API + lifecycle hooks (install/configure/start/stop)
//   - plugs into ANY host (this platform or an external system) via HostPort
//   - is BILLABLE via a swappable BillingPort (usage metering without binding to
//     this platform's monetization service — an external host can wire its own)
//   - is SELLABLE: auto-listed in a module catalog with generated offer metadata
//   - is CUSTOMIZABLE/CONFIGURABLE: every pack it ships can be overridden by the
//     host through ConfigOverrides (merge semantics, tier-scoped)
//
// Kernel code (Tier-0) provides only the mechanics: manifest validation, pack
// merging, lifecycle orchestration, port binding. All content is module data.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- Module Manifest ----------
export interface ModuleManifest {
  name: string; // e.g. '@aether/service-tax'
  id: string; // stable module id for catalog/billing
  version: string; // semver
  kind: 'capability-module';
  displayName: string;
  description: string;
  capabilities: string[]; // e.g. ['tax', 'e-invoicing']
  packs: string[]; // pack file paths bundled INSIDE the module
  publicApi: string[]; // exported API surface (method names)
  configSchema?: Record<string, { type: string; required?: boolean; default?: unknown }>;
  billing: {
    meterableEvents: Array<{ event: string; unit: string; description: string }>;
    pricingModel: 'free' | 'flat' | 'usage' | 'flat+usage'; // host may override via its own BillingPort
    suggestedRate?: { amount: number; currency: string; perUnit?: string };
  };
  dependencies?: Array<{ id: string; minVersion?: string; optional?: boolean }>;
  hostContract: string; // required host port shape version
}

// ---------- Host Ports (plug-and-play into ANY system) ----------
export interface HostPort {
  /** host identity for tenant/actor context */
  tenantId(): string;
  /** host-provided storage (any conformance-admitted engine) */
  storage(): unknown;
  /** host logging */
  log(level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void;
}

/** Billable modules meter usage through this port — host decides the billing system */
export interface BillingPort {
  meter(event: string, qty: number, meta?: Record<string, unknown>): void;
}

/** NO-OP default billing — module runs unbilled outside a billing host */
export class NullBillingPort implements BillingPort {
  meter(): void {
    /* plug-and-play without a billing host */
  }
}

// ---------- Config override (customisable + configurable) ----------
export interface ConfigOverride {
  scope: 'host' | 'tenant';
  tenantId?: string;
  packName?: string; // which bundled pack to override
  patch: Record<string, unknown>; // deep-merged onto the pack
}

// ---------- Module lifecycle ----------
export type ModuleState = 'registered' | 'configured' | 'started' | 'stopped';

export interface ModuleHandle {
  manifest: ModuleManifest;
  state: ModuleState;
  packs: Record<string, unknown>; // merged (defaults + host overrides)
  api: Record<string, unknown>;
}

// ---------- Module contract every module implements ----------
export interface AetherModule {
  readonly manifest: ModuleManifest;
  /** factory: host overrides applied, ports bound — returns the module's public API */
  create(host: HostPort, billing: BillingPort, packs: Record<string, unknown>): Promise<Record<string, unknown>>;
  start?(api: Record<string, unknown>): Promise<void>;
  stop?(api: Record<string, unknown>): Promise<void>;
}

// ---------- Module Runtime (Tier-0 mechanics) ----------
export class ModuleRuntime {
  private modules = new Map<string, { module: AetherModule; handle: ModuleHandle }>();
  private billing: BillingPort = new NullBillingPort();
  private host: HostPort | null = null;
  private overrides: ConfigOverride[] = [];

  /** host wiring — billing is swappable (this platform's monetization or an external system) */
  bindHost(host: HostPort, billing: BillingPort = new NullBillingPort()): void {
    this.host = host;
    this.billing = billing;
  }

  addConfigOverride(o: ConfigOverride): void {
    this.overrides.push(o);
  }

  private resolveOverrides(packName: string): ConfigOverride[] {
    return this.overrides.filter((o) => (o.packName === undefined || o.packName === packName) && (o.scope === 'host' || o.tenantId === this.host?.tenantId()));
  }

  /** register + validate manifest, load bundled packs, apply overrides, build API */
  async register(modulePath: string): Promise<ModuleHandle> {
    const manifestPath = join(modulePath, 'module.json');
    if (!existsSync(manifestPath)) throw new Error(`Module at ${modulePath} missing module.json manifest`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ModuleManifest;
    this.validateManifest(manifest);

    // load module code (must default-export an AetherModule)
    const mod = await import(join(modulePath, 'src/index.ts'));
    const aetherModule = mod.default as AetherModule;
    if (!aetherModule || !aetherModule.create) {
      throw new Error(`Module ${manifest.name} does not implement the AetherModule contract`);
    }

    // load bundled packs, apply host/tenant overrides (deep merge)
    const packs: Record<string, unknown> = {};
    for (const p of manifest.packs) {
      const packPath = join(modulePath, p);
      const raw = JSON.parse(readFileSync(packPath, 'utf8'));
      const merged = this.overrides
        .filter((o) => o.packName === undefined || o.packName === raw.pack?.name)
        .reduce((acc, o) => deepMerge(acc, o.patch), raw);
      packs[raw.pack?.name ?? p] = merged;
    }

    const handle: ModuleHandle = { manifest, state: 'registered', packs, api: {} };
    this.modules.set(manifest.id, { module: aetherModule, handle });
    return handle;
  }

  async configure(moduleId: string): Promise<Record<string, unknown>> {
    const entry = this.require(moduleId);
    if (!this.host) {
      // headless host: modules still run (plug-and-play), just tenant-less
      this.bindHost(headlessHost(), new NullBillingPort());
    }
    const { module, handle } = entry;
    handle.api = await module.create(this.host!, this.billing, handle.packs);
    handle.state = 'configured';
    return handle.api;
  }

  async start(moduleId: string): Promise<void> {
    const { module, handle } = this.require(moduleId);
    if (handle.state !== 'configured') await this.configure(moduleId);
    await module.start?.(this.require(moduleId).handle.api);
    this.require(moduleId).handle.state = 'started';
  }

  async stop(moduleId: string): Promise<void> {
    const { module, handle } = this.require(moduleId);
    await module.stop?.(handle.api);
    handle.state = 'stopped';
  }

  api(moduleId: string): Record<string, unknown> {
    const { handle } = this.require(moduleId);
    if (handle.state === 'registered') throw new Error(`Module ${moduleId} not configured — call configure() first`);
    return handle.api;
  }

  /** MODULE CATALOG: every registered module is sellable (auto-generated offers) */
  catalog(): Array<{
    id: string; name: string; displayName: string; version: string;
    capabilities: string[]; pricingModel: string; suggestedRate?: ModuleManifest['billing']['suggestedRate'];
    packNames: string[]; apiSurface: string[];
  }> {
    return [...this.modules.values()].map(({ handle }) => ({
      id: handle.manifest.id,
      name: handle.manifest.name,
      displayName: handle.manifest.displayName,
      version: handle.manifest.version,
      capabilities: handle.manifest.capabilities,
      pricingModel: handle.manifest.billing.pricingModel,
      suggestedRate: handle.manifest.billing.suggestedRate,
      packNames: Object.keys(handle.packs),
      apiSurface: handle.manifest.publicApi,
    }));
  }

  private require(moduleId: string) {
    const e = this.modules.get(moduleId);
    if (!e) throw new Error(`Module "${moduleId}" not registered`);
    return e;
  }

  private validateManifest(m: ModuleManifest): void {
    const required = ['name', 'id', 'version', 'displayName', 'capabilities', 'packs', 'publicApi', 'billing', 'hostContract'] as const;
    for (const f of required) {
      if (!(f in m) || (m as Record<string, unknown>)[f] === undefined) {
        throw new Error(`Module manifest missing "${f}": ${m.name ?? 'unknown'}`);
      }
    }
    if (!/^[a-z0-9@/.-]+$/.test(m.name)) throw new Error(`Module name must be a package-like id: ${m.name}`);
    if (!/^\d+\.\d+\.\d+/.test(m.version)) throw new Error(`Module version must be semver: ${m.version}`);
    if (!Array.isArray(m.packs) || m.packs.length === 0) throw new Error(`${m.name}: module must bundle at least one pack`);
  }
}

// ---------- helpers ----------
export function deepMerge<T>(base: T, patch: Record<string, unknown>): T {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

function headlessHost(): HostPort {
  return {
    tenantId: () => 'headless',
    storage: () => null,
    log: () => undefined,
  };
}
