// @aether/service-mobile-ops — app release ops: versioning, phased rollout
// with hold gates, forced-upgrade thresholds, deep-link routing, push policies
// (P4-MOB-001). Module-as-a-Product: rollout stages, grace windows, min OS
// versions, deep-link domains/routes, push caps are ALL PACK DATA.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface MobileOpsPack {
  pack: { name: string };
  release: {
    channels: string[];
    phasedRollout: { stages: number[]; minHoldHours: number };
    forcedUpgrade: { belowVersionPolicy: string; graceDays: number };
    minSupported: Record<string, string>;
  };
  deepLinks: {
    domains: string[];
    routes: Array<{ scheme: string; module: string; featureFlag: string }>;
  };
  push: {
    maxPerUserPerDay: number;
    quietHours: { from: string; to: string };
    collapseKeys: string[];
  };
}

export interface ReleaseState {
  version: string;
  channel: string;
  stageIndex: number; // index into pack stages
  promotedAt: number;
  forcedAt: number | null; // when the version became force-required
}

export type GateDecision =
  | { decision: 'allow'; version: string }
  | { decision: 'deprecate-warn'; version: string; graceDaysLeft: number }
  | { decision: 'hard-block'; reason: string };

export class MobileOpsService {
  private pack: MobileOpsPack;
  private releases = new Map<string, ReleaseState>(); // version -> state
  private forceFloor: string | null = null; // minimum required version
  private pushCounts = new Map<string, { day: string; count: number }>();

  constructor(pack: MobileOpsPack) {
    this.pack = pack;
  }

  /** publish a new release into a channel at stage 0 (pack stages) */
  publishRelease(version: string, channel: string): ReleaseState {
    if (!this.pack.release.channels.includes(channel)) {
      throw new Error(`Unknown release channel "${channel}" — pack policy lists ${this.pack.release.channels.join(', ')}`);
    }
    const state: ReleaseState = { version, channel, stageIndex: 0, promotedAt: Date.now(), forcedAt: null };
    this.releases.set(version, state);
    return state;
  }

  /** advance the phased rollout one stage; hold gate from pack enforces pacing */
  advanceRollout(version: string, hoursSincePromotion: number): ReleaseState {
    const rel = this.releases.get(version);
    if (!rel) throw new Error(`Release ${version} not found`);
    if (hoursSincePromotion < this.pack.release.phasedRollout.minHoldHours) {
      throw new Error(`Rollout hold gate: only ${hoursSincePromotion}h since promotion — pack requires ${this.pack.release.phasedRollout.minHoldHours}h minimum between stages`);
    }
    if (rel.stageIndex >= this.pack.release.phasedRollout.stages.length - 1) {
      throw new Error(`Release ${version} already at 100% rollout`);
    }
    rel.stageIndex++;
    rel.promotedAt = Date.now();
    return rel;
  }

  rolloutPercent(version: string): number {
    const rel = this.releases.get(version);
    if (!rel) throw new Error(`Release ${version} not found`);
    return this.pack.release.phasedRollout.stages[rel.stageIndex]!;
  }

  /** mark a version as force-required (old clients hard-blocked after grace) */
  forceUpgrade(version: string): void {
    const rel = this.releases.get(version);
    if (!rel) throw new Error(`Release ${version} not found`);
    rel.forcedAt = Date.now();
    this.forceFloor = version;
  }

  /** the client gate: decide whether an installed client may proceed */
  clientGate(installedVersion: string, daysSinceForce: number): GateDecision {
    if (this.forceFloor === null) return { decision: 'allow', version: installedVersion };
    const policy = this.pack.release.forcedUpgrade;
    if (this.versionGte(installedVersion, this.forceFloor)) {
      return { decision: 'allow', version: installedVersion };
    }
    const daysLeft = policy.graceDays - daysSinceForce;
    if (daysLeft > 0) {
      return { decision: 'deprecate-warn', version: installedVersion, graceDaysLeft: daysLeft };
    }
    return { decision: 'hard-block', reason: `below forced floor ${this.forceFloor} (${policy.belowVersionPolicy})` };
  }

  /** OS floor check from pack (minSupported) */
  osSupported(os: string, osVersion: string): boolean {
    const min = this.pack.release.minSupported[os];
    if (min === undefined) throw new Error(`Unknown OS "${os}" — register minimum in pack`);
    return this.versionGte(osVersion, min);
  }

  /** deep-link resolution: domain + route scheme → target module (pack data) */
  resolveDeepLink(url: string): { module: string; featureFlag: string; params: Record<string, string> } | null {
    try {
      const u = new URL(url);
      const domainOk = this.pack.deepLinks.domains.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`));
      if (!domainOk) return null;
      for (const route of this.pack.deepLinks.routes) {
        const pattern = route.scheme.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)');
        const m = u.pathname.match(new RegExp(`^${pattern}$`));
        if (m) {
          const params: Record<string, string> = {};
          for (const [k, v] of Object.entries(m.groups ?? {})) params[k] = String(v);
          return { module: route.module, featureFlag: route.featureFlag, params };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /** push throttling: per-user daily cap + quiet hours from pack */
  canPush(userId: string, atIso: string, collapseKey: string): { allowed: boolean; reason?: string } {
    if (!this.pack.push.collapseKeys.includes(collapseKey)) {
      return { allowed: false, reason: `collapse key "${collapseKey}" not registered (pack)` };
    }
    const hhmm = atIso.slice(11, 16);
    const q = this.pack.push.quietHours;
    const inQuiet = q.from <= q.to ? hhmm >= q.from && hhmm < q.to : hhmm >= q.from || hhmm < q.to;
    if (inQuiet) return { allowed: false, reason: 'quiet hours (pack policy)' };
    const day = atIso.slice(0, 10);
    const count = this.pushCounts.get(userId);
    if (count && count.day === day && count.count >= this.pack.push.maxPerUserPerDay) {
      return { allowed: false, reason: `daily push cap ${this.pack.push.maxPerUserPerDay} reached` };
    }
    if (count && count.day === day) count.count++;
    else this.pushCounts.set(userId, { day, count: 1 });
    return { allowed: true };
  }

  /** semver-lite compare: 1.2.3 >= 1.2.0 */
  private versionGte(a: string, b: string): boolean {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const x = pa[i] ?? 0, y = pb[i] ?? 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return true;
  }
}

const mobileOpsModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as MobileOpsPack;
    const svc = new MobileOpsService(pack);
    const meter = (ev: string) => billing.meter(ev);
    return {
      publishRelease: (v: string, c: string) => (meter('release.published'), svc.publishRelease(v, c)),
      advanceRollout: (v: string, h: number) => (meter('release.promoted'), svc.advanceRollout(v, h)),
      rolloutPercent: (v: string) => svc.rolloutPercent(v),
      forceUpgrade: (v: string) => svc.forceUpgrade(v),
      clientGate: (v: string, d: number) => svc.clientGate(v, d),
      osSupported: (os: string, v: string) => svc.osSupported(os, v),
      resolveDeepLink: (u: string) => (meter('deeplink.resolved'), svc.resolveDeepLink(u)),
      canPush: (u: string, at: string, k: string) => svc.canPush(u, at, k),
      __raw: svc,
    };
  },
};

export default mobileOpsModule;
