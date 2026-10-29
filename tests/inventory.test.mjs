import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productId, parseProductSheet, withOnHand, summarizeItemSales, itemSalesTsv, matches } from '../app/js/inventory/stock.js';

test('reads a pasted spreadsheet (tabs), skipping the TOTAL row and extra columns', () => {
  const text = [
    'Product\tLine\tBucket\tPrice ($)\tGrams per unit\tCount\tRetail value ($)\tTotal grams',
    'FF Monkey\tFlexi Factory\tUnsorted\t$12.00\t90\t13\t156\t1170',
    'Z3D Ghost Keychain\tZ3D\tUnsorted\t5\t10\t12\t60\t120',
    'TOTAL\t\t\t\t\t25\t216\t1290',
  ].join('\n');
  const r = parseProductSheet(text);
  assert.equal(r.error, '');
  assert.deepEqual(r.products, [
    { name: 'FF Monkey', price_cents: 1200, grams: 90, count: 13 },
    { name: 'Z3D Ghost Keychain', price_cents: 500, grams: 10, count: 12 },
  ]);
});

test('reads a CSV file with quoted names and adds up duplicate rows', () => {
  const text = 'Product,Price,Grams per unit,Count\r\n"Dragon, small",10,60,2\r\nDragon  small,,,1\r\n"Dragon, small",10,60,3\r\n';
  const r = parseProductSheet(text);
  assert.equal(r.products.length, 2);
  assert.equal(r.products[0].count, 5);
  assert.equal(r.products[1].price_cents, null);
});

test('explains a sheet with no Product column', () => {
  assert.match(parseProductSheet('Name,Price\nX,1').error, /Product/);
});

test('on hand only counts sales made after the count was taken', () => {
  const products = [{ id: 'prod_a', name: 'A', count: 10, counted_at: '2026-11-01T12:00:00.000Z' }];
  const sales = [
    { product_id: 'prod_a', qty: 2, sold_at: '2026-10-30T15:00:00.000Z' }, // before the count: already reflected
    { product_id: 'prod_a', qty: 3, sold_at: '2026-11-05T15:00:00.000Z' },
    { product_id: 'prod_a', qty: 1, sold_at: '2026-11-05T16:00:00.000Z', deleted: true }, // undone
    { product_id: null, name: 'Custom', qty: 1, sold_at: '2026-11-05T16:00:00.000Z' },
  ];
  const [a] = withOnHand(products, sales);
  assert.equal(a.sold, 3);
  assert.equal(a.on_hand, 7);
});

test('item sales total by payment method, day and product', () => {
  const sales = [
    { date: '2026-11-05', product_id: 'prod_a', name: 'A', qty: 2, price_cents: 1000, method: 'cash' },
    { date: '2026-11-05', product_id: 'prod_b', name: 'B', qty: 1, price_cents: 500, method: 'card' },
    { date: '2026-11-06', product_id: 'prod_a', name: 'A', qty: 1, price_cents: 800, method: 'card' },
  ];
  const s = summarizeItemSales(sales);
  assert.equal(s.units, 4);
  assert.equal(s.cash, 2000);
  assert.equal(s.card, 1300);
  assert.equal(s.gross, 3300);
  assert.deepEqual(s.byDate['2026-11-05'], { units: 3, cash: 2000, card: 500 });
  assert.deepEqual(s.byProduct[0], { product_id: 'prod_a', name: 'A', qty: 3, amount: 2800 });
  const tsv = itemSalesTsv(sales).split('\n');
  assert.equal(tsv.length, 4);
  assert.match(tsv[1], /\tA\t2\t10\.00\t20\.00\tCash$/);
});

test('product ids are stable and search matches every word', () => {
  assert.equal(productId('Z3D Nessy 200%'), productId('z3d  nessy 200%'));
  assert.ok(matches('Crystal Dragon_Cinderwing', 'drag cinder'));
  assert.ok(!matches('Crystal Dragon_Cinderwing', 'drag skeleton'));
});
