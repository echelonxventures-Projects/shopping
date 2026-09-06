// @aether/service-search — engine-agnostic search (P1-SRC-001).
// Doctrine 6: the search ENGINE is an adapter behind a SearchEngine SPI; the
// default memory adapter ships in the Reference Pack; OpenSearch-class adapters
// are admitted via the conformance harness. Analyzer behavior (tokenization,
// fuzzy distance) is config. The service projects catalog entities into the
// index via events (CQRS read model).

export interface SearchCapabilities {
  fullText: boolean;
  fuzzy: boolean;
  facets: boolean;
  incrementalIndex: boolean;
}

export interface SearchEngine {
  readonly name: string;
  readonly capabilities: SearchCapabilities;
  index(doc: SearchDoc): Promise<void>;
  remove(id: string, tenantId: string): Promise<void>;
  query(q: SearchQuery): Promise<SearchResult>;
}

export interface SearchDoc {
  id: string;
  tenantId: string;
  typeId: string;
  title: string;
  attributes: Record<string, unknown>; // facet candidates
  text: string; // searchable body
  keywords?: string[];
  score?: number;
}

export interface SearchQuery {
  tenantId: string;
  text?: string;
  filters?: Record<string, string | number | boolean>;
  facets?: string[]; // attribute names to aggregate
  limit?: number;
  fuzzy?: boolean;
}

export interface SearchResult {
  hits: Array<{ id: string; score: number; doc: SearchDoc }>;
  facets: Record<string, Record<string, number>>;
  total: number;
}

// ---- Reference Pack adapter: memory inverted index with facets + fuzzy ----
export class MemorySearchEngine implements SearchEngine {
  readonly name = 'memory-search';
  readonly capabilities: SearchCapabilities = { fullText: true, fuzzy: true, facets: true, incrementalIndex: true };
  private docs = new Map<string, SearchDoc>();
  private tokens = new Map<string, Set<string>>(); // token -> doc keys

  private key(tenantId: string, id: string): string {
    return `${tenantId}:${id}`;
  }

  private tokenize(s: string): string[] {
    return s.toLowerCase().split(/[^a-z0-9\u00c0-\u024f\u0400-\u04ff\u4e00-\u9fff]+/).filter((t) => t.length > 0);
  }

  async index(doc: SearchDoc): Promise<void> {
    const k = this.key(doc.tenantId, doc.id);
    const prior = this.docs.get(k);
    if (prior) this.deindex(prior);
    this.docs.set(k, doc);
    const toks = new Set([...this.tokenize(doc.title), ...this.tokenize(doc.text), ...(doc.keywords ?? []).map((w) => w.toLowerCase())]);
    for (const t of toks) {
      if (!this.tokens.has(t)) this.tokens.set(t, new Set());
      this.tokens.get(t)!.add(k);
    }
  }

  async remove(id: string, tenantId: string): Promise<void> {
    const k = this.key(tenantId, id);
    const doc = this.docs.get(k);
    if (doc) this.deindex(doc);
  }

  private deindex(doc: SearchDoc): void {
    const k = this.key(doc.tenantId, doc.id);
    this.docs.delete(k);
    for (const set of this.tokens.values()) set.delete(k);
  }

  async query(q: SearchQuery): Promise<SearchResult> {
    let candidates = [...this.docs.values()].filter((d) => d.tenantId === q.tenantId);
    if (q.filters) {
      for (const [attr, val] of Object.entries(q.filters)) {
        candidates = candidates.filter((d) => d.attributes[attr] === val);
      }
    }
    if (q.text) {
      const terms = this.tokenize(q.text);
      const scored = new Map<string, { doc: SearchDoc; score: number }>();
      for (const term of terms) {
        const keys = this.matchKeys(term, q.fuzzy !== false);
        for (const k of keys) {
          const doc = this.docs.get(k);
          if (!doc || doc.tenantId !== q.tenantId) continue;
          const entry = scored.get(k) ?? { doc, score: 0 };
          entry.score += term.length; // longer exact token = more signal
          scored.set(k, entry);
        }
      }
      candidates = [...scored.values()].map((e) => ({ ...e.doc, score: e.score }));
      candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    }
    const facets: Record<string, Record<string, number>> = {};
    if (q.facets) {
      for (const attr of q.facets) {
        facets[attr] = {};
        for (const d of candidates) {
          const v = d.attributes[attr];
          if (v === undefined) continue;
          const s = String(v);
          facets[attr]![s] = (facets[attr]![s] ?? 0) + 1;
        }
      }
    }
    const limit = q.limit ?? 20;
    return {
      hits: candidates.slice(0, limit).map((d) => ({ id: d.id, score: d.score ?? 0, doc: d })),
      facets,
      total: candidates.length,
    };
  }

  /** exact match, plus Levenshtein-1 fuzzy fallback when enabled */
  private matchKeys(term: string, fuzzy: boolean): Set<string> {
    const exact = this.tokens.get(term);
    if (exact && exact.size > 0) return exact;
    if (!fuzzy) return exact ?? new Set();
    const out = new Set<string>();
    for (const t of this.tokens.keys()) {
      if (Math.abs(t.length - term.length) <= 1 && levenshtein(t, term) <= 1) {
        for (const k of this.tokens.get(t)!) out.add(k);
      }
    }
    return out;
  }
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j]!;
  }
  return prev[n]!;
}

// ---- Search conformance matrix (admission gate, mirrors storage harness) ----
export interface SearchConformanceCase {
  id: string;
  name: string;
  run: (e: SearchEngine) => Promise<void>;
}

export const SEARCH_CONFORMANCE_MATRIX: SearchConformanceCase[] = [
  {
    id: 'SCTR-IDX-QRY',
    name: 'index then query by text',
    run: async (e) => {
      await e.index({ id: 'd1', tenantId: 't1', typeId: 'et_p', title: 'Cotton Tee', attributes: { color: 'navy' }, text: 'organic cotton short sleeve' });
      const r = await e.query({ tenantId: 't1', text: 'cotton' });
      if (r.total !== 1) throw new Error(`expected 1 hit, got ${r.total}`);
    },
  },
  {
    id: 'SCTR-TENANT-ISO',
    name: 'tenant isolation in search',
    run: async (e) => {
      await e.index({ id: 'd2', tenantId: 'tA', typeId: 'et_p', title: 'X', attributes: {}, text: 'sharedword' });
      const r = await e.query({ tenantId: 'tB', text: 'sharedword' });
      if (r.total !== 0) throw new Error('cross-tenant search leak');
    },
  },
  {
    id: 'SCTR-FACETS',
    name: 'facet aggregation',
    run: async (e) => {
      await e.index({ id: 'f1', tenantId: 't1', typeId: 'et_p', title: 'A', attributes: { color: 'red' }, text: 'w' });
      await e.index({ id: 'f2', tenantId: 't1', typeId: 'et_p', title: 'B', attributes: { color: 'red' }, text: 'w' });
      await e.index({ id: 'f3', tenantId: 't1', typeId: 'et_p', title: 'C', attributes: { color: 'blue' }, text: 'w' });
      const r = await e.query({ tenantId: 't1', text: 'w', facets: ['color'] });
      if (r.facets['color']!['red'] !== 2 || r.facets['color']!['blue'] !== 1) throw new Error('facet counts wrong');
    },
  },
  {
    id: 'SCTR-REMOVE',
    name: 'remove deindexes',
    run: async (e) => {
      await e.index({ id: 'r1', tenantId: 't1', typeId: 'et_p', title: 'Z', attributes: {}, text: 'uniqueword' });
      await e.remove('r1', 't1');
      const r = await e.query({ tenantId: 't1', text: 'uniqueword' });
      if (r.total !== 0) throw new Error('removed doc still searchable');
    },
  },
];

export function runSearchConformance(e: SearchEngine): { admitted: boolean; failures: string[] } {
  return { admitted: false, failures: [] }; // replaced by async wrapper below
}

export async function admitSearchEngine(e: SearchEngine): Promise<{ engine: SearchEngine; admitted: boolean; failures: Array<{ id: string; error: string }> }> {
  const failures: Array<{ id: string; error: string }> = [];
  for (const c of SEARCH_CONFORMANCE_MATRIX) {
    try {
      // fresh state per case not possible generically; cases use unique tenant/doc ids
      await c.run(e);
    } catch (err) {
      failures.push({ id: c.id, error: (err as Error).message });
    }
  }
  return { engine: e, admitted: failures.length === 0, failures };
}

// ---- Search service (CQRS read model over any admitted engine) ----
export class SearchService {
  private engine: SearchEngine;
  constructor(engine: SearchEngine) {
    this.engine = engine;
  }

  /** project a catalog entity into the index (doc shape is contract) */
  async indexProduct(tenantId: string, product: { id: string; title: string; attributes: Record<string, unknown> }, extraText = ''): Promise<void> {
    await this.engine.index({
      id: product.id,
      tenantId,
      typeId: 'et_product',
      title: product.title,
      attributes: product.attributes,
      text: `${product.title} ${extraText} ${Object.values(product.attributes).join(' ')}`,
      keywords: [product.title.toLowerCase()],
    });
  }

  search(q: SearchQuery): Promise<SearchResult> {
    return this.engine.query(q);
  }
}
