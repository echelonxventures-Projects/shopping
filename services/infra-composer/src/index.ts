// @aether/service-infra-composer — IaC-as-data: deployment topology composed
// from the Product Registry + pack shapes (PX-INF-002). Module-as-a-Product:
// runtime target, sizing classes, deployment shapes, data-plane stores, output
// formats are ALL PACK DATA. The composer reads the product registry (Every-
// thing-is-a-Product recursion: infra derives FROM the products) and renders
// k8s manifests — products map to Deployments; the golden rule holds: adding a
// product automatically extends the topology, zero infra code.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';
import { ProductRegistry, defaultServicesDir, type ProductListing } from '@aether/kernel-product-registry/src/index.ts';

export interface DeploymentShape {
  appliesToProducts: string[];
  sizingClass: string;
  deployment: string;
}

export interface RuntimeAdapterSpec {
  kind: string;
  imageRef?: string;
  steps: string[];
}

export interface InfraPack {
  pack: { name: string };
  runtimeAdapters?: { selected: string; defaultTimeout?: string; adapters: Record<string, RuntimeAdapterSpec> };
  runtimeTarget: { id: string; kind: string; apiVersion: string; runtime: string };
  sizingClasses: Record<string, { replicas: number; cpuMilli: number; memoryMi: number; hpa: { min: number; max: number; targetCpuPct: number } | null }>;
  deploymentShapes: DeploymentShape[];
  dataPlane: {
    stores: Array<{ id: string; engine: string; class: string; haMode: string; backup: { pitr: boolean; retentionDays: number } }>;
    searchIndex: { engine: string; class: string; haMode: string };
  };
  outputs: { formats: string[]; namespacePrefix: string };
}

export interface ComposedTopology {
  runtimeTargetId: string;
  namespace: string;
  deployments: Array<{
    productId: string;
    productName: string;
    sizingClass: string;
    replicas: number;
    cpuMilli: number;
    memoryMi: number;
    hpa: { min: number; max: number; targetCpuPct: number } | null;
  }>;
  dataPlane: InfraPack['dataPlane'];
  productsCovered: number;
}

export class InfraComposerService {
  private pack: InfraPack;
  private registry: ProductRegistry;

  constructor(pack: InfraPack, servicesDir = defaultServicesDir) {
    this.pack = pack;
    this.registry = new ProductRegistry();
    this.registry.scanDirectory(servicesDir);
  }

  /** resolve the agnostic deploy plan: ordered steps + imageRef from a
   *  runtimeAdapters Reference Pack (swappable tooling — zero code names it) */
  deployPlan(adapterId?: string, imageBase?: string): { adapterId: string; kind: string; imageRef: string; steps: string[] } {
    const ra = this.pack.runtimeAdapters;
    if (!ra) throw new Error('No runtimeAdapters in pack — deploy tooling is pack data, register an adapter');
    const id = adapterId ?? ra.selected;
    const adapter = ra.adapters[id];
    if (!adapter) {
      throw new Error(`Unknown deploy adapter "${id}" — registered: ${Object.keys(ra.adapters).join(', ')} (add a pack entry, never code)`);
    }
    const imageRef = (adapter.imageRef ?? '{image}').replace('{image}', imageBase ?? 'image:tag');
    return { adapterId: id, kind: adapter.kind, imageRef, steps: adapter.steps };
  }

  /** match a product to its shape — specific entries beat the '*' fallback */
  private shapeFor(productId: string): { shape: DeploymentShape; product: ProductListing } {
    const product = this.registry.get(productId);
    const specific = this.pack.deploymentShapes.find((s) => s.appliesToProducts.includes(productId));
    const fallback = this.pack.deploymentShapes.find((s) => s.appliesToProducts.includes('*'));
    const shape = specific ?? fallback;
    if (!shape) throw new Error(`No deployment shape for "${productId}" — add to infra pack`);
    return { shape, product };
  }

  /** compose the full topology from the LIVE product registry (new products auto-included) */
  compose(productIds?: string[]): ComposedTopology {
    const all = this.registry.list();
    const targets = productIds ?? all.map((p) => p.productId);
    const deployments: ComposedTopology['deployments'] = [];
    for (const pid of targets) {
      const { shape, product } = this.shapeFor(pid);
      const sizing = this.pack.sizingClasses[shape.sizingClass];
      if (!sizing) throw new Error(`Unknown sizing class "${shape.sizingClass}" — register in pack`);
      deployments.push({
        productId: pid,
        productName: product.displayName,
        sizingClass: shape.sizingClass,
        replicas: sizing.replicas,
        cpuMilli: sizing.cpuMilli,
        memoryMi: sizing.memoryMi,
        hpa: sizing.hpa ? { ...sizing.hpa } : null,
      });
    }
    return {
      runtimeTargetId: this.pack.runtimeTarget.id,
      namespace: this.pack.outputs.namespacePrefix,
      deployments,
      dataPlane: this.pack.dataPlane,
      productsCovered: deployments.length,
    };
  }

  /** render k8s-class manifests (one Deployment per product) */
  renderK8s(topology: ComposedTopology): string {
    const manifests: string[] = [];
    manifests.push(`# Composed by @aether/service-infra-composer — IaC-as-data (products → topology)
# RuntimeTarget: ${topology.runtimeTargetId} | namespace: ${topology.namespace}
apiVersion: v1
kind: Namespace
metadata:
  name: ${topology.namespace}
---
`);
    for (const d of topology.deployments) {
      const hpa = d.hpa
        ? `\n    metrics:\n    - type: Resource\n      resource:\n        name: cpu\n        target:\n          type: Utilization\n          averageUtilization: ${d.hpa.targetCpuPct}\n  minReplicas: ${d.hpa.min}\n  maxReplicas: ${d.hpa.max}`
        : '';
      manifests.push(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${topology.namespace}-${d.productId}
  namespace: ${topology.namespace}
  labels: { app: ${d.productId}, aether-product: "true", sizing: ${d.sizingClass} }
spec:
  replicas: ${d.replicas}
  selector: { matchLabels: { app: ${d.productId} } }
  template:
    metadata: { labels: { app: ${d.productId} } }
    spec:
      containers:
      - name: ${d.productId}
        image: registry.local/aether/${d.productId}:${'{{VERSION}}'}
        resources:
          requests: { cpu: ${d.cpuMilli}m, memory: ${d.memoryMi}Mi }
          limits: { cpu: ${d.cpuMilli * 2}m, memory: ${d.memoryMi * 2}Mi }
---
${hpa ? `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${topology.namespace}-${d.productId}
  namespace: ${topology.namespace}
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: ${topology.namespace}-${d.productId} }${hpa}
---
` : ''}`);
    }
    return manifests.join('\n');
  }

  /** data-plane wiring: stores + search index from pack */
  renderDataPlane(): string {
    const lines = ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: aether-dataplane', 'data:'];
    for (const s of this.pack.dataPlane.stores) {
      lines.push(`  ${s.id}.engine: "${s.engine}"`, `  ${s.id}.ha: "${s.haMode}"`, `  ${s.id}.backup.pitr: "${s.backup.pitr}"`, `  ${s.id}.backup.retentionDays: "${s.backup.retentionDays}"`);
    }
    const si = this.pack.dataPlane.searchIndex;
    lines.push(`  search.engine: "${si.engine}"`, `  search.ha: "${si.haMode}"`);
    return lines.join('\n');
  }

  productCount(): number {
    return this.registry.list().length;
  }
}

const infraComposerModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as InfraPack;
    const svc = new InfraComposerService(pack);
    const meter = (ev: string) => billing.meter(ev, 1);
    return {
      compose: (ids?: string[]) => (meter('topology.composed'), svc.compose(ids)),
      renderK8s: (t: ComposedTopology) => (meter('topology.rendered'), svc.renderK8s(t)),
      deployPlan: (id?: string, img?: string) => (meter('deploy.plan.resolved'), svc.deployPlan(id, img)),
      renderDataPlane: () => svc.renderDataPlane(),
      productCount: () => svc.productCount(),
      __raw: svc,
    };
  },
};

export default infraComposerModule;
