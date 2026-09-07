// @aether/service-app-marketplace — partner app store + developer sandboxes +
// review pipeline + signed distribution (P2-ECO-001). Module-as-a-Product:
// revenue tiers, sandbox quotas, review workflow, signing policy are PACK DATA.
// The products sold here are themselves AetherModules (Everything-is-a-Product
// recursion: the marketplace sells modules like the ones the platform runs on).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowEngine } from '@aether/kernel-runtime/src/index.ts';
import type { WorkflowDef } from '@aether/kernel-primitives';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface AppMarketplacePack {
  pack: { name: string };
  revenueShare: Array<{ tier: string; platformPct: number; minPrice: number }>;
  sandbox: {
    quota: { apiCallsPerDay: number; storageMb: number; sandboxTtlDays: number };
    dataPolicy: string;
    features: Record<string, boolean>;
  };
  reviewWorkflow: WorkflowDef;
  signingPolicy: { required: boolean; algorithm: string; minKeyBits: number };
}

export interface PartnerApp {
  appId: string;
  devId: string;
  name: string;
  version: string;
  category: string;
  price: { amount: number; currency: string };
  tier: string;
  status: string;
  signed: boolean;
  reviewEvents: Array<{ at: string; from: string; to: string; trigger: string }>;
  installs: number;
}

export interface Sandbox {
  sandboxId: string;
  devId: string;
  createdAt: string;
  expiresAt: string;
  usage: { apiCallsToday: number; storageMb: number };
  dataPolicy: string;
}

export class AppMarketplaceService {
  private pack: AppMarketplacePack;
  private wf: WorkflowEngine;
  private apps = new Map<string, PartnerApp>();
  private sandboxes = new Map<string, Sandbox>();
  private seq = 0;
  private sbSeq = 0;

  constructor(pack: AppMarketplacePack) {
    this.pack = pack;
    this.wf = new WorkflowEngine([pack.reviewWorkflow]);
  }

  /** developer submits an app for review — must be signed if policy requires */
  submit(input: { devId: string; name: string; version: string; category: string; price: { amount: number; currency: string }; tier?: string; signed: boolean }): PartnerApp {
    if (this.pack.signingPolicy.required && !input.signed) {
      throw new Error(`App must be signed (${this.pack.signingPolicy.algorithm}) before submission — signing policy is pack data`);
    }
    const tier = input.tier ?? 'standard';
    const tierDef = this.pack.revenueShare.find((t) => t.tier === tier)!;
    if (input.price.amount < tierDef.minPrice) throw new Error(`Price below tier ${tier} minimum`);
    const initial = this.wf.initial('app-review') ?? 'submitted';
    const app: PartnerApp = {
      appId: `app-${++this.seq}`, devId: input.devId, name: input.name, version: input.version,
      category: input.category, price: input.price, tier, status: initial, signed: input.signed,
      reviewEvents: [], installs: 0,
    };
    this.apps.set(app.appId, app);
    return app;
  }

  /** review transition via pack workflow */
  advance(appId: string, to: string, trigger: string): PartnerApp {
    const app = this.get(appId);
    if (!this.wf.canTransition('app-review', app.status, to)) {
      throw new Error(`illegal app-review transition ${app.status} → ${to}`);
    }
    app.reviewEvents.push({ at: new Date().toISOString(), from: app.status, to, trigger });
    app.status = to;
    return app;
  }

  get(appId: string): PartnerApp {
    const a = this.apps.get(appId);
    if (!a) throw new Error(`App ${appId} not found`);
    return a;
  }

  published(): PartnerApp[] {
    return [...this.apps.values()].filter((a) => a.status === 'published');
  }

  /** tenant installs a published app — counts install, computes revenue split */
  install(tenantId: string, appId: string): { installId: string; devRevenue: number; platformRevenue: number } {
    const app = this.get(appId);
    if (app.status !== 'published') throw new Error(`App ${appId} is not published (status=${app.status})`);
    app.installs++;
    const share = this.pack.revenueShare.find((t) => t.tier === app.tier)!;
    const platformRevenue = Math.round(app.price.amount * share.platformPct) / 100;
    const devRevenue = Math.round((app.price.amount - platformRevenue) * 100) / 100;
    return { installId: `inst-${tenantId}-${appId}`, devRevenue, platformRevenue };
  }

  /** provision a developer sandbox (quotas + TTL + synthetic data policy from pack) */
  provisionSandbox(devId: string): Sandbox {
    const q = this.pack.sandbox.quota;
    const sb: Sandbox = {
      sandboxId: `sbx-${++this.sbSeq}`, devId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + q.sandboxTtlDays * 86_400_000).toISOString(),
      usage: { apiCallsToday: 0, storageMb: 0 },
      dataPolicy: this.pack.sandbox.dataPolicy,
    };
    this.sandboxes.set(sb.sandboxId, sb);
    return sb;
  }

  /** sandbox quota enforcement — calls over the daily quota are refused */
  sandboxCall(sandboxId: string): { allowed: boolean; remaining: number } {
    const sb = this.sandboxes.get(sandboxId);
    if (!sb) throw new Error(`Sandbox ${sandboxId} not found`);
    if (sb.expiresAt < new Date().toISOString()) throw new Error(`Sandbox ${sandboxId} expired (TTL ${this.pack.sandbox.quota.sandboxTtlDays}d)`);
    const quota = this.pack.sandbox.quota.apiCallsPerDay;
    if (sb.usage.apiCallsToday >= quota) return { allowed: false, remaining: 0 };
    sb.usage.apiCallsToday++;
    return { allowed: true, remaining: quota - sb.usage.apiCallsToday };
  }

  /** auto-scan simulation: clean apps skip human review (pack triggers) */
  runAutoScan(appId: string, findings: string[]): PartnerApp {
    const app = this.get(appId);
    this.advance(appId, 'auto-scan', 'pipeline-start');
    const flagged = findings.length > 0;
    return this.advance(appId, flagged ? 'human-review' : 'approved', flagged ? 'scan-flagged' : 'scan-clean');
  }
}

const appMarketplaceModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as AppMarketplacePack;
    const svc = new AppMarketplaceService(pack);
    const meter = (ev: string) => billing.meter(ev);
    return {
      submit: (i: Parameters<AppMarketplaceService['submit']>[0]) => (meter('app.submitted'), svc.submit(i)),
      advance: (id: string, to: string, trig: string) => svc.advance(id, to, trig),
      get: (id: string) => svc.get(id),
      published: () => svc.published(),
      install: (t: string, id: string) => (meter('app.installed'), svc.install(t, id)),
      provisionSandbox: (d: string) => (meter('sandbox.provisioned'), svc.provisionSandbox(d)),
      sandboxCall: (id: string) => svc.sandboxCall(id),
      runAutoScan: (id: string, f: string[]) => (meter('app.scanned'), svc.runAutoScan(id, f)),
      __raw: svc,
    };
  },
};

export default appMarketplaceModule;
