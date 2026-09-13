#!/usr/bin/env node
// GAME DAY — real-cluster chaos drill (P3-SCL-004 production harness).
// The drill SCENARIO is pack data (ops-center-core.json); this script is a
// REAL DrillHarness adapter: injects via kubectl (deletes a live pod),
// measures self-healing, verifies service health through the ClusterIP
// Service, and proves rollback. Usage: npm run gameday
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const log = (m: string) => console.log(m);

const opsPack = JSON.parse(readFileSync(join(ROOT, 'services/ops-center/packs/ops-center-core.json'), 'utf8'));
const infraPack = JSON.parse(readFileSync(join(ROOT, 'services/infra-composer/packs/infra-composer-core.json'), 'utf8'));
const NS = infraPack.deploy.namespace;
const RELEASE = `${NS}-platform`;
const SVC_PORT = infraPack.deploy.service?.port ?? 8787;
const EXPECTED = infraPack.deploy.replicas ?? 2;

const { OpsCenterService } = await import(join(ROOT, 'services/ops-center/src/index.ts'));
const ops = new OpsCenterService(opsPack);

let victim = '';
let killedAt = 0;

function readyReplicas(): number {
  const r = spawnSync('kubectl', ['get', 'deploy', RELEASE, '-n', NS, '-o', 'jsonpath={.status.readyReplicas}'], { encoding: 'utf8' });
  return Number(r.stdout ?? 0) || 0;
}

async function serviceHealth(): Promise<boolean> {
  const pf = spawn('kubectl', ['-n', NS, 'port-forward', `svc/${RELEASE}`, '18899:' + String(SVC_PORT)], { stdio: 'ignore' });
  await new Promise((res) => setTimeout(res, 2500));
  let ok = false;
  try {
    const r = await fetch(`http://127.0.0.1:18899/health`);
    ok = r.status === 200;
  } catch { /* refused → not healthy */ }
  pf.kill();
  return ok;
}

const harness = {
  inject(fault: { kind: string; target: string }): void {
    if (fault.kind !== 'delete-pod') throw new Error(`harness does not implement fault "${fault.kind}" — extend adapter`);
    const pods = spawnSync('kubectl', ['get', 'pods', '-n', NS, '-l', `app=${RELEASE}`, '-o', 'name'], { encoding: 'utf8' });
    const podList = pods.stdout.trim().split('\n').filter(Boolean);
    victim = podList[0] ?? '';
    if (!victim) throw new Error('no pods to kill — is the release deployed? (npm run deploy)');
    killedAt = Date.now();
    log(`💥 injecting: ${fault.kind} → ${victim} (grace=0, real cluster)`);
    spawnSync('kubectl', ['delete', victim, '-n', NS, '--grace-period=0', '--wait=false']);
  },
  async measure(check: string): Promise<unknown> {
    switch (check) {
      case 'service-health-200':
        return await serviceHealth();
      case 'self-heal-under-seconds': {
        // poll until ready replicas restored; return elapsed seconds
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          if (readyReplicas() >= EXPECTED) return Math.round((Date.now() - killedAt) / 1000);
          spawnSync('sleep', ['2']);
        }
        return 999;
      }
      case 'replicas-ready':
        return readyReplicas();
      default:
        throw new Error(`harness cannot measure "${check}"`);
    }
  },

  executeRollbackStep(step: string): boolean {
    if (step === 'confirm-rollout-clean') {
      const r = spawnSync('kubectl', ['rollout', 'status', `deployment/${RELEASE}`, '-n', NS, '--timeout=60s'], { stdio: 'ignore' });
      return r.status === 0;
    }
    if (step === 'write-incident-evidence') {
      writeFileSync(join(ROOT, '.gameday-report.json'), JSON.stringify({
        drill: 'drill_pod_kill', namespace: NS, release: RELEASE, victim,
        killedAtISO: new Date(killedAt).toISOString(), healedAt: new Date().toISOString(),
        expectedReplicas: EXPECTED, ranVia: 'scripts/gameday.ts',
      }, null, 2));
      log('📝 incident evidence written (.gameday-report.json)');
      return true;
    }
    return false;
  },
};

log('🎲 GAME DAY — scenario from pack data, harness on the REAL cluster');
log(`   drill: drill_pod_kill | namespace: ${NS} | expecting ${EXPECTED} replicas`);

const result = await ops.runDrill('drill_pod_kill', harness);
for (const r of result.invariantResults) {
  log(`   ${r.passed ? '✅' : '❌'} ${r.check} observed=${JSON.stringify(r.observed)}`);
}
for (const r of result.rollbackSteps) log(`   ${r.ok ? '✅' : '❌'} rollback: ${r.step}`);
log(result.passed
  ? '\n✅ GAME DAY PASSED — cluster self-healed, service verified, rollback proven'
  : '\n❌ GAME DAY FAILED — see checks above');
process.exit(result.passed ? 0 : 1);
