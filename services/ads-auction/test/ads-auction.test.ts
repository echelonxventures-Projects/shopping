// Tests: ads auction — quality scores from pack weights, second-price CPC math,
// slot caps, eligibility (min bid/quality, exhausted budgets), labeling (P4-ECO-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdsAuctionService } from '../src/index.ts';
import type { AdCandidate } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/ads-auction-core.json'), 'utf8'));
const svc = () => new AdsAuctionService(pack);

function ad(over: Partial<AdCandidate> = {}): AdCandidate {
  return {
    adId: 'ad-1', sellerId: 's1', productId: 'p1', bid: 0.50,
    metrics: { ctr: 0.8, relevance: 0.9, sellerRating: 0.7 },
    dailyBudget: 100, spentToday: 0,
    ...over,
  };
}

test('quality score: exact pack-weighted formula', () => {
  const s = svc();
  // 0.8×0.4 + 0.9×0.3 + 0.7×0.3 = 0.32 + 0.27 + 0.21 = 0.80
  assert.equal(s.qualityScore(ad()), 0.8);
});

test('second-price auction: 3 slots from pack; winner pays runner-up rank / own quality', () => {
  const s = svc();
  const a = ad({ adId: 'A', bid: 1.00, metrics: { ctr: 1, relevance: 1, sellerRating: 1 } }); // q=1, rank=1.00
  const b = ad({ adId: 'B', bid: 0.80, metrics: { ctr: 1, relevance: 1, sellerRating: 0.5 } }); // q=0.75(0.4+0.3+0.15)=0.85? compute: .4+.3+.15=0.85 → rank 0.68
  const c = ad({ adId: 'C', bid: 0.60, metrics: { ctr: 0.5, relevance: 0.5, sellerRating: 0.5 } }); // q=0.5 → rank 0.30
  const winners = s.runAuction([b, c, a]);
  assert.equal(winners.length, 3); // pack slots=3
  assert.deepEqual(winners.map((w) => w.adId), ['A', 'B', 'C']); // rank order
  // A pays next rank (0.68) / own quality (1) = 0.68
  assert.equal(winners[0]!.cpc, 0.68);
  // B pays next rank (0.30) / own quality (0.85) = 0.3529... rounded
  assert.ok(Math.abs(winners[1]!.cpc - 0.30 / 0.85) < 0.001);
  // C pays floor (min bid 0.05 — no next rank)
  assert.equal(winners[2]!.cpc, 0.05);
  // labeling mandatory (pack)
  assert.equal(winners[0]!.label, 'Sponsored');
});

test('eligibility: below min bid or min quality excluded; exhausted budgets stop serving', () => {
  const s = svc();
  const cheap = ad({ adId: 'cheap', bid: 0.01 }); // < 0.05 min
  const junk = ad({ adId: 'junk', metrics: { ctr: 0, relevance: 0, sellerRating: 0 } }); // q=0 < 0.3
  const broke = ad({ adId: 'broke', spentToday: 100 }); // budget exhausted
  const good = ad({ adId: 'good' });
  const winners = s.runAuction([cheap, junk, broke, good]);
  assert.equal(winners.length, 1);
  assert.equal(winners[0]!.adId, 'good');
});

test('slot cap from pack: only 3 winners even with 5 candidates', () => {
  const s = svc();
  const many = ['a', 'b', 'c', 'd', 'e'].map((id, i) =>
    ad({ adId: id, bid: 0.9 - i * 0.1, metrics: { ctr: 0.9, relevance: 0.9, sellerRating: 0.9 } })
  );
  const winners = s.runAuction(many);
  assert.equal(winners.length, 3); // pack: slots=3
  assert.deepEqual(winners.map((w) => w.adId), ['a', 'b', 'c']);
});

test('click charging: CPC debits budget; exhaustion reported and future auctions exclude', () => {
  const s = svc();
  const a = ad({ dailyBudget: 1.00, spentToday: 0 });
  const r1 = s.chargeClick(a, 0.30);
  assert.equal(r1.charged, 0.30);
  assert.equal(r1.budgetExhausted, false);
  s.chargeClick(a, 0.30);
  s.chargeClick(a, 0.30);
  const state = s.budgetState(a);
  assert.equal(state.spent, 0.90);
  assert.equal(state.exhausted, false);
  const r4 = s.chargeClick(a, 0.30); // → 1.20 ≥ 1.00 budget
  assert.equal(r4.budgetExhausted, true);
  assert.equal(s.budgetState(a).exhausted, true);
  // exhausted ad excluded from the next auction
  const winners = s.runAuction([a]);
  assert.equal(winners.length, 0);
});
