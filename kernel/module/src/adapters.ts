// @aether/kernel-module-adapters — generic module wrappers.
// Tier-0 mechanics: wraps pack-driven service classes into the AetherModule
// contract without touching service code. Each wrapper declares which pack
// key feeds the service constructor and which API calls meter which events.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort, ModuleManifest } from '@aether/kernel-module/src/index.ts';

export interface WrapSpec {
  serviceDir: string; // e.g. 'services/tax'
  imports: () => Promise<Record<string, unknown>>; // dynamic import of the service
  build: (svc: unknown, host: HostPort, packs: Record<string, unknown>) => Record<string, unknown>; // raw service from packs+host
  api: (svc: unknown, meter: (ev: string, qty?: number, meta?: Record<string, unknown>) => void, raw: Record<string, unknown>) => Record<string, unknown>;
  meterMap?: Record<string, string>; // apiMethodName -> billing event
}

export function loadManifest(serviceDir: string): ModuleManifest {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '../..');
  return JSON.parse(readFileSync(join(root, serviceDir, 'module.json'), 'utf8')) as ModuleManifest;
}

/** generic wrapper: meters mapped methods, passes everything else through */
export function wrapModule(spec: Omit<WrapSpec, 'serviceDir'> & { serviceDir?: string }): AetherModule {
  const manifest = loadManifest(spec.serviceDir ?? '');
  const module: AetherModule = {
    manifest,
    async create(host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
      const imports = await spec.imports();
      const raw = spec.build(imports, host, packs);
      const meter = (ev: string, qty = 1, meta?: Record<string, unknown>) => billing.meter(ev, qty, meta);
      return spec.api(raw, meter, imports as Record<string, unknown>);
    },
  };
  return module;
}

/** helper: wrap an object's mapped methods with metering; unmapped pass through */
export function meteredApi(
  raw: Record<string, unknown>,
  meter: (ev: string, qty?: number, meta?: Record<string, unknown>) => void,
  meterMap: Record<string, string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'function' && meterMap[k]) {
      const ev = meterMap[k]!;
      out[k] = (...args: unknown[]) => {
        const result = (v as (...a: unknown[]) => unknown)(...args);
        meter(ev);
        return result;
      };
    } else {
      out[k] = v;
    }
  }
  return out;
}
