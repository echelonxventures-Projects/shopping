#!/usr/bin/env node
// DEPLOY EXECUTOR — invariant mechanics only (Doctrine 2 + Doctrine 6).
// Zero technology names in this file: the ordered deploy plan (steps,
// commands, args) is resolved from the infra pack's `runtimeAdapters`
// Reference Pack (swappable: AETHER_DEPLOY_ADAPTER or pack 'selected').
// Steps run in order; templates substitute {image} {tarball} {dockerfile}
// {releaseName} {namespace} {timeout} {registry} {cluster}. A `skipIf`
// probe makes a step conditional (idempotent re-runs). `stdin: manifests`
// feeds the rendered YAML. New tooling = new pack entry, zero code.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const log = (m: string) => console.log(m);

interface CommandSpec { cmd: string; args: string[]; stdin?: string; skipIf?: { cmd: string; args: string[]; expectSuccess: boolean } }

const infraPack = JSON.parse(readFileSync(join(ROOT, 'services/infra-composer/packs/infra-composer-core.json'), 'utf8'));
const deploy = infraPack.deploy;

const { InfraComposerService } = await import(join(ROOT, 'services/infra-composer/src/index.ts'));
const composer = new InfraComposerService(infraPack);

// ---- compose topology from the LIVE product registry (IaC-as-data) ----
log('🧩 composing topology from the live product registry…');
const topology = composer.compose();
log(`    ${topology.productsCovered} products → ${topology.deployments.length} deployments (namespace: ${topology.namespace})`);

// ---- resolve the deploy plan FROM the adapter Reference Pack (product API) ----
const adapterId = process.env.AETHER_DEPLOY_ADAPTER ?? infraPack.runtimeAdapters?.selected;
const imageBase = `${deploy.imageName}:${deploy.imageTag}`;
const plan = composer.deployPlan(adapterId, imageBase);
const NS = deploy.namespace;
const RELEASE = deploy.releaseName ?? `${NS}-platform`;
const subs: Record<string, string> = {
  image: imageBase,
  imageRef: plan.imageRef,
  tarball: `/tmp/${deploy.imageName}.tar`,
  dockerfile: deploy.dockerfile ?? 'Dockerfile.deploy',
  releaseName: RELEASE,
  namespace: NS,
  timeout: process.env.AETHER_DEPLOY_TIMEOUT ?? (infraPack.runtimeAdapters?.defaultTimeout ?? '180s'),
  registry: deploy.registry ?? 'registry.local',
  cluster: deploy.cluster ?? '',
};
const manifests = renderManifests(subs.imageRef);
log(`📄 release plan via adapter "${plan.adapterId}" (${plan.kind}): ${plan.steps.join(' → ')}`);

// ---- execute the data-declared steps (commands live in the pack adapter) ----
const stepCommands: Record<string, CommandSpec | { multi: CommandSpec[] }> =
  (infraPack.runtimeAdapters.adapters[plan.adapterId] as unknown as { commands: Record<string, CommandSpec | { multi: CommandSpec[] }> }).commands;
for (const step of plan.steps) {
  const spec = stepCommands[step];
  if (!spec) throw new Error(`adapter "${adapterId}" has no command for step "${step}" — pack data gap`);
  const cmds: CommandSpec[] = 'multi' in spec ? spec.multi : [spec as CommandSpec];
  for (const c of cmds) {
    if (c.skipIf) {
      const probe = spawnSync(fill(c.skipIf.cmd), c.skipIf.args.map(fill), { encoding: 'utf8' });
      const present = probe.status === 0;
      if (present === c.skipIf.expectSuccess) { log(`    ⏭ ${step}: skipped (probe says present)`); continue; }
    }
    const args = c.args.map(fill);
    if (c.stdin === 'manifests') {
      const r = spawnSync(fill(c.cmd), args, { input: manifests, stdio: ['pipe', 'inherit', 'inherit'] });
      if (r.status !== 0) process.exit(r.status ?? 1);
    } else {
      const r = spawnSync(fill(c.cmd), args, { stdio: 'inherit' });
      if (r.status !== 0) { log(`❌ step "${step}" failed`); process.exit(r.status ?? 1); }
    }
  }
}

log(`\n✅ DEPLOYED via ${plan.adapterId} — namespace ${NS}, image ${subs.imageRef}`);

function fill(t: string): string {
  let out = t.startsWith('~/') ? join(process.env.HOME ?? '', t.slice(2)) : t;
  for (const [k, v] of Object.entries(subs)) out = out.replaceAll(`{${k}}`, v);
  return out;
}

// ---------- manifest rendering (sizing from pack; single-image release mode) ----------
function renderManifests(image: string): string {
  const sizing = infraPack.sizingClasses.kernel;
  const svc = deploy.service ?? { type: 'ClusterIP', port: 8787 };
  return `apiVersion: v1
kind: Namespace
metadata:
  name: ${NS}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${RELEASE}
  namespace: ${NS}
  labels: { app: ${RELEASE}, aether-product: "true", sizing: kernel, composed-by: infra-composer }
spec:
  replicas: ${deploy.replicas ?? sizing.replicas}
  selector: { matchLabels: { app: ${RELEASE} } }
  template:
    metadata: { labels: { app: ${RELEASE} } }
    spec:
      containers:
      - name: ${RELEASE}
        image: ${image}
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
  name: ${RELEASE}
  namespace: ${NS}
spec:
  type: ${svc.type}
  selector: { app: ${RELEASE} }
  ports: [{ port: ${svc.port}, targetPort: ${svc.port} }]
`;
}
