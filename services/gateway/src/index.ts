// @aether/service-gateway — model-driven HTTP surface (Doctrine 1 + Total
// Agnosticism). Every route, auth scope, rate limit, and demo key is PACK
// DATA. The gateway resolves each request by: route match → api-key scope
// check → argument mapping (JSON-path expressions over the request) → module
// apiMethod invocation → JSON response. Adding an endpoint = adding a pack
// entry. The HTTP layer itself uses the host's fetch API via node:http only
// for the listener (swappable adapter surface).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface GatewayRoute {
  method: 'GET' | 'POST';
  path: string;
  module: string;
  api: string;
  scope: string | null;
  map: Record<string, unknown>; // argName -> JSON-path expression
  desc: string;
  argsMode?: 'positional' | 'object'; // how to call the api fn (default: positional spread)
  auth?: boolean; // default true; false = public route (e.g. /health)
  demoSaga?: boolean; // server provides a demo saga adapter (dummy PSP + in-memory stock)
}

export interface GatewayPack {
  pack: { name: string };
  server: { host: string; port: number; publicBaseUrl: string };
  cors: { allowOrigins: string[]; allowMethods: string[] };
  apiKeys: Array<{ key: string; name: string; scopes: string[] }>;
  rateLimits: { requestsPerMinute: number; burst: number };
  routes: Array<{ method: string; path: string; module: string; api: string; scope: string | null; map: string; desc: string }>;
}

export interface GatewayRequestCtx {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export type Responder = (status: number, body: unknown, meter: (ev: string) => void, headers?: Record<string, string>) => void;

/** JSON-path mini-resolver: $.body.productId / $.params.id / $.query.q / literal (quoted or bare) / expr||fallback */
export function resolveExpr(expr: string, ctx: GatewayRequestCtx): unknown {
  const trimmed = expr.trim();
  // full literal (quoted string)
  if (/^".*"$/.test(trimmed)) return trimmed.slice(1, -1);
  // bare literal (no path prefix, no fallback operator)
  if (!trimmed.startsWith('$.') && !trimmed.includes('||')) return trimmed;
  const [path, fallback] = trimmed.split('||');
  const raw = getPath(path.trim(), ctx);
  if (raw !== undefined && raw !== null) {
    // coerce to number when the fallback (or the raw value itself) is numeric
    const fv = fallback?.trim();
    if (fv !== undefined && fv !== '' && /^-?\d+(\.\d+)?$/.test(fv) && typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw)) {
      return Number(raw);
    }
    return raw;
  }
  if (fallback !== undefined) {
    const t = fallback.trim();
    if (t === '[]') return [];
    if (t === 'null') return null;
    if (t === 'true' || t === 'false') return t === 'true';
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    return t.replace(/^"|"$/g, '');
  }
  return undefined;
}

function getPath(p: string, ctx: GatewayRequestCtx): unknown {
  if (!p.startsWith('$.')) return undefined;
  const parts = p.slice(2).split('.');
  let cur: unknown = { body: ctx.body, params: ctx.params, query: ctx.query, headers: ctx.headers };
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export class GatewayService {
  private pack: GatewayPack;
  private apis: Map<string, Record<string, unknown>> = new Map(); // moduleId -> api
  private rateWindow: Array<{ key: string; at: number }> = [];
  private demoSaga: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;

  constructor(pack: GatewayPack) {
    this.pack = pack;
    // route maps arrive as JSON strings in the pack — parse once
    this.routes = pack.routes.map((r) => ({ ...r, map: JSON.parse(r.map) as Record<string, unknown> }));
  }

  routes: GatewayRoute[];

  /** wire a module's api surface into the gateway (module registry → gateway) */
  mount(moduleId: string, api: Record<string, unknown>): void {
    this.apis.set(moduleId, api);
  }

  /** wire a demo-saga adapter: routes with demoSaga=true call through this instead (checkout) */
  mountDemoSaga(fn: (args: Record<string, unknown>) => Promise<unknown>): void {
    this.demoSaga = fn;
  }

  listRoutes(): Array<{ method: string; path: string; scope: string | null; desc: string }> {
    return this.routes.map((r) => ({ method: r.method, path: r.path, scope: r.scope, desc: r.desc }));
  }

  /** OpenAPI 3.1 doc GENERATED from the route pack (contract docs can never drift) */
  openapi(): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const r of this.routes) {
      const oaPath = r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const op: Record<string, unknown> = {
        summary: r.desc,
        operationId: `${r.method}_${r.api}_${r.module.replace(/^mod-/, '')}`,
        security: r.scope === null ? [] : [{ apiKey: [r.scope] }],
        responses: {
          200: { description: 'ok — {data: <result>}' },
          401: { description: 'invalid or missing x-api-key' },
          ...(r.scope !== null ? { 403: { description: `scope "${r.scope}" required` } } : {}),
          422: { description: 'handler error (message from pack data)' },
          429: { description: 'rate limit exceeded' },
        },
      };
      if (r.method === 'POST') {
        (op as Record<string, unknown>)['requestBody'] = {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        };
      }
      paths[oaPath] = { [r.method.toLowerCase()]: op };
    }
    return {
      openapi: '3.1.0',
      info: {
        title: 'AetherCommerce Local Demo API',
        version: this.pack.pack.version,
        description: 'Every route, scope, and key is PACK DATA (gateway-core.json). Generated from the pack — cannot drift.',
      },
      servers: [{ url: this.pack.server.publicBaseUrl }],
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key', description: 'demo-admin-key-0000 / demo-shopper-key-0000 (pack data)' },
        },
      },
      security: [{ apiKey: [] }],
      paths,
    };
  }

  private keyScopes(key: string | undefined): string[] | null {
    if (!key) return null;
    const k = this.pack.apiKeys.find((x) => x.key === key);
    return k ? k.scopes : null;
  }

  private rateOk(key: string): boolean {
    const now = Date.now();
    this.rateWindow = this.rateWindow.filter((r) => now - r.at < 60_000);
    const mine = this.rateWindow.filter((r) => r.key === key).length;
    if (mine >= this.pack.rateLimits.requestsPerMinute) return false;
    this.rateWindow.push({ key, at: now });
    return true;
  }

  private match(method: string, path: string): { route: GatewayRoute; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const rp = route.path.split('/').filter(Boolean);
      const pp = path.split('/').filter(Boolean);
      if (rp.length !== pp.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < rp.length; i++) {
        if (rp[i]!.startsWith(':')) params[rp[i]!.slice(1)] = decodeURIComponent(pp[i]!);
        else if (rp[i] !== pp[i]) { ok = false; break; }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  /** core request handler — pure, testable without any server */
  async handle(ctx: GatewayRequestCtx, meter: (ev: string) => void): Promise<{ status: number; body: unknown }> {
    meter('gateway.request');
    const apiKey = ctx.headers['x-api-key'];
    const scopes = this.keyScopes(apiKey);
    const routeAuth = this.match(ctx.method, ctx.path)?.route.auth ?? true;
    if (routeAuth && this.pack.apiKeys.length > 0 && scopes === null) {
      meter('gateway.401');
      return { status: 401, body: { error: 'invalid or missing x-api-key', hint: 'demo keys are pack data — see gateway-core pack apiKeys' } };
    }
    if (!this.rateOk(apiKey ?? 'anon')) {
      meter('gateway.429');
      return { status: 429, body: { error: 'rate limit exceeded', limitPerMinute: this.pack.rateLimits.requestsPerMinute } };
    }
    const matched = this.match(ctx.method, ctx.path);
    if (!matched) {
      meter('gateway.4xx');
      return { status: 404, body: { error: 'no such route', available: this.listRoutes().length, hint: 'GET /health lists routes' } };
    }
    const { route, params } = matched;
    if (route.scope !== null && !scopes!.includes(route.scope)) {
      meter('gateway.401');
      return { status: 403, body: { error: `scope "${route.scope}" required`, keyScopes: scopes } };
    }
    const api = this.apis.get(route.module);
    const fnRaw = api?.[route.api];
    if (typeof fnRaw !== 'function') {
      return { status: 503, body: { error: `module "${route.module}" not mounted or api "${route.api}" missing` } };
    }
    const args: Record<string, unknown> = {};
    for (const [argName, expr] of Object.entries(route.map)) {
      args[argName] = resolveExpr(String(expr), { ...ctx, params });
    }
    try {
      // demo-saga routes (checkout) route through the mounted adapter
      if (route.demoSaga && this.demoSaga) {
        const result = await this.demoSaga(args);
        return { status: 200, body: { data: result ?? null } };
      }
      const fn = (fnRaw as (...a: unknown[]) => unknown);
      const result = route.argsMode === 'object'
        ? await fn(args)
        : await fn(...Object.values(args));
      return { status: 200, body: { data: result ?? null } };
    } catch (err) {
      meter('gateway.4xx');
      return { status: 422, body: { error: (err as Error).message } };
    }
  }

  /** bind a real HTTP listener (node:http adapter — swappable runtime) */
  async listen(handler: (req: unknown, res: unknown) => void): Promise<{ url: string }> {
    const { createServer } = await import('node:http');
    const srv = createServer(handler as never);
    const { host, port, publicBaseUrl } = this.pack.server;
    await new Promise<void>((resolve) => srv.listen(port, host, resolve));
    return { url: publicBaseUrl };
  }
}

// ---------- Module-as-a-Product contract ----------
const gatewayModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as GatewayPack;
    const svc = new GatewayService(pack);
    const meter = (ev: string) => billing.meter(ev, 1);
    return {
      mount: (id: string, api: Record<string, unknown>) => svc.mount(id, api),
      mountDemoSaga: (fn: (args: Record<string, unknown>) => Promise<unknown>) => svc.mountDemoSaga(fn),
      routes: () => (meter('gateway.request'), svc.listRoutes()),
      openapi: () => (meter('gateway.request'), svc.openapi()),
      handle: (ctx: GatewayRequestCtx) => svc.handle(ctx, meter),
      __raw: svc,
    };
  },
};

export default gatewayModule;
