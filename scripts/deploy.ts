#!/usr/bin/env node
// PRODUCTION DEPLOY — IaC-as-data end-to-end:
//   1. compose topology FROM the live product registry (infra-composer)
//   2. render k8s manifests (pack-defined sizing/shapes)
//   3. build the platform image (Dockerfile — the self-hosted server)
//   4. import into the cluster (colima/k3s containerd via kubectl or docker)
//   5. kubectl apply + wait for readiness
// Everything swappable: cluster context, image name, namespace are PACK DATA
// (infra-composer-core.json deploy section) — this script is pure mechanics.
// Usage: npm run deploy
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const log = (m: string) => console.log(m);
const run = (cmd: string, opts: Record<string, unknown> = {}) => execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });

const infraPack = JSON.parse(readFileSync(join(ROOT, 'services/infra-composer/packs/infra-composer-core.json'), 'utf8'));
const deploy = infraPack.deploy ?? { namespace: 'aether', imageName: 'aether-platform', imageTag: 'local', context: 'colima', replicas: 2 };
const NS = deploy.namespace;
const IMAGE = `${deploy.imageName}:${deploy.imageTag}`; // imported as docker.io/library/<name>:<tag> by containerd

log('🧩 1/5 composing topology from the live product registry…');
const { InfraComposerService } = await import(join(ROOT, 'services/infra-composer/src/index.ts'));
const composer = new InfraComposerService(infraPack);
const topology = composer.compose();
log(`    ${topology.productsCovered} products → ${topology.deployments.length} deployments (namespace: ${NS})`);

log('📦 2/5 building the platform image…');
// idempotent: reuse the local image when present (offline-friendly)
const haveImage = spawnSync('docker', ['image', 'inspect', IMAGE], { encoding: 'utf8' }).status === 0;
if (haveImage) {
  log(`    image ${IMAGE} already present — skipping build (delete to force rebuild)`);
} else {
  run(`docker build -t ${IMAGE} -f Dockerfile.deploy . --quiet`);
}

log('🚚 3/5 importing image into the cluster (k3s containerd via colima)…');
try {
  run(`docker save ${IMAGE} -o /tmp/aether-platform.tar`);
  run(`scp -F ~/.colima/ssh_config /tmp/aether-platform.tar colima:/tmp/aether-platform.tar`);
  run(`scp -F ~/.colima/ssh_config ${join(ROOT, 'scripts/vm-import.sh')} colima:/tmp/import.sh`);
  run(`colima ssh -- sh /tmp/import.sh`);
  log('    image imported into k3s containerd');
} catch (err) {
  log(`    ⚠ import failed: ${(err as Error).message}`);
  throw err;
}

log('📄 4/5 rendering + applying manifests (pack sizing)…');
const manifests = renderManifests();
run(`printf '%s' '${manifests.replace(/'/g, "'\\''")}' | kubectl apply -f -`, { shell: '/bin/bash' });

log('⏳ 5/5 waiting for rollout…');
const ok = spawnSync('kubectl', ['rollout', 'status', `deployment/aether-platform`, `-n`, NS, '--timeout=180s'], { stdio: 'inherit', cwd: ROOT });
if (ok.status !== 0) {
  log('❌ rollout failed — check: kubectl -n ' + NS + ' describe pod -l app=aether-platform');
  process.exit(1);
}
log(`\n✅ DEPLOYED — namespace ${NS}, image ${IMAGE}`);
log(`   test: kubectl -n ${NS} port-forward svc/aether-platform 8787:8787`);
log(`   then: curl http://127.0.0.1:8787/health`);

// ---------- manifest rendering (sizing from pack; single platform image) ----------
function renderManifests(): string {
  const sizing = infraPack.sizingClasses.kernel; // in-process monolith sizing for the single-image deploy mode
  const svc = infraPack.deploy?.service ?? { type: 'ClusterIP', port: 8787 };
  return [
    `apiVersion: v1
kind: Namespace
metadata:
  name: ${NS}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: aether-platform
  namespace: ${NS}
  labels: { app: aether-platform, aether-product: "true", sizing: kernel, composed-by: infra-composer }
spec:
  replicas: ${deploy.replicas ?? sizing.replicas}
  selector: { matchLabels: { app: aether-platform } }
  template:
    metadata: { labels: { app: aether-platform } }
    spec:
      containers:
      - name: aether-platform
        image: ${IMAGE}
        imagePullPolicy: ${deploy.imageTag === 'local' ? 'Never' : 'IfNotPresent'}
        env:
        - name: AETHER_BIND_HOST
          value: "0.0.0.0"
        ports: [{ containerPort: ${svc.port} }]
        readinessProbe: { httpGet: { path: /health, port: ${svc.port} }, initialDelaySeconds: 3, periodSeconds: 5 }
        livenessProbe: { httpGet: { path: /health, port: ${svc.port} }, initialDelaySeconds: 10, periodSeconds: 10 }
        resources:
          requests: { cpu: ${sizing.cpuMilli}m, memory: ${sizing.memoryMi}Mi }
          limits: { cpu: ${sizing.cpuMilli * 2}m, memory: ${sizing.memoryMi * 2}Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: aether-platform
  namespace: ${NS}
spec:
  type: ${svc.type}
  selector: { app: aether-platform }
  ports: [{ port: ${svc.port}, targetPort: ${svc.port} }]
`,
  ].join('\n');
}
