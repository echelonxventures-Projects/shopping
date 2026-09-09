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
      if (!(f in m) || (m as unknown as Record<string, unknown>)[f] === undefined) {
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

// ---------- Portable Product Bundles (sellable to OTHER platforms) ----------
// A registered module serializes to a self-contained product bundle:
// manifest + bundled packs + entry reference + host/billing contract.
// ANY host (this platform or an external one) can install() the bundle and
// run the product against its own billing — plug-and-play across platforms.

export interface PortableBundle {
  bundleVersion: 1; // bundle format version (contract)
  manifest: ModuleManifest;
  packs: Record<string, unknown>; // full merged pack contents (all data ships)
  sourceDir: string; // relative location of the module's code
  installNotes: {
    hostContract: string;
    billingEvents: Array<{ event: string; unit: string; description: string }>;
    requiredCapabilities: string[];
  };
}

const moduleKernelDir = dirname(fileURLToPath(import.meta.url));
const defaultServicesDir = join(moduleKernelDir, '../../../services');

export class BundleExchange {
  private bundles = new Map<string, PortableBundle>();

  /** export a registered module as a portable product bundle */
  export(runtime: ModuleRuntime, moduleId: string): PortableBundle {
    const listed = runtime.catalog().find((c) => c.id === moduleId);
    if (!listed) throw new Error(`Module "${moduleId}" not registered — nothing to export`);
    const manifest = this.readManifest(moduleId);
    const bundle: PortableBundle = {
      bundleVersion: 1,
      manifest,
      packs: this.readPacks(moduleId),
      sourceDir: moduleIdToDir(moduleId),
      installNotes: {
        hostContract: manifest.hostContract,
        billingEvents: manifest.billing.meterableEvents,
        requiredCapabilities: manifest.capabilities,
      },
    };
    this.bundles.set(moduleId, bundle);
    return bundle;
  }

  /** install a bundle into a ModuleRuntime (same or ANOTHER platform instance) — configured + ready to run */
  async install(runtime: ModuleRuntime, bundle: PortableBundle, modulePath: string): Promise<ModuleHandle> {
    if (bundle.bundleVersion !== 1) throw new Error(`Unsupported bundle version ${bundle.bundleVersion}`);
    const handle = await runtime.register(modulePath);
    if (handle.manifest.id !== bundle.manifest.id) {
      throw new Error(`Bundle/module mismatch: bundle=${bundle.manifest.id} code=${handle.manifest.id}`);
    }
    await runtime.configure(bundle.manifest.id);
    this.bundles.set(bundle.manifest.id, bundle);
    return handle;
  }

  list(): Array<{ id: string; name: string; version: string; pricingModel: string }> {
    return [...this.bundles.values()].map((b) => ({
      id: b.manifest.id,
      name: b.manifest.name,
      version: b.manifest.version,
      pricingModel: b.manifest.billing.pricingModel,
    }));
  }

  private readManifest(moduleId: string): ModuleManifest {
    // resolve from the live runtime's module map via the services dir convention
    const p = join(defaultServicesDir, moduleIdToDir(moduleId), 'module.json');
    return JSON.parse(readFileSync(p, 'utf8')) as ModuleManifest;
  }

  private readPacks(moduleId: string): Record<string, unknown> {
    const manifest = this.readManifest(moduleId);
    const out: Record<string, unknown> = {};
    for (const rel of manifest.packs) {
      const p = join(defaultServicesDir, moduleIdToDir(moduleId), rel);
      const raw = JSON.parse(readFileSync(p, 'utf8')) as { pack?: { name?: string } };
      out[raw.pack?.name ?? rel] = raw;
    }
    return out;
  }
}

function moduleIdToDir(moduleId: string): string {
  // mod-xyz -> xyz (services dir convention)
  const stripped = moduleId.replace(/^mod-/, '');
  if (existsSync(join(defaultServicesDir, stripped))) return stripped;
  if (existsSync(join(defaultServicesDir, moduleId))) return moduleId;
  throw new Error(`Cannot resolve service dir for module "${moduleId}"`);
}

function headlessHost(): HostPort {
  return {
    tenantId: () => 'headless',
    storage: () => null,
    log: () => undefined,
  };
}
