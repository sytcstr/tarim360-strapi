import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPECTED_PRODUCT_COUNT,
  EXPECTED_PROVINCE_COUNT,
  FORBIDDEN_PRICE_KEYS,
  productCatalog,
  provinceCatalog,
  validateProductCatalog,
  validateProvinceCatalog,
} from '../../src/utils/reference-catalogs';

test('province catalogue: exactly 81 valid rows', () => {
  assert.equal(provinceCatalog.length, EXPECTED_PROVINCE_COUNT);
  assert.deepEqual(validateProvinceCatalog(provinceCatalog), []);
});

test('province plate codes are unique and run 01..81; slugs and names unique', () => {
  const plates = provinceCatalog.map((p) => p.plateCode);
  assert.equal(new Set(plates).size, 81);
  assert.deepEqual(plates, Array.from({ length: 81 }, (_, i) => String(i + 1).padStart(2, '0')));
  assert.equal(new Set(provinceCatalog.map((p) => p.slug)).size, 81);
  assert.equal(new Set(provinceCatalog.map((p) => p.name)).size, 81);
});

test('province coordinates are inside Turkey and regions are the 7 geographic regions', () => {
  for (const p of provinceCatalog) {
    assert.ok(p.latitude >= 35 && p.latitude <= 43, p.name);
    assert.ok(p.longitude >= 25 && p.longitude <= 45, p.name);
  }
  const regions = new Set(provinceCatalog.map((p) => p.region));
  assert.equal(regions.size, 7);
});

test('well-known plates map to the right province', () => {
  const byPlate = new Map(provinceCatalog.map((p) => [p.plateCode, p.slug]));
  assert.equal(byPlate.get('06'), 'ankara');
  assert.equal(byPlate.get('34'), 'istanbul');
  assert.equal(byPlate.get('35'), 'izmir');
  assert.equal(byPlate.get('42'), 'konya');
  assert.equal(byPlate.get('81'), 'duzce');
});

test('validation rejects a broken province catalogue', () => {
  const broken = provinceCatalog.map((p) => ({ ...p }));
  broken[5] = { ...broken[5], plateCode: '07' }; // duplicate + wrong order
  broken[10] = { ...broken[10], latitude: 99 };
  const errors = validateProvinceCatalog(broken);
  assert.ok(errors.some((e) => e.includes('duplicate plateCode')));
  assert.ok(errors.some((e) => e.includes('invalid latitude')));
  assert.ok(validateProvinceCatalog(provinceCatalog.slice(0, 80)).some((e) => e.includes('expected 81')));
});

test('product catalogue: exactly 52 valid rows with unique slug and code', () => {
  assert.equal(productCatalog.length, EXPECTED_PRODUCT_COUNT);
  assert.deepEqual(validateProductCatalog(productCatalog), []);
  assert.equal(new Set(productCatalog.map((p) => p.slug)).size, 52);
  assert.equal(new Set(productCatalog.map((p) => p.code)).size, 52);
});

test('product reference data carries NO price / market fields', () => {
  for (const row of productCatalog) {
    for (const key of FORBIDDEN_PRICE_KEYS) {
      assert.equal(Object.prototype.hasOwnProperty.call(row, key), false, `${row.name}.${key}`);
    }
    assert.deepEqual(Object.keys(row).sort(), ['category', 'code', 'defaultUnit', 'isActive', 'name', 'slug']);
  }
});

test('validation rejects a product row that carries a price', () => {
  const bad = productCatalog.map((p) => ({ ...p }));
  (bad[0] as any).price = 14.25;
  assert.ok(validateProductCatalog(bad).some((e) => e.includes('must not carry "price"')));
});
