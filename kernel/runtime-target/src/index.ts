// @aether/kernel-runtime-target — RuntimeTarget entity + RuntimeAdapter SPI
// (P0-CTR-002). Doctrine 6: no runtime is binding — a runtime target is a
// registry ENTITY with capability descriptors, and deployments are adapters
// admitted ONLY by passing the runtime conformance matrix. Tier-0 mechanics:
// the SPI shape, the in-memory reference adapters, and capability descriptors.
// Actual target definitions are pack data (services or host config).

import type { Bitemporal } from '@aether/kernel-primitives';

export interface RuntimeTargetDef extends Bitemporal {
  id: string;
  kind: string;
  computeClass: string;
  scalingSemantics: string;
  networkModel: string;
  placementConstraints: string[];
  teeCapable: boolean;
  capabilities: string[];
}

export interface RuntimeCapabilities {
  horizontalScaling: boolean;
  autoscaling: boolean;
  rollingUpdate: boolean;
  tee: boolean;
  persistentVolumes: boolean;
}

export interface DeploymentSpec {
  serviceId: string;
  image: string;
  replicas: number;
  cpuMilli: number;
  memoryMi: number;
  env?: Record<string, string>;
  port?: number;
}

export interface DeploymentHandle {
  deploymentId: string;
  targetId: string;
  serviceId: string;
  image: string;
  replicas: number;
  status: 'pending' | 'running' | 'stopped';
}

export interface DeploymentStatus {
  ready: number;
  desired: number;
  healthy: boolean;
}

export interface RuntimeAdapter {
  readonly name: string;
  readonly targetKind: string;
  capabilities(): RuntimeCapabilities;
  deploy(spec: DeploymentSpec, target: RuntimeTargetDef): Promise<DeploymentHandle>;
  scale(handle: DeploymentHandle, replicas: number): Promise<DeploymentHandle>;
  status(handle: DeploymentHandle): Promise<DeploymentStatus>;
  undeploy(handle: DeploymentHandle): Promise<void>;
}

export class TargetMismatchError extends Error {
  constructor(adapterKind: string, targetKind: string) {
    super(`Adapter for target kind "${adapterKind}" cannot deploy onto target kind "${targetKind}"`);
    this.name = 'TargetMismatchError';
  }
}

/** process-host-class target: bare process supervision, vertical-only, no rolling updates */
export class ProcessHostAdapter implements RuntimeAdapter {
  readonly name: string = 'process-host-adapter';
  readonly targetKind: string = 'process-host';
  private deployments = new Map<string, { handle: DeploymentHandle; ready: number }>();
  private seq = 0;

  capabilities(): RuntimeCapabilities {
    return { horizontalScaling: false, autoscaling: false, rollingUpdate: false, tee: false, persistentVolumes: false };
  }

  async deploy(spec: DeploymentSpec, target: RuntimeTargetDef): Promise<DeploymentHandle> {
    if (target.kind !== this.targetKind) throw new TargetMismatchError(this.targetKind, target.kind);
    if (spec.replicas > 1) {
      throw new Error(`target kind "${this.targetKind}" does not support horizontal scaling (replicas>1) — pack sizing must match the target`);
    }
    this.seq++;
    const handle: DeploymentHandle = {
      deploymentId: `proc-${this.seq}`,
      targetId: target.id,
      serviceId: spec.serviceId,
      image: spec.image,
      replicas: spec.replicas,
      status: 'running',
    };
    this.deployments.set(handle.deploymentId, { handle, ready: spec.replicas });
    return handle;
  }

  async scale(handle: DeploymentHandle, replicas: number): Promise<DeploymentHandle> {
    if (replicas > 1) throw new Error(`target kind "${this.targetKind}" cannot scale horizontally`);
    const entry = this.deployments.get(handle.deploymentId);
    if (!entry) throw new Error(`unknown deployment ${handle.deploymentId}`);
    entry.handle = { ...entry.handle, replicas };
    entry.ready = replicas;
    return entry.handle;
  }

  async status(handle: DeploymentHandle): Promise<DeploymentStatus> {
    const entry = this.deployments.get(handle.deploymentId);
    if (!entry) return { ready: 0, desired: 0, healthy: false };
    const running = entry.handle.status === 'running';
    return { ready: entry.ready, desired: entry.handle.replicas, healthy: running && entry.ready === entry.handle.replicas };
  }

  async undeploy(handle: DeploymentHandle): Promise<void> {
    const entry = this.deployments.get(handle.deploymentId);
    if (entry) {
      entry.ready = 0;
      entry.handle = { ...entry.handle, status: 'stopped', replicas: 0 };
    }
  }
}

/** container-orchestrated-class target: horizontal, autoscaling, rolling updates */
export class ContainerOrchestratorAdapter implements RuntimeAdapter {
  readonly name: string = 'container-orchestrator-adapter';
  readonly targetKind: string = 'container-orchestrated';
  private deployments = new Map<string, { handle: DeploymentHandle; ready: number; rolling: boolean }>();
  private seq = 0;

  capabilities(): RuntimeCapabilities {
    return { horizontalScaling: true, autoscaling: true, rollingUpdate: true, tee: true, persistentVolumes: true };
  }

  async deploy(spec: DeploymentSpec, target: RuntimeTargetDef): Promise<DeploymentHandle> {
    if (target.kind !== this.targetKind) throw new TargetMismatchError(this.targetKind, target.kind);
    this.seq++;
    const handle: DeploymentHandle = {
      deploymentId: `dep-${this.seq}`,
      targetId: target.id,
      serviceId: spec.serviceId,
      image: spec.image,
      replicas: spec.replicas,
      status: 'running',
    };
    this.deployments.set(handle.deploymentId, { handle, ready: spec.replicas, rolling: false });
    return handle;
  }

  /** rolling update: scale up first, then settle (mirrors real orchestrator semantics) */
  async scale(handle: DeploymentHandle, replicas: number): Promise<DeploymentHandle> {
    const entry = this.deployments.get(handle.deploymentId);
    if (!entry) throw new Error(`unknown deployment ${handle.deploymentId}`);
    entry.rolling = true;
    entry.handle = { ...entry.handle, replicas };
    entry.ready = replicas;
    entry.rolling = false;
    return entry.handle;
  }

  async status(handle: DeploymentHandle): Promise<DeploymentStatus> {
    const entry = this.deployments.get(handle.deploymentId);
    if (!entry) return { ready: 0, desired: 0, healthy: false };
    const running = entry.handle.status === 'running';
    return { ready: entry.ready, desired: entry.handle.replicas, healthy: running && !entry.rolling && entry.ready === entry.handle.replicas };
  }

  async undeploy(handle: DeploymentHandle): Promise<void> {
    const entry = this.deployments.get(handle.deploymentId);
    if (entry) {
      entry.ready = 0;
      entry.handle = { ...entry.handle, status: 'stopped', replicas: 0 };
    }
  }
}