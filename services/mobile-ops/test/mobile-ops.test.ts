// Tests: mobile ops — phased rollout gates, forced-upgrade grace, OS floors,
// deep-link routing, push caps + quiet hours (P4-MOB-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MobileOpsService } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/mobile-ops-core.json'), 'utf8'));
const svc = () => new MobileOpsService(pack);

test('phased rollout: pack stages 1%→5%→20%→50%→100%; 24h hold gate between stages', () => {
  const s = svc();
  s.publishRelease('2.4.0', 'production');
  assert.equal(s.rolloutPercent('2.4.0'), 0.01); // stage 0
  assert.throws(() => s.advanceRollout('2.4.0', 10), /hold gate: only 10h/); // below minHoldHours
  s.advanceRollout('2.4.0', 24);
  assert.equal(s.rolloutPercent('2.4.0'), 0.05);
  for (let i = 0; i < 3; i++) s.advanceRollout('2.4.0', 24);
  assert.equal(s.rolloutPercent('2.4.0'), 1.0); // 100%
  assert.throws(() => s.advanceRollout('2.4.0', 24), /already at 100%/);
  assert.throws(() => s.publishRelease('2.5.0', 'nightly'), /Unknown release channel/);
});

test('forced upgrade: grace window warns, then hard-blocks below the floor', () => {
  const s = svc();
  s.publishRelease('3.0.0', 'production');
  s.forceUpgrade('3.0.0');
  const duringGrace = s.clientGate('2.9.9', 5); // 5 days into 14-day grace
  assert.equal(duringGrace.decision, 'deprecate-warn');
  assert.equal((duringGrace as { graceDaysLeft: number }).graceDaysLeft, 9);
  const afterGrace = s.clientGate('2.9.9', 14);
  assert.equal(afterGrace.decision, 'hard-block');
  assert.match((afterGrace as { reason: string }).reason, /forced floor/);
  const current = s.clientGate('3.0.0', 14);
  assert.equal(current.decision, 'allow');
});

test('OS floors from pack: ios<16 and android<10 blocked; equal allowed', () => {
  const s = svc();
  assert.equal(s.osSupported('ios', '16.0'), true);
  assert.equal(s.osSupported('ios', '15.9'), false);
  assert.equal(s.osSupported('android', '10.0'), true);
  assert.equal(s.osSupported('android', '9.5'), false);
  assert.throws(() => s.osSupported('harmony', '1.0'), /Unknown OS/);
});

test('deep links: domain + scheme routes to modules with params; foreign domains rejected', () => {
  const s = svc();
  const product = s.resolveDeepLink('https://app.example.com/product/p-12345');
  assert.deepEqual(product!.params, { productId: 'p-12345' });
  assert.equal(product!.module, 'mod-catalog');
  assert.equal(product!.featureFlag, 'product-deeplink');
  const order = s.resolveDeepLink('https://shop.example.com/order/ord-1');
  assert.equal(order!.module, 'mod-orders');
  const foreign = s.resolveDeepLink('https://evil.example.com/product/p-1');
  assert.equal(foreign, null);
  const unknownRoute = s.resolveDeepLink('https://app.example.com/unknown/path');
  assert.equal(unknownRoute, null);
});

test('push policy: collapse keys gated, quiet hours hold, daily cap 8 from pack', () => {
  const s = svc();
  // unregistered collapse key rejected
  assert.equal(s.canPush('u1', '2026-09-08T12:00:00Z', 'random-key').allowed, false);
  // quiet hours 22:00-08:00
  const quiet = s.canPush('u1', '2026-09-08T23:15:00Z', 'promo');
  assert.equal(quiet.allowed, false);
  assert.match((quiet as { reason: string }).reason, /quiet hours/);
  // daily cap: 8 pushes allowed, 9th blocked
  let last;
  for (let i = 0; i < 8; i++) last = s.canPush('u1', '2026-09-08T12:00:00Z', 'order-update');
  assert.equal(last!.allowed, true);
  const ninth = s.canPush('u1', '2026-09-08T15:00:00Z', 'price-drop');
  assert.equal(ninth.allowed, false);
  assert.match((ninth as { reason: string }).reason, /daily push cap 8/);
  // next day resets
  const nextDay = s.canPush('u1', '2026-09-09T12:00:00Z', 'order-update');
  assert.equal(nextDay.allowed, true);
});
