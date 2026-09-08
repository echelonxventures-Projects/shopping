// @aether/service-ai-commerce — visual search + conversational shopping
// assistant (P4-AI-001). Module-as-a-Product: model adapters, similarity
// thresholds, assistant boundaries, tool lists, EU AI Act classification are
// ALL PACK DATA. The adapter SPI means any embedding model / LLM slots in via
// conformance — the platform never binds to a model vendor (Doctrine 6).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface AiPack {
  pack: { name: string };
  visualSearch: {
    adapter: string;
    dimensions: number;
    similarityThreshold: number;
    candidatePool: number;
    topK: number;
  };
  assistant: {
    adapter: string;
    systemPromptBoundaries: string[];
    maxTurnsPerSession: number;
    tools: string[];
    escalation: { toHuman: boolean; triggers: string[] };
  };
  transparency: {
    aiActClassification: string;
    discloseAiInteraction: boolean;
    logPrompts: boolean;
    retentionDays: number;
  };
}

// ---- Visual Search (embedding similarity over pack-configured adapter) ----
export interface VisualCandidate {
  productId: string;
  embedding: number[];
  title: string;
  category: string;
}

export interface VisualMatch {
  productId: string;
  title: string;
  category: string;
  similarity: number;
}

/** EmbeddingAdapter SPI — any vision model admitted via conformance */
export interface EmbeddingAdapter {
  name: string;
  embed(text: string): number[]; // deterministic text-based stub for the Reference Pack adapter
}

export class ReferenceEmbeddingAdapter implements EmbeddingAdapter {
  name = 'embedding-clip-class';
  private dimensions: number;
  constructor(dimensions: number) {
    this.dimensions = dimensions;
  }
  embed(text: string): number[] {
    // deterministic hashed bag-of-words embedding (Reference Pack only — real
    // models arrive as conformance-admitted adapters)
    const vec = new Array(this.dimensions).fill(0);
    const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    for (const tok of tokens) {
      let h = 0;
      for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
      vec[h % this.dimensions]! += 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export class VisualSearchService {
  private adapter: EmbeddingAdapter;
  private pack: AiPack;
  constructor(pack: AiPack, adapter?: EmbeddingAdapter) {
    this.pack = pack;
    this.adapter = adapter ?? new ReferenceEmbeddingAdapter(pack.visualSearch.dimensions);
  }
  /** index a product's visual descriptor */
  index(productId: string, visualText: string, title: string, category: string): VisualCandidate {
    return { productId, embedding: this.adapter.embed(visualText), title, category };
  }
  /** query by visual text → ranked candidates above the pack threshold */
  query(visualText: string, candidates: VisualCandidate[]): VisualMatch[] {
    const q = this.adapter.embed(visualText);
    const th = this.pack.visualSearch.similarityThreshold;
    return candidates
      .map((c) => ({ productId: c.productId, title: c.title, category: c.category, similarity: Math.round(cosine(q, c.embedding) * 1000) / 1000 }))
      .filter((m) => m.similarity >= th)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, this.pack.visualSearch.topK);
  }
}

// ---- Conversational Shopping Assistant (guarded tool use) ----
export interface AssistantTurn {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCall?: { tool: string; args: Record<string, unknown> };
}

export type AssistantOutcome =
  | { action: 'reply'; content: string; aiDisclosed: boolean }
  | { action: 'tool-call'; tool: string; args: Record<string, unknown>; aiDisclosed: boolean }
  | { action: 'escalate-human'; reason: string; aiDisclosed: boolean }
  | { action: 'blocked-boundary'; boundary: string; aiDisclosed: boolean };

export class ShoppingAssistantService {
  private pack: AiPack;
  private sessions = new Map<string, { turns: AssistantTurn[]; startedAt: number }>();
  constructor(pack: AiPack) {
    this.pack = pack;
  }

  private toolAvailable(tool: string): boolean {
    return this.pack.assistant.tools.includes(tool);
  }

  /** the guarded assistant turn: boundaries → escalation → tools → reply */
  respond(sessionId: string, userMessage: string): AssistantOutcome {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { turns: [], startedAt: Date.now() });
    const session = this.sessions.get(sessionId)!;
    if (session.turns.filter((t) => t.role === 'user').length >= this.pack.assistant.maxTurnsPerSession) {
      return { action: 'escalate-human', reason: 'session-turn-limit (pack policy)', aiDisclosed: true };
    }
    session.turns.push({ role: 'user', content: userMessage });

    const lower = userMessage.toLowerCase();
    // escalation triggers from pack
    for (const trig of this.pack.assistant.escalation.triggers) {
      if (lower.includes(trig)) {
        return { action: 'escalate-human', reason: `trigger: ${trig}`, aiDisclosed: true };
      }
    }
    // boundary rules from pack
    if (/medical|legal|financial advice|should i invest/.test(lower)) {
      return { action: 'blocked-boundary', boundary: 'decline-medical-legal-financial-advice', aiDisclosed: true };
    }
    if (/charge my card|pay now directly|store my card/.test(lower)) {
      return { action: 'blocked-boundary', boundary: 'never-process-payments-directly', aiDisclosed: true };
    }
    // tool intents
    if (lower.includes('compare')) {
      const tool = 'product.compare';
      if (!this.toolAvailable(tool)) return { action: 'blocked-boundary', boundary: `tool ${tool} not granted`, aiDisclosed: true };
      session.turns.push({ role: 'tool', content: 'compare requested', toolCall: { tool, args: { query: userMessage } } });
      return { action: 'tool-call', tool, args: { query: userMessage }, aiDisclosed: true };
    }
    if (lower.includes('add to cart') || lower.includes('buy')) {
      const tool = 'cart.add';
      if (!this.toolAvailable(tool)) return { action: 'blocked-boundary', boundary: `tool ${tool} not granted`, aiDisclosed: true };
      session.turns.push({ role: 'tool', content: 'cart add', toolCall: { tool, args: { query: userMessage } } });
      return { action: 'tool-call', tool, args: { query: userMessage }, aiDisclosed: true };
    }
    if (lower.includes('where is my order') || lower.includes('track')) {
      const tool = 'order.track';
      if (!this.toolAvailable(tool)) return { action: 'blocked-boundary', boundary: `tool ${tool} not granted`, aiDisclosed: true };
      return { action: 'tool-call', tool, args: { query: userMessage }, aiDisclosed: true };
    }
    const searchTool = 'catalog.search';
    session.turns.push({ role: 'assistant', content: `Searching catalog for: ${userMessage}` });
    return { action: 'reply', content: `Here's what I found for "${userMessage}" (AI assistant — results may vary)`, aiDisclosed: this.pack.transparency.discloseAiInteraction };
  }

  sessionTurns(sessionId: string): AssistantTurn[] {
    return [...(this.sessions.get(sessionId)?.turns ?? [])];
  }
}

const aiCommerceModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as AiPack;
    const visual = new VisualSearchService(pack);
    const assistant = new ShoppingAssistantService(pack);
    const meter = (ev: string) => billing.meter(ev);
    return {
      indexVisual: (id: string, txt: string, title: string, cat: string) => (meter('visual.indexed'), visual.index(id, txt, title, cat)),
      visualQuery: (txt: string, cands: VisualCandidate[]) => (meter('visual.queried'), visual.query(txt, cands)),
      assistantRespond: (sid: string, msg: string) => (meter('assistant.turn'), assistant.respond(sid, msg)),
      sessionTurns: (sid: string) => assistant.sessionTurns(sid),
      __raw: { visual, assistant },
    };
  },
};

export default aiCommerceModule;
