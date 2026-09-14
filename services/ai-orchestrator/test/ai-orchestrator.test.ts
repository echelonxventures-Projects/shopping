// Tests: AI Tool Orchestrator — the free-first law, billing-tier gating,
// per-task/tenant routing, bitemporal provider pricing, budget guards,
// fallback chains, markup billing, KMS credential refs. All from pack data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AiOrchestratorService, type AiOrchestratorPack, type ModelAdapter, type RouteCandidate } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/ai-orchestrator-core.json'), 'utf8')) as AiOrchestratorPack;
const svc = () => new AiOrchestratorService(pack);

const okAdapter = (name = 'host-adapter'): ModelAdapter & { calls: string[] } => {
  const calls: string[] = [];
  return {
    name,
    calls,
    async complete(c: RouteCandidate, task: string, input: string) {
      calls.push(`${c.providerId}:${task}`);
      return { output: `${task} via ${c.providerId} (${input.length} chars)`, units: 1 };
    },
  };
};

const FREE = { tenantId: 't-1', customerTier: 'free' } as const;
const GROWTH = { tenantId: 't-2', customerTier: 'growth' } as const;
const ENT = { tenantId: 't-3', customerTier: 'enterprise' } as const;

test('THE FREE-FIRST LAW: a free customer gets $0 providers only — quality never buys a paid model', () => {
  const s = svc();
  const d = s.select('recommendation', FREE);
  assert.equal(d.primary.freeTier, true);
  assert.equal(d.primary.unitCostUsd, 0);
  assert.ok(d.candidates.every((c) => c.freeTier)); // no paid anywhere in the chain
  assert.equal(d.estimatedBillableUsd, 0);
});

test('paid customers unlock quality: growth/enterprise route to the best paid model', () => {
  const s = svc();
  const g = s.select('recommendation', GROWTH);
  assert.equal(g.primary.providerId, 'openai-class'); // q 0.96 beats anthropic 0.93
  assert.equal(g.primary.unitCostUsd, 3.2); // current price epoch (validFrom Aug)
});

test('per-task config: internal data-cleaning stays FREE even for paying tenants (priority-85 rule)', () => {
  const s = svc();
  const d = s.select('data-cleaning', ENT);
  assert.equal(d.primary.freeTier, true);
  assert.equal(d.primary.providerId, 'local-inference-class'); // cleaning specialist q0.85
});

test('bitemporal pricing: routing reconstructs at any T (price/quality change = new rows)', () => {
  const s = svc();
  const before = s.select('recommendation', GROWTH, '2026-07-01T00:00:00Z');
  assert.equal(before.primary.providerId, 'openai-class'); // anthropic lacks 'embeddings' → excluded by task requires
  assert.equal(before.primary.unitCostUsd, 2.5); // old price epoch
  const after = s.select('recommendation', GROWTH, '2026-09-01T00:00:00Z');
  assert.equal(after.primary.unitCostUsd, 3.2); // new epoch
  // knowledge-time guard: at 2026-07-25 the Aug price was NOT YET RECORDED → old row still authoritative
  const pre = s.select('recommendation', GROWTH, '2026-07-25T00:00:00Z');
  assert.equal(pre.primary.unitCostUsd, 2.5); // Aug epoch not current at July-25
});

test('per-tenant override rule: t-acme-ent (free tier) gets premium routing via pack rule 95', () => {
  const s = svc();
  const d = s.select('assistant-turn', { tenantId: 't-acme-ent', customerTier: 'free' });
  // tenant rule wants quality+paid, but the CONSTITUTIONAL tier gate wins:
  assert.equal(d.primary.freeTier, true); // free tier NEVER paid models — billing tier is the hard floor
});

test('budget guard: projected spend over monthly budget → DEGRADES to free (pack action)', async () => {
  const s = svc();
  const burn: ModelAdapter = { name: 'burn', async complete() { return { output: 'x', units: 0.8 }; } }; // 2.56/call, budget 500
  let r = await s.select('recommendation', ENT);
  assert.equal(r.primary.freeTier, false);
  let degradedSeen = false;
  for (let i = 0; i < 220 && !degradedSeen; i++) {
    const out = await s.execute('recommendation', ENT, 'input', burn);
    degradedSeen = out.degraded;
  }
  assert.ok(degradedSeen, 'budget exhaustion must degrade to free per pack action');
  const final = await s.select('recommendation', ENT);
  assert.ok(final.candidates.every((c) => c.freeTier)); // chain now free-only
});

test('fallback chain: rate-limited first provider → next candidate serves (pack policy)', async () => {
  const s = svc();
  const flaky: ModelAdapter = {
    name: 'flaky',
    async complete(c: RouteCandidate) {
      if (c.providerId === 'gemini-free-class') throw new Error('HTTP 429 rate_limit_exceeded');
      return { output: 'ok', units: 1 };
    },
  };
  const r = await s.execute('recommendation', FREE, 'hello', flaky);
  assert.equal(r.usedFallback, true);
  assert.notEqual(r.primary.providerId, 'gemini-free-class'); // fell through to local-inference
});

test('usage + markup billing: free platform-absorbs; growth pays cost + 25% margin', async () => {
  const s = svc();
  const a = okAdapter();
  await s.execute('assistant-turn', FREE, 'hi', a); // free → openai-class? NO: free → gemini 0 cost
  const f = s.usageReport('t-1');
  assert.equal(f.totals.costUsd, 0);
  assert.equal(f.totals.absorbedUsd, 0);
  await s.execute('assistant-turn', GROWTH, 'hi', a); // growth → paid openai 3.2 * 0.4 default? adapter returns units=1 → 3.2
  const g = s.usageReport('t-2');
  assert.equal(g.totals.costUsd, 3.2);
  assert.equal(g.totals.billableUsd, 4); // +25% markup
});

test('BYOK: routing carries credential POINTERS (KMS), never secrets', () => {
  const s = svc();
  const d = s.select('recommendation', GROWTH);
  assert.equal(d.primary.credentialRef, 'kms://ai/openai/platform-key');
  assert.ok(!JSON.stringify(d).includes('sk-')); // no raw key material anywhere
});

test('unknown task rejected with pack-data message; estimate agrees with select', () => {
  const s = svc();
  assert.throws(() => s.select('teleportation', FREE), /register it in the pack/);
  const e = s.estimate('recommendation', GROWTH);
  const d = s.select('recommendation', GROWTH);
  assert.equal(e.costUsd, d.estimatedCostUsd);
});

test('module contract: default export AetherModule, metered select/execute/usage', async () => {
  const mod = (await import('../src/index.ts')).default;
  assert.equal(mod.manifest.id, 'mod-ai-orchestrator');
  const events: string[] = [];
  const api = await mod.create(
    { tenantId: () => 't', storage: () => null, log: () => {} },
    { meter: (e: string) => events.push(e) },
    { 'ai-orchestrator-core': pack }
  );
  const sel = await (api['select'] as (t: string, c: unknown) => Promise<{ primary: { freeTier: boolean } }>)('recommendation', FREE);
  assert.equal(sel.primary.freeTier, true);
  const ex = await (api['execute'] as (t: string, c: unknown, i: string, a: ModelAdapter) => Promise<{ output: string }>)('assistant-turn', FREE, 'hey', okAdapter());
  assert.ok(ex.output.includes('assistant-turn'));
  assert.deepEqual(events, ['ai.route.selected', 'ai.task.executed', 'ai.usage.metered']);
});
