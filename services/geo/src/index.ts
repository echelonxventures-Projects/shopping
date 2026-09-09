// @aether/service-geo — zones, geofences, ship-from-store routing (P1-GEO-001).
// Module-as-a-Product: zones are matching RULES over address dimensions
// (country/region/postal prefix — values live in the pack, priority-resolved),
// geofences are polygon/radius DATA evaluated by kernel-grade math
// (point-in-polygon ray casting, haversine), and fulfillment-node selection is
// capability-filtered nearest-first under pack distance caps. Zero geographic
// branches in code — swap the pack, serve a different planet.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

// ---------- pack shapes ----------
export interface ZoneDef {
  id: string;
  name: string;
  priority: number;
  match: Array<{ country: string; regions?: string[]; postalPrefixes?: string[] }>;
}

export interface GeofenceDef {
  id: string;
  name: string;
  kind: 'polygon' | 'radius';
  polygon?: Array<[number, number]>;
  center?: [number, number];
  radiusKm?: number;
  effects: Record<string, unknown>;
}

export interface FulfillmentNode {
  id: string;
  name: string;
  kind: string;
  location: [number, number];
  capabilities: string[];
}

export interface GeoPack {
  pack: { name: string };
  zones: ZoneDef[];
  geofences: GeofenceDef[];
  fulfillmentNodes: FulfillmentNode[];
  routingPolicy: { maxShipFromStoreKm: number; maxBopisKm: number; maxCandidates: number };
}

export interface Address {
  country: string;
  region?: string;
  postalCode?: string;
}

const EARTH_RADIUS_KM = 6371;

/** haversine great-circle distance */
export function distanceKm(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h)) * 100) / 100;
}

/** ray-casting point-in-polygon (lat/lon vertices) */
export function pointInPolygon(point: [number, number], polygon: Array<[number, number]>): boolean {
  const [py, px] = point; // lat=y, lon=x
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i]!;
    const [yj, xj] = polygon[j]!;
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export class GeoService {
  private pack: GeoPack;

  constructor(pack: GeoPack) {
    this.pack = pack;
  }

  /** all zones matching an address, highest priority first (drives tax/shipping/eligibility) */
  resolveZones(addr: Address): ZoneDef[] {
    return this.pack.zones
      .filter((z) =>
        z.match.some((m) => {
          if (m.country !== addr.country) return false;
          if (m.regions && (!addr.region || !m.regions.includes(addr.region))) return false;
          if (m.postalPrefixes && (!addr.postalCode || !m.postalPrefixes.some((p) => addr.postalCode!.startsWith(p)))) return false;
          return true;
        })
      )
      .sort((a, b) => b.priority - a.priority);
  }

  /** geofences containing a coordinate, with their pack-declared effects */
  inGeofence(point: [number, number]): Array<{ id: string; name: string; effects: Record<string, unknown> }> {
    return this.pack.geofences
      .filter((g) => {
        if (g.kind === 'polygon' && g.polygon) return pointInPolygon(point, g.polygon);
        if (g.kind === 'radius' && g.center && g.radiusKm !== undefined) return distanceKm(point, g.center) <= g.radiusKm;
        return false;
      })
      .map((g) => ({ id: g.id, name: g.name, effects: g.effects }));
  }

  /** nearest capable fulfillment nodes under the pack's distance cap for the capability */
  nearestNodes(point: [number, number], capability: string): Array<{ node: FulfillmentNode; km: number }> {
    const policy = this.pack.routingPolicy;
    const cap = capability === 'bopis' ? policy.maxBopisKm : policy.maxShipFromStoreKm;
    return this.pack.fulfillmentNodes
      .filter((n) => n.capabilities.includes(capability))
      .map((n) => ({ node: n, km: distanceKm(point, n.location) }))
      .filter((c) => c.km <= cap)
      .sort((a, b) => a.km - b.km)
      .slice(0, policy.maxCandidates);
  }
}

// ---------- Module-as-a-Product contract ----------
const geoModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as GeoPack;
    const svc = new GeoService(pack);
    const meter = (ev: string) => billing.meter(ev, 1);
    return {
      resolveZones: (a: Address) => (meter('geo.zone.resolved'), svc.resolveZones(a)),
      inGeofence: (p: [number, number]) => svc.inGeofence(p),
      nearestNodes: (p: [number, number], cap: string) => (meter('geo.route.selected'), svc.nearestNodes(p, cap)),
      distanceKm: (a: [number, number], b: [number, number]) => distanceKm(a, b),
      __raw: svc,
    };
  },
};

export default geoModule;
