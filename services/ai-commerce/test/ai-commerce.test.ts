// Tests: AI commerce — visual-search threshold/topK from pack, assistant
// boundaries/tools/escalation, turn limits, EU AI Act transparency (P4-AI-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VisualSearchService, ShoppingAssistantService, ReferenceEmbeddingAdapter, cosine } from '../src/index.ts';
import type { VisualCandidate } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/ai-commerce-core.json'), 'utf8'));

test('visual search: same-category descriptors match; dissimilar filtered by pack threshold', () => {
  const svc = new VisualSearchService(pack);
  const tees = [
    svc.index('p1', 'navy blue cotton crew neck t-shirt short sleeve', 'Navy Tee', 'apparel'),
    svc.index('p2', 'red cotton crew neck t-shirt short sleeve', 'Red Tee', 'apparel'),
    svc.index('p3', 'stainless steel hex bolt m10 50mm a2 thread', 'M10 Bolt', 'hardware'),
  ] as VisualCandidate[];
  const hits = svc.query('blue cotton t-shirt crew neck navy', tees);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0]!.productId, 'p1'); // strongest match first
  assert.ok(hits.every((h) => h.similarity >= pack.visualSearch.similarityThreshold));
  // hardware does not surface for apparel queries
  assert.ok(!hits.some((h) => h.category === 'hardware'));
  // topK from pack
  assert.ok(hits.length <= pack.visualSearch.topK);
});

test('visual search: cross-category query finds the bolt, not the tees', () => {
  const svc = new VisualSearchService(pack);
  const all = [
    svc.index('p1', 'navy cotton t-shirt', 'Navy Tee', 'apparel'),
    svc.index('p3', 'stainless steel hex bolt m10 thread a2', 'M10 Bolt', 'hardware'),
  ] as VisualCandidate[];
  const hits = svc.query('steel hex bolt threaded fastener m10', all);
  assert.ok(hits.some((h) => h.productId === 'p3'));
  assert.ok(!hits.some((h) => h.productId === 'p1'));
});

test('assistant boundaries: payment processing + regulated advice blocked by pack rules', () => {
  const svc = new ShoppingAssistantService(pack);
  const pay = svc.respond('s1', 'Please charge my card now directly');
  assert.equal(pay.action, 'blocked-boundary');
  assert.equal((pay as { boundary: string }).boundary, 'never-process-payments-directly');
  const advice = svc.respond('s1', 'Give me medical advice for this supplement');
  assert.equal(advice.action, 'blocked-boundary');
  assert.equal((advice as { boundary: string }).boundary, 'decline-medical-legal-financial-advice');
});

test('assistant tool use: cart.add/compare/track granted from pack; ungranted tools blocked', () => {
  const svc = new ShoppingAssistantService(pack);
  const cart = svc.respond('s2', 'add to cart the navy tee');
  assert.equal(cart.action, 'tool-call');
  assert.equal((cart as { tool: string }).tool, 'cart.add');
  const track = svc.respond('s2', 'where is my order 123?');
  assert.equal((track as { tool: string }).tool, 'order.track');
  // a pack without cart.add grant blocks it
  const noCart = JSON.parse(JSON.stringify(pack));
  noCart.assistant.tools = ['catalog.search', 'order.track'];
  const restricted = new ShoppingAssistantService(noCart);
  const blocked = restricted.respond('s3', 'add to cart the navy tee');
  assert.equal(blocked.action, 'blocked-boundary');
});

test('assistant escalation: complaint trigger routes to human (pack triggers)', () => {
  const svc = new ShoppingAssistantService(pack);
  const r = svc.respond('s4', 'I have a complaint about this refund dispute');
  assert.equal(r.action, 'escalate-human');
  assert.match((r as { reason: string }).reason, /trigger: (complaint|refund-dispute)/);
});

test('turn limit: sessions cap at pack maxTurns (20), then escalate', () => {
  const svc = new ShoppingAssistantService(pack);
  for (let i = 0; i < pack.assistant.maxTurnsPerSession; i++) {
    const r = svc.respond('s5', `tell me about product ${i}`);
    assert.equal(r.action, 'reply');
  }
  const over = svc.respond('s5', 'one more question');
  assert.equal(over.action, 'escalate-human');
  assert.match((over as { reason: string }).reason, /turn-limit/);
});

test('EU AI Act transparency: every outcome discloses AI interaction (pack policy)', () => {
  const svc = new ShoppingAssistantService(pack);
  assert.equal(pack.transparency.aiActClassification, 'limited-risk');
  const r1 = svc.respond('s6', 'show me cotton tees');
  assert.equal((r1 as { aiDisclosed: boolean }).aiDisclosed, true);
  const r2 = svc.respond('s6', 'compare these two shirts');
  assert.equal((r2 as { aiDisclosed: boolean }).aiDisclosed, true);
});

test('embedding adapter is swappable (Doctrine 6): custom adapter changes results, zero core change', () => {
  const custom: import('../src/index.ts').EmbeddingAdapter = {
    name: 'custom-hash-adapter',
    embed(text: string) {
      const vec = new Array(pack.visualSearch.dimensions).fill(0);
      for (const ch of text.toLowerCase()) vec[ch.charCodeAt(0) % pack.visualSearch.dimensions]! += 1;
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      return vec.map((v) => v / norm);
    },
  };
  const svc = new VisualSearchService(pack, custom);
  const candidates = [
    svc.index('a', 'alpha', 'A', 'x'),
    svc.index('b', 'beta', 'B', 'y'),
  ] as VisualCandidate[];
  const hits = svc.query('alpha', candidates);
  assert.ok(hits.some((h) => h.productId === 'a'));
  // cosine sanity
  assert.ok(cosine([1, 0], [1, 0]) > 0.999);
  void new ReferenceEmbeddingAdapter(4);
});

// ---------- module-contract coverage: every publicApi method exercised ----------
test('module api: indexVisual, visualQuery, assistantRespond, sessionTurns (all publicApi)', async () => {
  const mod = (await import('../src/index.ts')).default;
  const events: string[] = [];
  const api = await mod.create(
    { tenantId: () => 't1', storage: () => null, log: () => {} },
    { meter: (e: string) => events.push(e) },
    { 'ai-commerce-core': pack }
  );
  // indexVisual
  const cand = (api['indexVisual'] as (id: string, txt: string, t: string, c: string) => VisualCandidate)(
    'p9', 'navy blue cotton crew neck t-shirt short sleeve', 'Navy Tee', 'apparel'
  );
  assert.equal(cand.productId, 'p9');
  // visualQuery
  const hits = (api['visualQuery'] as (txt: string, c: VisualCandidate[]) => Array<{ productId: string }>)(
    'navy cotton t-shirt', [cand]
  );
  assert.ok(hits.length >= 1);
  assert.equal(hits[0]!.productId, 'p9');
  // assistantRespond + sessionTurns
  const out = (api['assistantRespond'] as (s: string, m: string) => { action: string; aiDisclosed?: boolean })('sess-1', 'show me navy t-shirts');
  assert.ok(['reply', 'escalate-human', 'refuse'].includes(out.action));
  const turns = (api['sessionTurns'] as (s: string) => Array<{ role: string }>)('sess-1');
  assert.ok(turns.length >= 1);
  assert.ok(events.includes('visual.indexed') && events.includes('visual.queried') && events.includes('assistant.turn'));
});
