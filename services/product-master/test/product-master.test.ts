// Tests: Universal Product Master — taxonomy hierarchy, attribute engine (no columns),
// type registry, identity layer, relationships, packaging/UOM, lifecycle, 3 modes (P1-CAT-002/003).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProductMasterService, ValidationError } from '../src/index.ts';
import type { Product, Sku, DeploymentModeConfig } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../../../packs/universal-product/pack.json'), 'utf8'));
const svc = () => new ProductMasterService(pack);

// ---- taxonomy hierarchy ----
test('taxonomy: valid deep path (domain→model) accepted; broken path rejected', () => {
  const s = svc();
  s.validateTaxonomyPath(['dom_hardware', 'cat_hardware_fasteners', 'fam_bolts', 'model_bolt_m10']);
  assert.throws(() => s.validateTaxonomyPath(['dom_hardware', 'fam_bolts']), ValidationError); // skips category
});

// ---- attribute engine ----
test('attribute engine: grocery compliance required per taxonomy binding', () => {
  const s = svc();
  // missing expiryDate/lotNumber/storageCondition → rejected
  assert.throws(
    () =>
      s.createProduct({
        id: 'milk-1', tenantId: 't', taxonomyPath: ['dom_food', 'ind_grocery', 'fam_milk', 'model_milk_1l'],
        productType: 'perishable', name: 'Milk', attributes: { hsCode: '0401.10', countryOfOrigin: 'IN' },
      }),
    /missing required attribute "expiryDate"/
  );
  const ok = s.createProduct({
    id: 'milk-2', tenantId: 't', taxonomyPath: ['dom_food', 'ind_grocery', 'fam_milk', 'model_milk_1l'],
    productType: 'perishable', name: 'Milk',
    attributes: {
      hsCode: '0401.10', countryOfOrigin: 'IN', expiryDate: '2026-09-20', storageCondition: 'chilled',
      lotNumber: 'L260901', caloriesPer100g: 61, organicCertified: true,
    },
  });
  assert.equal(ok.lifecycle, 'draft');
});

test('attribute engine: bolt is NOT a t-shirt — hardware specs enforced', () => {
  const s = svc();
  assert.throws(
    () =>
      s.createProduct({
        id: 'bolt-1', tenantId: 't', taxonomyPath: ['dom_hardware', 'cat_hardware_fasteners', 'fam_bolts', 'model_bolt_m10'],
        productType: 'physical', name: 'M10 Bolt', attributes: { hsCode: '7318.15' }, // no threadSize/diameter
      }),
    /missing required attribute "threadSize"/
  );
  s.createProduct({
    id: 'bolt-2', tenantId: 't', taxonomyPath: ['dom_hardware', 'cat_hardware_fasteners', 'fam_bolts', 'model_bolt_m10'],
    productType: 'physical', name: 'M10 Bolt',
    attributes: { hsCode: '7318.15', threadSize: 'M10', diameterMm: 10, lengthMm: 50, materialGrade: 'A2-70', torqueRatingNm: 47 },
  });
});

test('attribute engine: enum + pattern validation from definitions', () => {
  const s = svc();
  assert.throws(
    () =>
      s.createProduct({
        id: 'milk-3', tenantId: 't', taxonomyPath: ['dom_food', 'ind_grocery'],
        productType: 'perishable', name: 'Milk',
        attributes: { hsCode: '0401.10', countryOfOrigin: 'IN', expiryDate: '2026-09-20', storageCondition: 'volcanic', lotNumber: 'L1' },
      }),
    /storageCondition must be one of/
  );
  assert.throws(
    () =>
      s.createProduct({
        id: 'milk-4', tenantId: 't', taxonomyPath: ['dom_food', 'ind_grocery'],
        productType: 'perishable', name: 'Milk',
        attributes: { hsCode: 'not-a-code', countryOfOrigin: 'IN', expiryDate: '2026-09-20', storageCondition: 'chilled', lotNumber: 'L1' },
      }),
    /hsCode failed pattern/
  );
});

test('product-type registry: digital entitlement, service booking, rental deposit from pack', () => {
  const s = svc();
  s.createProduct({
    id: 'sw-1', tenantId: 't', taxonomyPath: ['dom_digital', 'cat_digital_software'],
    productType: 'digital', name: 'Photo Editor Pro',
    attributes: { hsCode: '8523.49', licenseMode: 'license-key', activationLimit: 5, drmScheme: 'fairplay-class' },
  });
  s.createProduct({
    id: 'svc-1', tenantId: 't', taxonomyPath: ['dom_services', 'cat_services_consulting'],
    productType: 'service', name: 'Legal Consult',
    attributes: { hsCode: '9999.99', durationMinutes: 60, slaHours: 24, requiresLocation: false },
  });
  s.createProduct({
    id: 'rent-1', tenantId: 't', taxonomyPath: ['dom_rental'],
    productType: 'rental', name: 'Tile Saw',
    attributes: { hsCode: '8467.21', securityDeposit: 150, inspectionRequired: true, rentalDurationHours: 24 },
  });
  assert.ok(true);
});

// ---- identity layer ----
test('identity layer: GTIN/EAN/VIN/IMEI pattern enforcement; unknown scheme rejected', () => {
  const s = svc();
  s.createProduct({
    id: 'p1', tenantId: 't', taxonomyPath: ['dom_retail'],
    productType: 'physical', name: 'Widget', attributes: { hsCode: '0000.00' },
  });
  s.createSku({ id: 'sku-ok', productId: 'p1', identityCodes: { SKU: 'WID-001', EAN: '4006381333931' }, attributes: {}, inventoryPolicy: { tracked: true, type: 'simple' } }, 't');
  assert.throws(
    () => s.createSku({ id: 'sku-bad', productId: 'p1', identityCodes: { EAN: '12345' }, attributes: {}, inventoryPolicy: { tracked: true, type: 'simple' } }, 't'),
    /EAN .* fails pattern/
  );
  assert.throws(
    () => s.createSku({ id: 'sku-bad2', productId: 'p1', identityCodes: { MAGIC: 'x' }, attributes: {}, inventoryPolicy: { tracked: true, type: 'simple' } }, 't'),
    /unknown identity scheme "MAGIC"/
  );
});

// ---- relationship engine ----
test('relationships: variant-of, compatible-with, spare-part-of, cross-sell', () => {
  const s = svc();
  s.relate({ kind: 'variant-of', fromId: 'tee-red', toId: 'tee' });
  s.relate({ kind: 'compatible-with', fromId: 'bolt-m10', toId: 'nut-m10' });
  s.relate({ kind: 'spare-part-of', fromId: 'filter-2', toId: 'ac-2000' });
  s.relate({ kind: 'cross-sell', fromId: 'tee', toId: 'jeans' });
  assert.equal(s.relationsOf('tee', 'variant-of').length, 1);
  assert.equal(s.relationsOf('nut-m10').length, 1); // reverse lookup
  assert.equal(s.relationsOf('tee').length, 2); // variant + cross-sell both touch tee
});

// ---- lifecycle ----
test('product lifecycle: draft→review→approved→published; illegal skips rejected', () => {
  const s = svc();
  const p = s.createProduct({
    id: 'lc-1', tenantId: 't', taxonomyPath: ['dom_retail'],
    productType: 'physical', name: 'LC', attributes: { hsCode: '0000.00' },
  });
  s.lifecycleTransition(p, 'review', 'submitted');
  s.lifecycleTransition(p, 'approved', 'moderation-passed');
  s.lifecycleTransition(p, 'published', 'publish');
  assert.throws(() => s.lifecycleTransition(p, 'archived', 'skip'), ValidationError);
  s.lifecycleTransition(p, 'discontinued', 'eol-decision');
  s.lifecycleTransition(p, 'archived', 'retention-elapsed');
  assert.equal(p.lifecycle, 'archived');
});

// ---- UOM engine ----
test('UOM conversions from pack config', () => {
  const s = svc();
  assert.equal(s.convertUom(2, 'kg', 'g'), 2000);
  assert.equal(Math.round(s.convertUom(1, 'lb', 'kg') * 1000), 454);
  assert.equal(s.convertUom(90, 'minute', 'hour') > 1.49 && s.convertUom(90, 'minute', 'hour') < 1.51, true);
  assert.throws(() => s.convertUom(1, 'kg', 'volt'), /no conversion/);
});

// ---- 3 deployment modes, same backend ----
test('deployment modes: universal vs industry vs brand-store — config decides', () => {
  const s = svc();
  const universal: DeploymentModeConfig = { mode: 'universal-marketplace', allowedTaxonomyRoots: ['dom_retail', 'dom_food', 'dom_furniture', 'dom_hardware', 'dom_auto', 'dom_electronics', 'dom_pharma', 'dom_digital', 'dom_services', 'dom_rental'], sellerPolicy: 'multi-vendor', features: {} };
  const groceryOnly: DeploymentModeConfig = { mode: 'industry-marketplace', allowedTaxonomyRoots: ['dom_food'], sellerPolicy: 'multi-vendor', features: {} };
  const brandStore: DeploymentModeConfig = { mode: 'brand-store', allowedTaxonomyRoots: ['dom_furniture'], sellerPolicy: 'single-seller', features: { digital_only: false } };

  assert.equal(s.visibleTaxonomy(universal).length, 10);
  assert.equal(s.visibleTaxonomy(groceryOnly).length, 1);
  assert.equal(s.visibleTaxonomy(brandStore).length, 1);

  const milk = { id: 'm', tenantId: 't', taxonomyPath: ['dom_food'], productType: 'perishable', name: 'Milk', attributes: {}, lifecycle: 'published' };
  const sofa = { id: 's', tenantId: 't', taxonomyPath: ['dom_furniture'], productType: 'physical', name: 'Sofa', attributes: {}, lifecycle: 'published' };
  assert.equal(s.productVisibleInStorefront(groceryOnly, milk as Product), true);
  assert.equal(s.productVisibleInStorefront(groceryOnly, sofa as Product), false);
  assert.equal(s.productVisibleInStorefront(brandStore, sofa as Product), true);
  assert.equal(s.productVisibleInStorefront(universal, milk as Product), true);
  assert.equal(s.productVisibleInStorefront(universal, sofa as Product), true);
});

test('pharma: UDI + prescription rules enforced from pack', () => {
  const s = svc();
  assert.throws(
    () =>
      s.createProduct({
        id: 'rx-1', tenantId: 't', taxonomyPath: ['dom_pharma', 'cat_pharma_rx'],
        productType: 'pharma', name: 'Med', attributes: { hsCode: '3004.90' }, // missing udi etc
      }),
    /missing required attribute "udi"/
  );
  s.createProduct({
    id: 'rx-2', tenantId: 't', taxonomyPath: ['dom_pharma', 'cat_pharma_rx'],
    productType: 'pharma', name: 'Med',
    attributes: { hsCode: '3004.90', udi: 'UDI-123456', regulatoryApproval: 'FDA-2026-001', expiryDate: '2027-01-01', batchNumber: 'B1', prescriptionRequired: true },
  });
});

test('packaging: multi-level packaging on SKU (bottle→case→carton→pallet)', () => {
  const s = svc();
  s.createProduct({ id: 'pk-1', tenantId: 't', taxonomyPath: ['dom_food', 'ind_grocery'], productType: 'perishable', name: 'Juice', attributes: { hsCode: '2009.11', countryOfOrigin: 'IN', expiryDate: '2026-10-01', storageCondition: 'ambient', lotNumber: 'L1' } });
  const sku = s.createSku({
    id: 'pk-sku-1', productId: 'pk-1',
    identityCodes: { SKU: 'JUI-1L', EAN: '4006381333931' },
    attributes: {},
    inventoryPolicy: { tracked: true, type: 'batch-lot' },
    packaging: [
      { level: 'primary', name: 'bottle', quantityPerParent: 1, uom: 'each', weightKg: 1.05 },
      { level: 'secondary', name: 'case', quantityPerParent: 12, uom: 'each', weightKg: 13 },
      { level: 'tertiary', name: 'carton', quantityPerParent: 4, uom: 'each' },
      { level: 'pallet', name: 'pallet', quantityPerParent: 40, uom: 'each' },
    ],
  }, 't');
  assert.equal(sku.packaging!.length, 4);
});

test('validateAttributes: direct legality probe — required/missing, enum, type; unknown type rejected', () => {
  const s = svc();
  const product = { id: 'vld-1', taxonomyPath: ['dom_food', 'ind_grocery', 'fam_milk', 'model_milk_1l'], productType: 'perishable' };
  // valid attribute set passes
  s.validateAttributes(product, {
    hsCode: '0401.10', countryOfOrigin: 'IN', expiryDate: '2026-09-20',
    storageCondition: 'chilled', lotNumber: 'L1', caloriesPer100g: 61, organicCertified: true,
  });
  // missing required
  assert.throws(() => s.validateAttributes(product, { hsCode: '0401.10' }), /missing required attribute/);
  // wrong scalar type
  assert.throws(
    () => s.validateAttributes(product, { hsCode: '0401.10', countryOfOrigin: 'IN', expiryDate: '2026-09-20', storageCondition: 'chilled', lotNumber: 'L1', caloriesPer100g: 'sixty-one' }),
    /caloriesPer100g must be numeric measure/
  );
  // unknown product type
  assert.throws(() => s.validateAttributes({ ...product, productType: 'teleportation' }, {}), /unknown product type/);
});

test('validateIdentity: scheme bindings from pack — pattern pass/fail, unknown scheme rejected', () => {
  const s = svc();
  s.validateIdentity('sku-1', { GTIN: '00123456789012' }); // 14-digit GTIN from pack pattern
  assert.throws(() => s.validateIdentity('sku-1', { GTIN: 'not-a-gtin' }), /fails pattern/);
  assert.throws(() => s.validateIdentity('sku-1', { 'NO-SUCH-SCHEME': 'x' }), /unknown identity scheme .* register in pack/);
});
