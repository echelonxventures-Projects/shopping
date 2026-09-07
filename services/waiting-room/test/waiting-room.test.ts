// Tests: virtual waiting room — burst admission caps, FIFO queue + ETA,
// slot holds + reclaim + early release, per-user caps, full-queue rejection (P3-SCL-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WaitingRoomService } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/waiting-room-core.json'), 'utf8'));
const svc = () => new WaitingRoomService(pack);

test('admission cap from pack: exactly 500 admitted per second, rest queued with positions', () => {
  const s = svc();
  const t0 = 1_700_000_000_000;
  let admitted = 0;
  let queued = 0;
  for (let i = 0; i < 1000; i++) {
    const r = s.join(`user-${i}`, t0);
    if (r.status === 'admitted') admitted++;
    if (r.status === 'queued') queued++;
  }
  assert.equal(admitted, 500); // pack: 500/sec
  assert.equal(queued, 500);
  const stats = s.stats();
  assert.equal(stats.admittedThisSecond, 500);
});

test('FIFO queue: deterministic positions + ETA from admission rate', () => {
  const s = svc();
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 600; i++) s.join(`user-${i}`, t0);
  const r = s.join('user-600', t0); // position 101
  assert.equal(r.status, 'queued');
  assert.equal((r as { position: number }).position, 101); // 600 − 500 admitted = 100 queued ahead
  const eta = (r as { etaSeconds: number }).etaSeconds;
  assert.equal(eta, 1); // ceil(101/500)
});

test('drain: queue empties as the bucket refills next second; slot holds expire after 600s', () => {
  const s = svc();
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 900; i++) s.join(`user-${i}`, t0); // 500 admitted, 400 queued
  assert.equal(s.queueDepth(), 400);
  const admittedNext = s.drain(t0 + 1000); // next second — full 500 bucket
  assert.equal(admittedNext, 400); // everyone drained
  assert.equal(s.queueDepth(), 0);
  // holds expire: 600s later all slots reclaimed
  s.drain(t0 + 601_000);
  assert.equal(s.stats().activeSlots, 0);
});

test('early release: checkout completes → slot freed immediately (fresh admission possible)', () => {
  const s = svc();
  const t0 = 1_700_000_000_000;
  const first = s.join('shopper', t0) as { status: string; slotId: string };
  assert.equal(first.status, 'admitted');
  assert.equal(s.release(first.slotId), true);
  // bucket is refilled-capable next second; shopper can re-enter (per-user cap respected)
  const again = s.join('shopper', t0 + 1000) as { status: string };
  assert.equal(again.status, 'admitted');
  assert.equal(s.release('slot-nonexistent'), false);
});

test('per-user session cap: duplicate joins return the existing slot, no double-admission', () => {
  const s = svc();
  const t0 = 1_700_000_000_000;
  const first = s.join('dup-user', t0) as { slotId: string };
  const second = s.join('dup-user', t0 + 5) as { status: string; slotId: string };
  assert.equal(second.status, 'rejected-duplicate');
  assert.equal(second.slotId, first.slotId);
});

test('queue-full behavior from pack: reject-with-retry-after at 250k capacity', () => {
  const s = svc();
  const t0 = 1_700_000_000_000;
  // single-second burst: 500 admitted, queue fills toward the 250k pack cap
  let full: { status: string; retryAfterSeconds?: number } | null = null;
  for (let i = 0; i < 250_600; i++) {
    const r = s.join(`u-${i}`, t0); // same second — no drain, bucket exhausted once
    if (r.status === 'rejected-full') {
      full = r;
      break;
    }
  }
  assert.ok(full, 'queue must fill at 250k');
  assert.equal(full!.status, 'rejected-full');
  assert.equal(full!.retryAfterSeconds, 60); // pack retry-after
  assert.equal(s.queueDepth(), 250_000); // at capacity
});
