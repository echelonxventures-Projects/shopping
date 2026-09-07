// Tests: Market Registry — markets as data, activation matrix, capability
// gating, residency routing, AND the config-only onboarding proof (P2-MKT-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MarketRegistryService } from '../src/index.ts';
import type { MarketEntry, MarketsPack } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/markets.json'), 'utf8')) as MarketsPack;
const svc = () => new MarketRegistryService(pack);

test('five markets loaded from pack as pure data', () => {
  const s = svc();
  assert.deepEqual(s.list().map((m) => m.id).sort(), ['AE', 'BR', 'EU', 'IN', 'US']);
  assert.equal(s.get('EU').currency, 'EUR');
  assert.equal(s.get('IN').taxRegime.kind, 'gst');
});

test('tenant×market activation matrix: resolve only for activated markets', () => {
  const s = svc();
  assert.equal(s.isMarketActiveFor('acmewear', 'US'), true);
  assert.equal(s.isMarketActiveFor('acmewear', 'BR'), false); // not activated
  assert.throws(() => s.resolve('acmewear', 'BR'), /not activated/);
  const resolved = s.resolve('acmewear', 'EU');
  assert.equal(resolved.taxDisplay, 'inclusive');
  assert.equal(resolved.facilitatorLiable, true); // EU marketplace-facilitator from pack
  assert.equal(resolved.returnWindowDays, 14); // EU consumer law
  assert.equal(resolved.eInvoicing, 'EN16931-class');
  assert.equal(resolved.residency, 'eu-central'); // residency cell
});

test('capability gating from data: COD true in IN/AE, false in US/EU', () => {
  const s = svc();
  assert.equal(s.capability('IN', 'cod'), true);
  assert.equal(s.capability('AE', 'cod'), true);
  assert.equal(s.capability('US', 'cod'), false);
  assert.equal(s.capability('EU', 'cod'), false);
  assert.equal(s.capability('BR', 'bnpl'), true);
  assert.equal(s.capability('IN', 'bnpl'), false);
});

test('residency routing: market → data cell (GDPR/DPDP/LGPD sovereignty)', () => {
  const s = svc();
  assert.equal(s.residencyFor('EU'), 'eu-central');
  assert.equal(s.residencyFor('IN'), 'ap-south-1');
  assert.equal(s.residencyFor('BR'), 'sa-east-1');
  assert.equal(s.get('EU').residency.sovereignty, 'gdpr');
});

test('activation lifecycle: activate → resolve works; deactivate → resolve throws; idempotent', () => {
  const s = svc();
  s.activateMarket('acmewear', 'BR'); // config-only activation
  const r = s.resolve('acmewear', 'BR');
  assert.equal(r.taxDisplay, 'inclusive');
  s.activateMarket('acmewear', 'BR'); // idempotent — no duplicate rows
  assert.equal(s.activeMarkets('acmewear').length, 4);
  s.deactivateMarket('acmewear', 'BR');
  assert.throws(() => s.resolve('acmewear', 'BR'), /not activated/);
});

test('CONFIG-ONLY ONBOARDING PROOF: a brand-new market at runtime, zero code', () => {
  const s = svc();
  const before = s.list().length;
  // Singapore — entire market definition is this data object
  s.registerMarket({
    id: 'SG',
    displayName: 'Singapore',
    locales: ['en-SG', 'zh-SG'],
    currency: 'SGD',
    taxRegime: { kind: 'gst', display: 'inclusive', facilitatorLiable: false, adapter: 'tax-sg-class', eInvoicing: 'IRN-class' },
    paymentRails: ['cards', 'paynow', 'grabpay'],
    compliancePacks: ['PCI-DSS-SAQ-A', 'PDPA-SG', 'WCAG-2.2-AA'],
    capabilities: { b2b: true, bnpl: true, cod: false, crossBorderDdp: true, marketplace: true },
    residency: { dataResidency: 'ap-southeast-1', sovereignty: 'pdpa' },
    consumerLaw: { returnWindowDays: 7 },
    idDocumentSchemes: ['NRIC-class'],
  });
  assert.equal(s.list().length, before + 1);
  s.activateMarket('acmewear', 'SG');
  const r = s.resolve('acmewear', 'SG');
  assert.equal(r.market.displayName, 'Singapore');
  assert.equal(r.residency, 'ap-southeast-1');
  assert.equal(s.capability('SG', 'crossBorderDdp'), true);
});

test('market descriptor validation: incomplete entries rejected (config-quality gate)', () => {
  const s = svc();
  assert.throws(
    () =>
      s.registerMarket({
        id: 'XX', displayName: 'Broken', locales: [], currency: 'XXX',
        taxRegime: { kind: 'none', display: 'exclusive', facilitatorLiable: false, adapter: 'x' },
        paymentRails: [], compliancePacks: [], capabilities: {},
        residency: { dataResidency: 'nowhere', sovereignty: 'none' },
        consumerLaw: { returnWindowDays: 0 }, idDocumentSchemes: [],
      }),
    /at least one locale/
  );
  assert.throws(() => s.registerMarket(svc().get('US')), /already registered/); // idempotence guard
  assert.throws(() => s.get('ZZ'), /register it in the markets pack/);
});
