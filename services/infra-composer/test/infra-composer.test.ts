// Tests: infra composer — topology derived from the live product registry,
// shape matching (specific beats '*'), sizing from pack, k8s rendering,
// data-plane wiring, auto-inclusion of new products (PX-INF-002).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InfraComposerService } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/infra-composer-core.json'), 'utf8'));
const svc = () => new InfraComposerService(pack);

test('topology covers EVERY registered product — infra derives from the registry', () => {
  const s = svc();
  const t = s.compose();
  assert.equal(t.productsCovered, s.productCount());
  assert.ok(t.productsCovered >= 20); // every module.json in services/
  assert.equal(t.namespace, 'aether');
  assert.equal(t.runtimeTargetId, 'rt-k8s-anywhere');
});

test('shape matching: hot-path products get 5 replicas/HPA-50; batch products 1 replica', () => {
  const s = svc();
  const t = s.compose(['mod-checkout', 'mod-onboarding', 'mod-tax']);
  const checkout = t.deployments.find((d) => d.productId === 'mod-checkout')!;
  assert.equal(checkout.sizingClass, 'commerce-hot-path');
  assert.equal(checkout.replicas, 5);
  assert.equal(checkout.hpa!.max, 50);
  assert.equal(checkout.cpuMilli, 1000);
  const onb = t.deployments.find((d) => d.productId === 'mod-onboarding')!;
  assert.equal(onb.sizingClass, 'batch');
  assert.equal(onb.replicas, 1);
  assert.equal(onb.hpa, null);
  const tax = t.deployments.find((d) => d.productId === 'mod-tax')!;
  assert.equal(tax.sizingClass, 'kernel'); // specific entry, not the '*' fallback
  assert.equal(tax.replicas, 3);
});

test('k8s rendering: namespace + Deployments + HPA manifests with correct resources', () => {
  const s = svc();
  const t = s.compose(['mod-checkout']);
  const yaml = s.renderK8s(t);
  assert.match(yaml, /kind: Namespace/);
  assert.match(yaml, /name: aether-mod-checkout/);
  assert.match(yaml, /replicas: 5/);
  assert.match(yaml, /cpu: 1000m/);
  assert.match(yaml, /kind: HorizontalPodAutoscaler/);
  assert.match(yaml, /maxReplicas: 50/);
  assert.match(yaml, /aether-product: "true"/);
  // batch product renders Deployment WITHOUT an HPA
  const t2 = s.compose(['mod-onboarding']);
  const yaml2 = s.renderK8s(t2);
  assert.doesNotMatch(yaml2, /HorizontalPodAutoscaler/);
});

test('data plane: stores + search wired from pack (SQL primary w/ PITR, cache, search)', () => {
  const s = svc();
  const dp = s.renderDataPlane();
  assert.match(dp, /primary-sql.engine: "sql-engine"/);
  assert.match(dp, /primary-sql.ha: "region-pinned"/);
  assert.match(dp, /primary-sql.backup.pitr: "true"/);
  assert.match(dp, /cache.engine: "memory-engine"/);
  assert.match(dp, /search.engine: "memory-search"/);
});

test('fallback shape: unlisted products land on the kernel sizing class via the * rule', () => {
  const s = svc();
  const t = s.compose(['mod-support']); // not named in any specific shape
  const support = t.deployments.find((d) => d.productId === 'mod-support')!;
  assert.equal(support.sizingClass, 'kernel'); // '*' fallback
  assert.equal(support.replicas, 3);
});

test('unknown product rejected — the registry is the only door', () => {
  const s = svc();
  assert.throws(() => s.compose(['mod-nonexistent']), /must be registered/);
});
