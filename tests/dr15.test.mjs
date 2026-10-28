import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReturn, periodInfo, lateMonths, salesItems } from '../app/js/tax/fl-dr15.js';

test('periods and due dates', () => {
  assert.deepEqual(periodInfo('2026-Q3'), { period: '2026-Q3', label: 'Q3 2026', start: '2026-07-01', end: '2026-09-30', due: '2026-10-01', lateAfter: '2026-10-20' });
  assert.equal(periodInfo('2026-Q4').lateAfter, '2027-01-20');
  assert.equal(lateMonths('2026-10-20', '2026-10-27'), 1);
  assert.equal(lateMonths('2026-10-20', '2026-10-20'), 0);
  assert.equal(lateMonths('2026-04-20', '2026-10-30'), 5); // capped at 5 (50%)
});

// The Q3 2026 return Printomancy filed on Oct 27: line 5 = $126.11, penalty $50, interest $0.30, paid $176.41.
test('reproduces the filed Q3 2026 return', () => {
  const items = [
    { key: 'paypal', amount_cents: 59100, default: 'taxable_included' },            // PayPal POS, tax included
    { key: 'stripe', amount_cents: 82568, default: 'taxable_included' },            // Stripe deposits treated as FL sales, tax included
    { key: 'shopFL', amount_cents: 29500, default: 'taxable_not_collected' },       // FL orders with no tax charged
    { key: 'oos', amount_cents: 11029, default: 'exempt' },                         // shipped out of state
    { key: 'etsy', amount_cents: 106865, default: 'marketplace' },
  ];
  const ret = computeReturn({ period: '2026-Q3', items, opts: { useTaxManualCents: 6858, filedOn: '2026-10-27', interestCents: 30 } });
  const L = ret.lines;
  assert.equal(L.A1, 172313);
  assert.equal(L.A2, 11029);
  assert.equal(L.A3, 161284);
  assert.equal(L.A4, 12097);
  assert.equal(L.B4, 514);
  assert.equal(L[5], 12611);
  assert.equal(L[11], 0);       // late, so no collection allowance
  assert.equal(L[12], 5000);    // 10% would be $12.61; the $50 minimum applies
  assert.equal(L[14], 17641);   // $176.41, what was paid
  assert.equal(L['15d'], 2522);
});

test('on-time filing earns the collection allowance (2.5% of the first $1,200, max $30)', () => {
  const small = computeReturn({ period: '2026-Q4', items: [{ key: 'a', amount_cents: 107500, default: 'taxable_included' }], opts: { filedOn: '2027-01-15' } });
  assert.equal(small.lines[5], 7500);
  assert.equal(small.lines[11], 188);
  const big = computeReturn({ period: '2026-Q4', items: [{ key: 'a', amount_cents: 2150000, default: 'taxable_included' }], opts: { filedOn: '2027-01-15' } });
  assert.equal(big.lines[11], 3000);
});

test('overrides change treatment; items from the books get sensible defaults', () => {
  const lines = [
    { id: 'l1', date: '2026-07-10', status: 'reviewed', amount_cents: 1000, description: 'Payment from PayPal Zettle', allocation: { splits: [{ category_code: '4010', amount_cents: 1000 }] } },
    { id: 'l2', date: '2026-08-21', status: 'reviewed', amount_cents: 69911, description: 'Deposit - ACH Paid From Stripe Transfer', allocation: { splits: [{ category_code: '4990', amount_cents: 69911 }] } },
    { id: 'l3', date: '2026-09-01', status: 'reviewed', amount_cents: 1075, description: 'Shopify order', extra: { shopify: { ship_state: null, tax_cents: 75 } },
      allocation: { splits: [{ category_code: '4010', amount_cents: 1000 }, { category_code: '2100', amount_cents: 75 }] } },
    { id: 'l4', date: '2026-09-05', status: 'reviewed', amount_cents: 5029, description: 'Shopify order OK', extra: { shopify: { ship_state: 'OK', tax_cents: 0 } }, allocation: { splits: [{ category_code: '4020', amount_cents: 5029 }] } },
  ];
  const orders = [{ id: 'o1', order: '#1038', date: '2026-08-31', total_cents: 12000, tax_cents: 0, ship_state: 'FL', paid_by: 'cash' }];
  const items = salesItems({ lines, orders, period: '2026-Q3' });
  const by = Object.fromEntries(items.map((i) => [i.key, i]));
  assert.equal(by['l1:0'].default, 'taxable_included');
  assert.equal(by['l2:0'].default, 'not_sales');
  assert.equal(by['l2:0'].review, true); // a Stripe deposit filed as "other income" gets a second look
  assert.equal(by['l3:0'].default, 'taxable_collected');
  assert.equal(by['l3:0'].tax_cents, 75);
  assert.equal(by['l4:0'].default, 'exempt');
  assert.equal(by['order:o1'].default, 'taxable_not_collected');
  const ret = computeReturn({ period: '2026-Q3', items, opts: { overrides: { 'l2:0': 'taxable_included' } } });
  assert.equal(ret.groups.taxable_included.length, 2);
  assert.equal(ret.lines.A2, 5029);
});
