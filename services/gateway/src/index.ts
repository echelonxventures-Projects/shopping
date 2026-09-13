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
  pack: { name: string; version: string };
  keyProvider?: { mode: string; fileEnvVar?: string };
  server: { host: string; port: number; publicBaseUrl: string };
  cors: { allowOrigins: string[]; allowMethods: string[] };
  apiKeys: Array<{ key: string; name: string; scopes: string[] }>;
  rateLimits: { requestsPerMinute: number; burst: number; store?: string };
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
export function resolveExpr(expr: string, ctx: GatewayRequestCtx, session?: { customerId: string; email: string } | null, cartLines?: Array<Record<string, unknown>> | null): unknown {
  const trimmed = expr.trim();
  // full literal (quoted string)
  if (/^".*"$/.test(trimmed)) return trimmed.slice(1, -1);
  // bare literal (no path prefix, no fallback operator)
  if (!trimmed.startsWith('$.') && !trimmed.includes('||')) return trimmed;
  const [path, fallback] = trimmed.split('||');
  const raw = getPath(path.trim(), ctx, session, cartLines);
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

function getPath(p: string, ctx: GatewayRequestCtx, session?: { customerId: string; email: string } | null, cartLines?: Array<Record<string, unknown>> | null): unknown {
  if (p === '$.session_token') {
    const auth = ctx.headers['authorization'] ?? '';
    return auth.startsWith('Bearer ') ? auth.slice(7) : '';
  }
  if (p === '$.cart_lines') return cartLines;
  if (!p.startsWith('$.')) return undefined;
  const parts = p.slice(2).split('.');
  let cur: unknown = { body: ctx.body, params: ctx.params, query: ctx.query, headers: ctx.headers, session: session ?? undefined };
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
  private identityMe: ((token: string) => { customerId: string; email: string } | null) | null = null;
  private cartTake: ((customerId: string) => Array<Record<string, unknown>>) | null = null;
  private keyProvider: (() => Array<{ key: string; name: string; scopes: string[] }>) | null = null;
  private rateStore: { acquire(key: string, limitPerMinute: number): boolean | Promise<boolean> } | null = null;
  private apiKeys: Array<{ key: string; name: string; scopes: string[] }> = [];

  constructor(pack: GatewayPack) {
    this.pack = pack;
    // route maps arrive as JSON strings in the pack — parse once
    this.routes = pack.routes.map((r) => ({ ...r, method: r.method as 'GET' | 'POST', map: JSON.parse(r.map) as Record<string, unknown> } as GatewayRoute));
    this.apiKeys = this.resolveKeys();
  }

  /** credential source is pack data: demo-inline | secret-file | host-resolved */
  private resolveKeys(): Array<{ key: string; name: string; scopes: string[] }> {
    const mode = this.pack.keyProvider?.mode ?? 'demo-inline';
    if (mode === 'demo-inline') return this.pack.apiKeys;
    if (mode === 'secret-file') {
      const envVar = this.pack.keyProvider?.fileEnvVar ?? 'AETHER_GATEWAY_KEYS_FILE';
      const file = process.env[envVar];
      if (!file) throw new Error(`keyProvider mode secret-file but ${envVar} unset — mount the KMS/Vault agent file (pack data)`);
      return JSON.parse(readFileSync(file, 'utf8')) as Array<{ key: string; name: string; scopes: string[] }>;
    }
    if (mode === 'host-resolved') return []; // host supplies via mountKeyProvider
    throw new Error(`unknown keyProvider mode "${mode}" — add an adapter (pack data), never code`);
  }

  /** external hosts (KMS/Vault-class) inject their own key resolver — plug-and-play */
  mountKeyProvider(resolver: () => Array<{ key: string; name: string; scopes: string[] }>): void {
    this.keyProvider = resolver;
    this.apiKeys = resolver();
  }

  /** shared distributed rate limiter (production pods share one store) */
  mountRateStore(store: { acquire(key: string, limitPerMinute: number): boolean | Promise<boolean> }): void {
    this.rateStore = store;
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

  /** wire the identity service for session-authenticated shopper routes (scope: 'shopper'; sync or async resolver) */
  mountIdentity(me: (token: string) => { customerId: string; email: string } | null | Promise<{ customerId: string; email: string } | null>): void {
    this.identityMe = me as (token: string) => { customerId: string; email: string } | null;
  }

  /** wire cart consumption for shopper checkout ($.cart_lines resolver) */
  mountCartConsume(take: (customerId: string) => Array<Record<string, unknown>>): void {
    this.cartTake = take;
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
    const k = this.apiKeys.find((x) => x.key === key);
    return k ? k.scopes : null;
  }

  private async rateOk(key: string): Promise<boolean> {
    if (this.rateStore) return await this.rateStore.acquire(key, this.pack.rateLimits.requestsPerMinute);
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
    const preMatch = this.match(ctx.method, ctx.path);
    const routeAuth = preMatch?.route.auth ?? true;
    // shopper routes authenticate via Bearer session (not api-key); everything else via api-key
    const isShopperRoute = preMatch?.route.scope === 'shopper';
    if (routeAuth && !isShopperRoute && this.apiKeys.length > 0 && scopes === null) {
      meter('gateway.401');
      return { status: 401, body: { error: 'invalid or missing x-api-key', hint: 'demo keys are pack data — see gateway-core pack apiKeys' } };
    }
    if (!(await this.rateOk(apiKey ?? 'anon'))) {
      meter('gateway.429');
      return { status: 429, body: { error: 'rate limit exceeded', limitPerMinute: this.pack.rateLimits.requestsPerMinute } };
    }
    const matched = this.match(ctx.method, ctx.path);
    if (!matched) {
      meter('gateway.4xx');
      return { status: 404, body: { error: 'no such route', available: this.listRoutes().length, hint: 'GET /health lists routes' } };
    }
    const { route, params } = matched;
    // session-authenticated shopper routes: Bearer token from login/register
    let session: { customerId: string; email: string } | null = null;
    if (route.scope === 'shopper') {
      const auth = ctx.headers['authorization'] ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      session = (this.identityMe ? await this.identityMe(token) : null) as { customerId: string; email: string } | null;
      if (!session) {
        meter('gateway.401');
        return { status: 401, body: { error: 'login required — POST /auth/login first, then Authorization: Bearer <token>' } };
      }
    }
    if (route.scope !== null && route.scope !== 'shopper' && !scopes!.includes(route.scope)) {
      meter('gateway.401');
      return { status: 403, body: { error: `scope "${route.scope}" required`, keyScopes: scopes } };
    }
    const api = this.apis.get(route.module);
    const fnRaw = api?.[route.api];
    if (typeof fnRaw !== 'function') {
      return { status: 503, body: { error: `module "${route.module}" not mounted or api "${route.api}" missing` } };
    }
    // $.cart_lines needs the session's cart resolved BEFORE sync mapping (store may be async)
    let cartLines: Array<Record<string, unknown>> | undefined;
    if (session && Object.values(route.map).some((v) => String(v).includes('$.cart_lines'))) {
      cartLines = this.cartTake ? await (this.cartTake(session.customerId) as unknown as Array<Record<string, unknown>>) : undefined;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, expr] of Object.entries(route.map)) {
      args[argName] = resolveExpr(String(expr), { ...ctx, params }, session, cartLines);
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
