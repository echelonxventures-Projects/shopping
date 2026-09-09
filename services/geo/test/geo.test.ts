// Tests: Geo service — zone resolution (priority, postal prefixes), polygon +
// radius geofences, ship-from-store/BOPIS nearest-node routing under pack caps
// (P1-GEO-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GeoService, distanceKm, pointInPolygon, type GeoPack } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/geo-core.json'), 'utf8')) as GeoPack;
const svc = new GeoService(pack);

test('zone resolution: region-scoped zone outranks national fallback (priority from pack)', () => {
  const zones = svc.resolveZones({ country: 'US', region: 'CA' });
  assert.equal(zones[0]!.name, 'us-west'); // priority 50
  assert.equal(zones[1]!.name, 'us-rest'); // fallback 10
  const tx = svc.resolveZones({ country: 'US', region: 'TX' });
  assert.equal(tx.length, 1);
  assert.equal(tx[0]!.name, 'us-rest');
});

test('postal-prefix zones: London congestion zone matches EC/WC/SW1 prefixes only', () => {
  const inZone = svc.resolveZones({ country: 'GB', postalCode: 'EC1A 1BB' });
  assert.equal(inZone[0]!.name, 'london-congestion');
  const outside = svc.resolveZones({ country: 'GB', postalCode: 'M1 4WP' });
  assert.equal(outside[0]!.name, 'gb-national');
  assert.ok(!outside.some((z) => z.name === 'london-congestion'));
});

test('zone data is market-agnostic: unknown country resolves to zero zones (no invented fallback)', () => {
  assert.equal(svc.resolveZones({ country: 'ZZ' }).length, 0);
});

test('polygon geofence: point-in-polygon ray casting — inside SF downtown, outside across the bay', () => {
  const sf = svc.inGeofence([37.79, -122.41]);
  assert.equal(sf.length, 1);
  assert.equal(sf[0]!.effects['instantDelivery'], true);
  assert.equal(svc.inGeofence([37.80, -122.27]).length, 0); // Oakland — outside polygon
  // raw math sanity
  assert.equal(pointInPolygon([0.5, 0.5], [[0, 0], [0, 1], [1, 1], [1, 0]]), true);
  assert.equal(pointInPolygon([1.5, 0.5], [[0, 0], [0, 1], [1, 1], [1, 0]]), false);
});

test('radius geofence: haversine ring — Berlin Mitte inside 10km, Potsdam outside', () => {
  const mitte = svc.inGeofence([52.53, 13.41]);
  assert.equal(mitte.length, 1);
  assert.equal(mitte[0]!.effects['sameDay'], true);
  assert.equal(svc.inGeofence([52.39, 13.06]).length, 0); // Potsdam ~26km away
  // haversine sanity: SF→Oakland ≈ 13km
  const km = distanceKm([37.788, -122.407], [37.804, -122.271]);
  assert.ok(km > 10 && km < 16, `expected ~13km, got ${km}`);
});

test('ship-from-store routing: nearest capable nodes, capability-filtered, distance-capped, maxCandidates', () => {
  const fromSf = svc.nearestNodes([37.79, -122.41], 'ship-from-store');
  // Oakland store lacks ship-from-store; Berlin exceeds 400km cap; Reno FC within
  assert.deepEqual(fromSf.map((c) => c.node.id), ['store_sf_market', 'fc_reno']);
  assert.ok(fromSf[0]!.km < 2);
});

test('BOPIS routing: 25km cap — SF sees both bay stores, Reno FC excluded (no bopis capability)', () => {
  const bopis = svc.nearestNodes([37.79, -122.41], 'bopis');
  assert.deepEqual(bopis.map((c) => c.node.id), ['store_sf_market', 'store_oakland']);
  const remote = svc.nearestNodes([39.0, -120.0], 'bopis'); // Sierra — nothing within 25km
  assert.equal(remote.length, 0);
});

test('module contract: default export AetherModule, metered zone resolution', async () => {
  const mod = (await import('../src/index.ts')).default;
  assert.equal(mod.manifest.id, 'mod-geo');
  const events: string[] = [];
  const api = await mod.create(
    { tenantId: () => 't1', storage: () => null, log: () => {} },
    { meter: (e: string) => events.push(e) },
    { 'geo-core': pack }
  );
  const zones = (api['resolveZones'] as (a: { country: string; region?: string }) => unknown[])({ country: 'US', region: 'CA' });
  assert.equal(zones.length, 2);
  assert.deepEqual(events, ['geo.zone.resolved']);
});
