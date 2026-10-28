import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, fmt, splitTaxIncluded, summarizeEvent } from '../app/js/money.js';

test('parseMoney', () => {
  assert.equal(parseMoney('5'), 500);
  assert.equal(parseMoney('$1,234.5'), 123450);
  assert.equal(parseMoney('0.07'), 7);
  assert.equal(parseMoney('2.345'), 235);
  assert.equal(parseMoney(''), null);
  assert.ok(Number.isNaN(parseMoney('abc')));
  assert.equal(parseMoney('-3.10'), -310);
});

test('fmt', () => {
  assert.equal(fmt(123450), '$1,234.50');
  assert.equal(fmt(-5), '-$0.05');
  assert.equal(fmt(null), '—');
});

test('tax-included split matches the handoff example', () => {
  assert.deepEqual(splitTaxIncluded(500, 750), { taxable: 465, tax: 35 });
  assert.deepEqual(splitTaxIncluded(10750, 750), { taxable: 10000, tax: 750 });
});

test('event summary: float, carry-over, deposits', () => {
  const event = { opening_float_cents: 20000, state_rate_bp: 600, surtax_bp: 150 };
  const days = [
    // day 2 listed first on purpose: must sort by date
    { date: '2026-11-06', closing_cash_cents: 50000, paypal_cents: 4000, cash_removed_cents: 0 },
    { date: '2026-11-05', closing_cash_cents: 45000, paypal_cents: 10000, cash_removed_cents: 15000, cash_paid_out_cents: 500 },
  ];
  const s = summarizeEvent(event, days, [{ amount_cents: 50000 }]);
  // Day 1: opening 200.00, closing 450.00, paid out 5.00 -> cash sales 255.00
  assert.equal(s.days[0].cashSales, 25500);
  // Day 2 opens with 450 - 150 removed = 300.00, closes 500.00 -> 200.00
  assert.equal(s.days[1].opening, 30000);
  assert.equal(s.days[1].cashSales, 20000);
  assert.equal(s.totals.cashSales, 45500);
  assert.equal(s.totals.cardSales, 14000);
  assert.equal(s.totals.gross, 59500);
  assert.equal(s.totals.taxable + s.totals.tax, 59500);
  // cash to account for: 200 float + 455 sales - 5 paid out = 650; deposited 500 -> 150 not deposited
  assert.equal(s.cash.toAccountFor, 65000);
  assert.equal(s.cash.notDeposited, 15000);
  assert.equal(s.cash.floatPortionOfDeposits, 20000);
});

test('open day (no closing count) does not count cash sales', () => {
  const s = summarizeEvent({ opening_float_cents: 10000, state_rate_bp: 600, surtax_bp: 150 }, [{ date: '2026-11-05', paypal_cents: 2500 }], []);
  assert.equal(s.days[0].cashSales, null);
  assert.equal(s.totals.daysOpen, 1);
  assert.equal(s.totals.gross, 2500);
});
