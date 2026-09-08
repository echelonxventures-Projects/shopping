// Tests: compliance evidence — control catalogs from pack, EvidencePort wiring,
// freshness windows, gap detection, readiness gate, exports (P4-AUD-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComplianceEvidenceService } from '../src/index.ts';
import type { EvidencePort, EvidenceSource } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/compliance-evidence-core.json'), 'utf8'));
const svc = () => new ComplianceEvidenceService(pack);

const NOW = '2026-09-08T00:00:00Z';
const FRESH = '2026-09-01T00:00:00Z';
const STALE = '2026-05-01T00:00:00Z'; // >90d old

function portWith(freshness: Record<string, string>, missingChecks: string[] = []): EvidencePort {
  return {
    probe(src: EvidenceSource) {
      const key = `${src.module}:${src.check}`;
      if (missingChecks.includes(key)) return null;
      const at = freshness[key] ?? FRESH;
      return { artifact: `artifact-for-${key}`, collectedAt: at };
    },
  };
}

test('clean evidence: all controls satisfied → report clean for both frameworks', () => {
  const s = svc();
  s.bindEvidencePort(portWith({}));
  const soc2 = s.collect('SOC2', NOW);
  assert.equal(soc2.report, 'clean');
  assert.equal(soc2.controlsTotal, 5);
  assert.equal(soc2.controlsSatisfied, 5);
  const iso = s.collect('ISO27001', NOW);
  assert.equal(iso.report, 'clean');
  assert.equal(iso.controlsSatisfied, 3);
});

test('gap detection: missing module evidence breaks the control with the module named', () => {
  const s = svc();
  // cbom-generated feeds CC6.1; tls-floor feeds CC6.7 — both from mod-crypto-vault
  s.bindEvidencePort(portWith({}, ['mod-crypto-vault:cbom-generated', 'mod-crypto-vault:tls-floor']));
  const soc2 = s.collect('SOC2', NOW);
  assert.equal(soc2.report, 'gaps-present');
  assert.ok(soc2.gaps.some((g) => g.controlId === 'CC6.1' && /mod-crypto-vault/.test(g.reason)));
  assert.ok(soc2.gaps.some((g) => g.controlId === 'CC6.7' && /mod-crypto-vault/.test(g.reason)));
});

test('freshness: evidence older than the pack window (90d) breaches and gaps the control', () => {
  const s = svc();
  s.bindEvidencePort(portWith({ 'mod-checkout:ledger-sum-zero': STALE }));
  const soc2 = s.collect('SOC2', NOW);
  assert.ok(soc2.freshnessBreaches.some((f) => f.controlId === 'PI3.1'));
  assert.ok(soc2.gaps.some((g) => g.controlId === 'PI3.1' && /stale/.test(g.reason)));
  const cleanCtrl = s.collect('SOC2', NOW);
  assert.ok(cleanCtrl.controlsSatisfied >= 4); // only PI3.1 affected
});

test('readiness gate: gapAlertThreshold from pack (3) — below-threshold gaps stay ready', () => {
  const s = svc();
  // 1 missing check → 1 gap in SOC2 (CC8.1) + 1 gap in ISO (A.8.15) — both below threshold 3
  s.bindEvidencePort(portWith({}, ['mod-git:commit-audit-trail']));
  const r = s.readiness(NOW);
  assert.equal(r.ready, true);
  // now break enough SOC2 controls to cross the threshold: CC6.1 (crypto), CC7.2 (marketplace), CC8.1 (git), PI3.1 (checkout)
  s.bindEvidencePort(portWith({}, [
    'mod-crypto-vault:cbom-generated',
    'mod-payments:saq-a-floor',
    'mod-marketplace:enforcement-ladder',
    'mod-git:commit-audit-trail',
    'mod-checkout:ledger-sum-zero',
  ]));
  const risky = s.readiness(NOW);
  assert.equal(risky.ready, false); // SOC2 now has 4 gaps ≥ threshold 3
  const soc2Gaps = risky.perFramework.find((f) => f.frameworkId === 'SOC2')!.gaps;
  assert.ok(soc2Gaps >= 3);
});

test('unknown framework rejected; export formats gated by pack', () => {
  const s = svc();
  s.bindEvidencePort(portWith({}));
  assert.throws(() => s.collect('HIPAA'), /Unknown compliance framework/);
  const good = s.exportReport('SOC2', 'json', NOW);
  assert.equal(good.format, 'json');
  assert.ok(JSON.parse(good.payload).frameworkId === 'SOC2');
  assert.throws(() => s.exportReport('SOC2', 'pdf'), /not enabled/);
});

test('frameworks list from pack: SOC2 + ISO27001 with their control counts', () => {
  const s = svc();
  const fws = s.frameworks();
  assert.deepEqual(fws.map((f) => f.id).sort(), ['ISO27001', 'SOC2']);
  assert.equal(fws.find((f) => f.id === 'SOC2')!.controls.length, 5);
  assert.equal(fws.find((f) => f.id === 'ISO27001')!.controls.length, 3);
});
