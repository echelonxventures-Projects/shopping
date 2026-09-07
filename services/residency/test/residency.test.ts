// Tests: residency — market→cell routing, cross-cell write REFUSED (hard-fail),
// per-cell isolation, DSR erasure, audit trail (P2-MKT-002).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResidencyService, ResidencyViolationError } from '../src/index.ts';
import type { CellEngineFactory } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/residency-core.json'), 'utf8'));
const svc = () => new ResidencyService(pack);

/** dev cell engines: one in-memory map per cell — mirrors engine-per-cell deployment */
function cellEngines(): CellEngineFactory & { store(): Map<string, Map<string, unknown>> } {
  const cells = new Map<string, Map<string, unknown>>();
  const factory = ((cellId: string) => {
    if (!cells.has(cellId)) cells.set(cellId, new Map());
    const m = cells.get(cellId)!;
    return {
      put(key: string, value: unknown) {
        if (value === undefined) m.delete(key);
        else m.set(key, value);
      },
      get(key: string) {
        return m.get(key);
      },
      keys() {
        return [...m.keys()];
      },
    };
  }) as CellEngineFactory & { store(): Map<string, Map<string, unknown>> };
  factory.store = () => cells;
  return factory;
}

test('market→cell routing from pack: EU→eu-central (GDPR), IN→ap-south-1 (DPDP)', () => {
  const s = svc();
  assert.equal(s.cellFor('EU'), 'eu-central');
  assert.equal(s.cellFor('IN'), 'ap-south-1');
  assert.equal(s.cellDescriptor('eu-central').sovereignty, 'gdpr');
  assert.throws(() => s.cellFor('XX'), /No residency cell/);
});

test('enforced writes land in the correct cell; reads served from the same cell', () => {
  const s = svc();
  const engines = cellEngines();
  s.bindEngines(engines);
  s.write('acme', 'EU', 'order-1', { total: 120 });
  s.write('acme', 'IN', 'order-2', { total: 500 });
  // correct cell contains the data; other cell does not
  assert.ok(engines.store().get('eu-central')!.has('acme:order-1'));
  assert.ok(!engines.store().get('ap-south-1')!.has('acme:order-1'));
  assert.deepEqual(s.read('acme', 'EU', 'order-1'), { total: 120 });
});

test('CROSS-CELL WRITE REFUSED with ResidencyViolationError (hard-fail policy)', () => {
  const s = svc();
  s.bindEngines(cellEngines());
  // EU tenant-market data attempted into the US cell → refused
  assert.throws(
    () => s.attemptWriteTo('acme', 'EU', 'us-east', 'order-x', { total: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof ResidencyViolationError);
      assert.equal(err.requiredCell, 'eu-central');
      assert.equal(err.attemptedCell, 'us-east');
      assert.match(err.message, /sovereignty/);
      return true;
    }
  );
  // writing to the correct cell via attemptWriteTo succeeds
  s.attemptWriteTo('acme', 'EU', 'eu-central', 'order-y', { total: 2 });
  assert.deepEqual(s.read('acme', 'EU', 'order-y'), { total: 2 });
});

test('audit trail: refused violations recorded alongside allowed operations', () => {
  const s = svc();
  s.bindEngines(cellEngines());
  assert.throws(() => s.attemptWriteTo('acme', 'IN', 'us-east', 'k', 1)); // refused (hard-fail)
  s.write('acme', 'IN', 'k2', 2); // allowed
  const trail = s.auditTrail();
  assert.ok(trail.some((t) => t.result === 'refused' && t.cell === 'us-east' && t.marketId === 'IN'));
  assert.ok(trail.some((t) => t.result === 'allowed' && t.cell === 'ap-south-1'));
});

test('DSR erasure: tenant keys removed from their cell only', () => {
  const s = svc();
  const engines = cellEngines();
  s.bindEngines(engines);
  s.write('acme', 'EU', 'a', 1);
  s.write('acme', 'EU', 'b', 2);
  s.write('other', 'EU', 'c', 3); // different tenant — must survive
  s.write('acme', 'IN', 'd', 4); // same tenant, different market/cell — survives (per-market erasure)
  const r = s.eraseTenant('acme', 'EU');
  assert.equal(r.erased, 2);
  assert.ok(!engines.store().get('eu-central')!.has('acme:a'));
  assert.ok(engines.store().get('eu-central')!.has('other:c'));
  assert.ok(engines.store().get('ap-south-1')!.has('acme:d'));
});
