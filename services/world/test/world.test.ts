// Tests: World-as-ECR — worlds as entities, orbits/trade-lanes as relationships,
// per-world config via context (world dimension), spine math invariant across
// Earth/Luna/Mars, physics-aware logistics — zero hardcoding (P1-WLD-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorldService, isoToSpineSeconds, spineSecondsToIso, type WorldsEcrPack } from '../src/index.ts';
import { writeFileSync, rmSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const PACK_PATH = join(here, '../packs/worlds.json');
const pack = JSON.parse(readFileSync(PACK_PATH, 'utf8')) as WorldsEcrPack;
const svc = () => new WorldService(PACK_PATH);

test('worlds are entities from pack: earth/luna/mars all present; unknown rejected', () => {
  const s = svc();
  assert.deepEqual(s.list().map((w) => w.id).sort(), ['earth', 'luna', 'mars']);
  assert.equal((s.world('mars')['displayName']), 'Mars');
  assert.throws(() => s.world('europa'), /register it in the worlds pack/);
});

test('adding a world = pure pack data (zero code): register a new world at runtime', () => {
  const s = svc();
  const newPack: WorldsEcrPack = {
    ...pack,
    worlds: [
      ...pack.worlds,
      {
        id: 'europa', displayName: 'Europa (Jupiter IV)', calendarName: 'Europan', daySeconds: 99600,
        daysPerYear: 350, displayFormat: '{y} Eu-Day {doy} ({u})', epochName: 'ECE', epochAnchorSpineSeconds: 2000000000,
        units: { length: 'm', mass: 'kg', time: 'hour', speed: 'kmh', temperature: 'celsius', currency: 'EURP', conversions: { hour: { 'spine-seconds': 3600 } } },
        physics: { gravityMs2: 1.315, atmosphere: 'none', radiationLevel: 'high', logisticsConstraints: [{ code: 'submersible', rule: 'allowed' }] },
        timeZones: [{ id: 'EMT', offsetSeconds: 0 }], deliverySlaUnit: 'eu-day',
      },
    ],
  };
  const tmp = join(here, '../packs/worlds-test-europa.json');
  writeFileSync(tmp, JSON.stringify(newPack));
  try {
    s.loadPack(tmp);
    assert.equal(s.world('europa')['displayName'], 'Europa (Jupiter IV)');
    assert.ok(s.shipmentModeAllowed('europa', 'submersible'));
  } finally {
    rmSync(tmp);
  }
});

test('relationships: luna orbits earth; trade lanes connect worlds', () => {
  const s = svc();
  assert.deepEqual(s.orbits('luna'), ['earth']);
  assert.deepEqual(s.tradeLanes('luna').sort(), ['earth', 'mars']);
  assert.deepEqual(s.tradeLanes('mars').sort(), ['earth', 'luna']);
  assert.deepEqual(s.orbits('earth'), []); // earth orbits nothing in this pack
});

test('spine math: Mars sols are longer than Earth days; calendar math from entity data', () => {
  const s = svc();
  // 10 Earth days = 864,000 spine seconds → 9.7 sols on Mars
  const spine = 864_000;
  const mars = s.toLocalDay('mars', spine);
  assert.ok(Math.abs(mars.localDays - 9.73) < 0.05 || mars.localDays === 9); // floor semantics
  const earth = s.toLocalDay('earth', spine);
  assert.equal(earth.localDays, 10);
  // same spine instant formats differently per world (display = configuration; dayOfYear 1-indexed)
  assert.match(s.formatLocal('earth', spine), /Day 011/);
  assert.match(s.formatLocal('mars', spine), /Sol 010/); // 864000/88775 → day-of-year stays 10 until sol 10 completes
});

test('SLA conversion: "3 sols" on Mars = 266,325 spine seconds; "2 days" on Earth = 172,800', () => {
  const s = svc();
  assert.equal(s.slaToSpineSeconds('mars', 3, 'sol'), 3 * 88_775);
  assert.equal(s.slaToSpineSeconds('earth', 2, 'day'), 2 * 86_400);
  assert.equal(s.slaToSpineSeconds('luna', 1, 'day'), 86_400); // luna keeps terran-length days
});

test('per-world contextual config: SLA policy + weight display basis resolved by world dimension', () => {
  const s = svc();
  const earth = s.slaPolicy('earth');
  const mars = s.slaPolicy('mars');
  assert.equal((earth as { slaDays: number }).slaDays, 5);
  assert.equal((mars as { slaDays: number }).slaDays, 668); // interplanetary lead time
  const lunaWeight = s.weightDisplayBasis('luna');
  assert.equal(lunaWeight!.basis, 'local-gravity');
  assert.equal(lunaWeight!.factor, 0.165); // 1.62/9.81 — weight shown in lunar gravity
  assert.equal(s.weightDisplayBasis('earth'), undefined); // no override → default basis
});

test('physics-aware logistics: drone forbidden on Luna, air forbidden on Mars (entity attributes)', () => {
  const s = svc();
  assert.equal(s.shipmentModeAllowed('luna', 'drone'), false);
  assert.equal(s.shipmentModeAllowed('earth', 'drone'), true);
  assert.equal(s.shipmentModeAllowed('mars', 'air'), false);
  assert.equal(s.shipmentModeAllowed('earth', 'air'), true);
  assert.ok(s.logisticsConstraints('luna').some((c) => c.code === 'vacuum-sealed'));
});

test('units: world-specific conversions from entity data', () => {
  const s = svc();
  assert.equal(s.convertUnit('earth', 2, 'km', 'm'), 2000);
  assert.equal(s.convertUnit('mars', 1, 'sol', 'day'), 1.0275);
  assert.throws(() => s.convertUnit('luna', 1, 'km', 'm'), /no conversion/); // luna pack has no km
});

test('spine invariant: ISO <-> spine round-trips exactly (Tier-0 time spine)', () => {
  const iso = '2026-09-06T12:34:56Z';
  assert.equal(spineSecondsToIso(isoToSpineSeconds(iso)), '2026-09-06T12:34:56.000Z'); // ms-precision ISO
  assert.equal(isoToSpineSeconds(spineSecondsToIso(1_700_000_000)), 1_700_000_000);
});

test('formatLocalClock: spine seconds → HH:MM:SS; timezone offsets applied (P0-WLD-001)', () => {
  const s = svc();
  // noon UTC on an 86400s day
  assert.equal(s.formatLocalClock('earth', 12 * 3600), '12:00:00');
  // midnight wrap
  assert.equal(s.formatLocalClock('earth', 86400 + 3661), '01:01:01');
  // IST (+5:30) shifts noon UTC → 17:30 IST
  assert.equal(s.formatLocalClock('earth', 12 * 3600, 'IST'), '17:30:00');
});

test('spineToSlaDisplay: spine seconds → calendar units (pluralization from unit data)', () => {
  const s = svc();
  assert.equal(s.spineToSlaDisplay('earth', 86400), '1 day');
  assert.equal(s.spineToSlaDisplay('earth', 3 * 86400), '3 days');
  assert.equal(s.spineToSlaDisplay('earth', 1.5 * 86400), '1.5 days');
});
