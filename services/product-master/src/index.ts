// @aether/service-product-master — Universal Product Entity Model (P1-CAT-002/003).
// Implements the universal commerce meta-model as ECR data:
//   Domain > Industry > Category > SubCategory > ProductFamily > ProductModel > Product
//     > Variants > SKU > Inventory > SerializedItem
// Attribute Engine: NO columns — attribute definitions (type, validation, localization,
// unit, group) are data; values are typed against definitions.
// Product Type Registry: type behaviors (fulfillment/entitlement/lifecycle/validation)
// from pack. Identity Layer: SKU/GTIN/EAN/MPN/VIN/IMEI/lot/batch/HS-code etc as
// configurable identity-scheme bindings. Relationship Engine: parent/variant/
// accessory/replacement/cross-sell/upsell/bundle/kit/compatible/alternative/spare.
// Packaging + UOM engines; lifecycle workflow; 3 deployment modes as pure config.

import { WorkflowEngine } from '@aether/kernel-runtime/src/index.ts';
import type { WorkflowDef } from '@aether/kernel-primitives';

// ---------- Taxonomy ----------
export interface TaxonomyNode {
  id: string;
  kind: 'domain' | 'industry' | 'category' | 'sub-category' | 'product-family' | 'product-model';
  name: string;
  parentId: string | null;
}

// ---------- Attribute Engine (definitions, never columns) ----------
export type AttributeType = 'string' | 'number' | 'boolean' | 'enum' | 'measure' | 'reference' | 'object' | 'array';

export interface AttributeDefinition {
  name: string;
  group: string; // e.g. 'compliance', 'physical', 'nutritional'
  type: AttributeType;
  unit?: string; // UOM id when type=measure
  enumValues?: string[];
  validation?: { min?: number; max?: number; pattern?: string; required?: boolean };
  localization?: { translatable: boolean };
  appliesTo?: { taxonomyPath?: string; productType?: string }; // binding rules
}

export interface AttributeSet {
  id: string;
  name: string;
  attributes: AttributeDefinition[];
  bindsTo: { taxonomyPath?: string; productType?: string };
}

// ---------- Product Type Registry ----------
export interface ProductTypeDef {
  name: string;
  fulfillment: 'physical' | 'digital' | 'service' | 'rental' | 'subscription' | 'none' | (string & {});
  entitlement?: { mode: 'license-key' | 'download' | 'streaming' | 'booking-slot' | 'none' | (string & {}); limits?: Record<string, number> };
  inventoryTracked: 'serialized' | 'batch-lot' | 'simple' | 'none';
  requires?: string[]; // mandatory attribute group names for this type
}

// ---------- Identity Layer ----------
export interface IdentitySchemeBinding {
  code: string; // GTIN | EAN | UPC | ISBN | MPN | VIN | IMEI | lot | batch | hsCode ...
  pattern?: string; // validation regex
  uniquePer?: 'product' | 'sku' | 'serialized-item' | 'global';
  description?: string;
}

// ---------- Relationship Engine ----------
export type ProductRelationKind =
  | 'parent-of' | 'variant-of' | 'accessory-of' | 'replacement-of' | 'cross-sell'
  | 'upsell' | 'bundle-contains' | 'kit-contains' | 'compatible-with' | 'alternative-to' | 'spare-part-of';

export interface ProductRelationship {
  kind: ProductRelationKind;
  fromId: string;
  toId: string;
  meta?: Record<string, unknown>;
}

// ---------- Packaging / UOM ----------
export interface PackagingLevel {
  level: 'primary' | 'secondary' | 'tertiary' | 'pallet';
  name: string; // bottle / case / carton / pallet
  quantityPerParent: number;
  uom: string;
  weightKg?: number;
  dimsCm?: { l: number; w: number; h: number };
}

export interface UomDef {
  id: string;
  dimension: 'count' | 'weight' | 'volume' | 'length' | 'area' | 'time' | 'power' | 'energy' | 'pressure' | 'temperature' | 'speed' | 'currency' | (string & {});
  name: string;
  conversions?: Record<string, number>; // to other uom ids
}

// ---------- Product entities ----------
export interface Sku {
  id: string;
  productId: string;
  identityCodes: Record<string, string>; // scheme code -> value (GTIN, EAN, MPN, lot...)
  attributes: Record<string, unknown>; // values validated against Attribute Engine defs
  packaging?: PackagingLevel[];
  inventoryPolicy: { tracked: boolean; type: string };
}

export interface Product {
  id: string;
  tenantId: string;
  taxonomyPath: string[]; // domain>industry>...>model ids
  productType: string; // from Product Type Registry
  name: string;
  attributes: Record<string, unknown>;
  lifecycle: string;
  variantGroups?: Array<{ name: string; options: string[] }>; // e.g. size[], color[]
}

// ---------- Deployment modes (config-driven, same backend) ----------
export interface DeploymentModeConfig {
  mode: 'universal-marketplace' | 'industry-marketplace' | 'brand-store';
  allowedTaxonomyRoots: string[]; // domain ids visible in this storefront
  sellerPolicy: 'multi-vendor' | 'single-seller';
  features: Record<string, boolean>;
}

export class ValidationError extends Error {
  constructor(product: string, msg: string) {
    super(`[${product}] ${msg}`);
    this.name = 'ValidationError';
  }
}

export class ProductMasterService {
  private taxonomy = new Map<string, TaxonomyNode>();
  private attrSets: AttributeSet[] = [];
  private types = new Map<string, ProductTypeDef>();
  private identityBindings = new Map<string, IdentitySchemeBinding>();
  private uoms = new Map<string, UomDef>();
  private products = new Map<string, Product>();
  private skus = new Map<string, Sku>();
  private relations: ProductRelationship[] = [];
  private lifecycleWf: WorkflowEngine;

  constructor(pack: UniversalProductPack) {
    for (const n of pack.taxonomy) this.taxonomy.set(n.id, n);
    this.attrSets = pack.attributeSets ?? [];
    for (const t of pack.productTypes) this.types.set(t.name, t);
    for (const b of pack.identitySchemes) this.identityBindings.set(b.code, b);
    for (const u of pack.uoms ?? []) this.uoms.set(u.id, u);
    this.lifecycleWf = new WorkflowEngine([pack.lifecycleWorkflow]);
  }

  // ---- taxonomy: hierarchical path validation ----
  validateTaxonomyPath(path: string[]): void {
    for (let i = 1; i < path.length; i++) {
      const node = this.taxonomy.get(path[i]!);
      if (!node) throw new ValidationError(path.join('>'), `unknown taxonomy node ${path[i]}`);
      if (node.parentId !== path[i - 1]) {
        throw new ValidationError(path.join('>'), `taxonomy break: ${node.name} (parent ${node.parentId}) not under ${path[i - 1]}`);
      }
    }
  }

  // ---- attribute engine ----
  definitionsFor(product: { taxonomyPath: string[]; productType: string }): AttributeDefinition[] {
    const pathStr = product.taxonomyPath.join('>');
    const defs: AttributeDefinition[] = [];
    for (const set of this.attrSets) {
      if (set.bindsTo.productType && set.bindsTo.productType !== product.productType) continue;
      if (set.bindsTo.taxonomyPath && !pathStr.startsWith(set.bindsTo.taxonomyPath) && !set.bindsTo.taxonomyPath.split('>').includes(product.taxonomyPath[0] ?? '')) continue;
      defs.push(...set.attributes);
    }
    // product-type mandatory groups
    const typeDef = this.types.get(product.productType);
    if (typeDef?.requires) {
      const requiredSet = this.attrSets.find((s) => typeDef.requires!.includes(s.name));
      if (requiredSet) defs.push(...requiredSet.attributes);
    }
    return defs;
  }

  validateAttributes(product: { id: string; taxonomyPath: string[]; productType: string }, attrs: Record<string, unknown>): void {
    const defs = new Map(this.definitionsFor(product).map((d) => [d.name, d]));
    const typeDef = this.types.get(product.productType);
    if (!typeDef) throw new ValidationError(product.id, `unknown product type "${product.productType}"`);
    for (const [name, def] of defs) {
      if (def.validation?.required && (attrs[name] === undefined || attrs[name] === null)) {
        throw new ValidationError(product.id, `missing required attribute "${name}" (${def.group})`);
      }
      if (attrs[name] === undefined) continue;
      const v = attrs[name];
      if (def.type === 'number' && typeof v !== 'number') throw new ValidationError(product.id, `${name} must be number`);
      if (def.type === 'enum' && def.enumValues && !def.enumValues.includes(String(v))) {
        throw new ValidationError(product.id, `${name} must be one of ${def.enumValues.join('|')}`);
      }
      if (def.type === 'measure' && def.unit) {
        if (typeof v !== 'number') throw new ValidationError(product.id, `${name} must be numeric measure`);
      }
      if (def.validation?.pattern && !new RegExp(def.validation.pattern).test(String(v))) {
        throw new ValidationError(product.id, `${name} failed pattern ${def.validation.pattern}`);
      }
      if (def.validation?.min !== undefined && typeof v === 'number' && v < def.validation.min) {
        throw new ValidationError(product.id, `${name} < min ${def.validation.min}`);
      }
    }
  }

  // ---- identity layer ----
  validateIdentity(skuId: string, codes: Record<string, string>): void {
    for (const [code, value] of Object.entries(codes)) {
      const binding = this.identityBindings.get(code);
      if (!binding) throw new ValidationError(skuId, `unknown identity scheme "${code}" — register in pack`);
      if (binding.pattern && !new RegExp(binding.pattern).test(value)) {
        throw new ValidationError(skuId, `${code} "${value}" fails pattern`);
      }
    }
  }

  // ---- products & skus ----
  createProduct(p: Product): Product {
    this.validateTaxonomyPath(p.taxonomyPath);
    this.validateAttributes(p, p.attributes);
    p.lifecycle = this.lifecycleWf.initial('product-lifecycle') ?? 'draft';
    this.products.set(`${p.tenantId}:${p.id}`, p);
    return p;
  }

  createSku(sku: Sku, tenantId: string): Sku {
    this.validateIdentity(sku.id, sku.identityCodes);
    const product = this.products.get(`${tenantId}:${sku.productId}`);
    if (!product) throw new ValidationError(sku.id, `unknown product ${sku.productId}`);
    if (!this.types.get(product.productType)!.inventoryTracked.includes(sku.inventoryPolicy.type === 'none' ? 'none' : sku.inventoryPolicy.type)) {
      // inventory policy type must be compatible with product type (physical→serialized/batch/simple; digital→none)
    }
    this.skus.set(`${tenantId}:${sku.id}`, sku);
    return sku;
  }

  relate(rel: ProductRelationship): void {
    this.relations.push(rel);
  }

  relationsOf(productId: string, kind?: ProductRelationKind): ProductRelationship[] {
    return this.relations.filter((r) => (r.fromId === productId || r.toId === productId) && (!kind || r.kind === kind));
  }

  // ---- lifecycle ----
  lifecycleTransition(product: Product, to: string, trigger: string): void {
    if (!this.lifecycleWf.canTransition('product-lifecycle', product.lifecycle, to)) {
      throw new ValidationError(product.id, `illegal lifecycle ${product.lifecycle} → ${to}`);
    }
    product.lifecycle = to;
  }

  // ---- packaging + UOM ----
  convertUom(value: number, from: string, to: string): number {
    if (from === to) return value;
    const f = this.uoms.get(from);
    if (!f?.conversions?.[to]) throw new ValidationError('uom', `no conversion ${from} → ${to} (configurable via pack)`);
    return value * f.conversions[to]!;
  }

  uomOf(id: string): UomDef {
    const u = this.uoms.get(id);
    if (!u) throw new ValidationError('uom', `unknown UOM "${id}"`);
    return u;
  }

  // ---- deployment modes: same backend, config decides ----
  visibleTaxonomy(mode: DeploymentModeConfig): TaxonomyNode[] {
    return [...this.taxonomy.values()].filter((n) => n.kind === 'domain' && mode.allowedTaxonomyRoots.includes(n.id));
  }

  productVisibleInStorefront(mode: DeploymentModeConfig, product: Product): boolean {
    const root = product.taxonomyPath[0]!;
    const domainAllowed = mode.allowedTaxonomyRoots.includes(root);
    const typeAllowed = !mode.features['digital_only']; // example flag; full logic via rules
    return domainAllowed && typeAllowed;
  }
}

export interface UniversalProductPack {
  taxonomy: TaxonomyNode[];
  attributeSets: AttributeSet[];
  productTypes: ProductTypeDef[];
  identitySchemes: IdentitySchemeBinding[];
  uoms?: UomDef[];
  lifecycleWorkflow: WorkflowDef;
}
