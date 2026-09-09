// Tests: context resolution — scope precedence (P0-KRN-004). Platform → Tenant → Market inheritance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextResolver, type ContextualEntry } from '../src/index.ts';

function entry(p: Partial<ContextualEntry>): ContextualEntry {
  return {
    id: 'c1',
    scope: {},
    value: {},
    validFrom: '2026-01-01T00:00:00Z',
    validTo: null,
    recordedAt: '2026-01-01T00:00:00Z',
    ...p,
  };
}

test('tenant-scoped entry beats platform default; market beats tenant', () => {
  const entries = [
    entry({ id: 'size-chart-default', scope: {}, value: { name: 'size-chart', sizes: ['S', 'M', 'L'] } }),
    entry({ id: 'size-chart-brand', scope: { tenant: 'acme' }, value: { name: 'size-chart', sizes: ['XS', 'S', 'M'] } }),
    entry({ id: 'size-chart-brand-eu', scope: { tenant: 'acme', market: 'EU' }, value: { name: 'size-chart', sizes: ['EU-36', 'EU-38'] } }),
  ];
  const r = new ContextResolver(entries);
  const anon = r.pick({ tenant: 'other' }, 'size-chart');
  const brand = r.pick({ tenant: 'acme' }, 'size-chart');
  const brandEu = r.pick({ tenant: 'acme', market: 'EU' }, 'size-chart');
  assert.deepEqual((anon!.value as unknown as { sizes: string[] }).sizes, ['S', 'M', 'L']);
  assert.deepEqual((brand!.value as unknown as { sizes: string[] }).sizes, ['XS', 'S', 'M']);
  assert.deepEqual((brandEu!.value as unknown as { sizes: string[] }).sizes, ['EU-36', 'EU-38']);
});

test('bitemporal market gating: future-dated entry not resolved yet', () => {
  const entries = [
    entry({
      id: 'promo-future',
      scope: { market: 'EU' },
      value: { name: 'promo' },
      validFrom: '2027-01-01T00:00:00Z',
    }),
  ];
  const r = new ContextResolver(entries);
  assert.equal(r.pick({ market: 'EU', atTime: '2026-06-01T00:00:00Z' }, 'promo'), undefined);
  assert.ok(r.pick({ market: 'EU', atTime: '2027-06-01T00:00:00Z' }, 'promo'));
});

test('cache returns same results (hot-path budget design)', () => {
  const r = new ContextResolver([entry({ scope: { tenant: 'acme' }, value: { name: 'theme' } })]);
  const f = { tenant: 'acme' };
  assert.equal(r.resolve(f).length, 1);
  assert.equal(r.resolve(f).length, 1);
});
