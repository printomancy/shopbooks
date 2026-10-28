import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventLines, lineIds, cardCheck } from '../app/js/ledger/events.js';

const event = { id: 'ev1', name: 'Test Fair', start_date: '2026-11-05', end_date: '2026-11-06', county: 'Duval', state_rate_bp: 600, surtax_bp: 150, opening_float_cents: 20000 };
const days = [
  { id: 'd1', date: '2026-11-05', closing_cash_cents: 45000, paypal_cents: 10000, cash_paid_out_cents: 500, paid_out_note: 'ice', cash_removed_cents: 15000 },
  { id: 'd2', date: '2026-11-06', closing_cash_cents: 50000, paypal_cents: 4000 },
  { id: 'd3', date: '2026-11-07' }, // not counted yet: nothing posted
];
const deposits = [{ id: 'dep1', date: '2026-11-07', amount_cents: 65000, account: 'Business checking' }];

test('event log becomes cash-box lines with stable ids', () => {
  const out = eventLines({ event, days, deposits, cashAccountId: 'acct_cash', companyId: 'c' });
  const by = Object.fromEntries(out.map((r) => [r.id, r.data]));
  assert.equal(by[lineIds.cash('d1')].amount_cents, 25500);       // 450 - 200 + 5
  assert.equal(by[lineIds.cash('d2')].amount_cents, 20000);       // opens at 300, closes 500
  assert.equal(by[lineIds.cash('d1')].allocation.splits[0].category_code, '4000');
  assert.equal(by[lineIds.paidOut('d1')].amount_cents, -500);
  assert.equal(by[lineIds.paidOut('d1')].status, 'unreviewed');
  assert.equal(by[lineIds.deposit('dep1')].amount_cents, -65000);
  assert.equal(by[lineIds.deposit('dep1')].allocation.splits[0].category_code, '9020');
  assert.ok(!by[lineIds.cash('d3')]);
  assert.equal(by[lineIds.float('ev1')].amount_cents, 20000);
  // float 200 + sales 255 + 200 - paid out 5 - deposit 650 = 0: everything that went in came back out
  assert.equal(out.reduce((t, r) => t + r.data.amount_cents, 0), 0);
});

test('PayPal check compares the log to the PayPal account', () => {
  const lines = [
    { account_id: 'pp', date: '2026-11-05', amount_cents: 9500, allocation: { splits: [{ category_code: '4010' }] } },
    { account_id: 'pp', date: '2026-11-06', amount_cents: 4000, allocation: { splits: [{ category_code: '4010' }] } },
    { account_id: 'pp', date: '2026-11-09', amount_cents: 999, allocation: { splits: [{ category_code: '4010' }] } }, // after the event
  ];
  const r = cardCheck({ event, days, lines, accountsById: { pp: { institution: 'PayPal' } } });
  assert.deepEqual(r, { logged: 14000, inBooks: 13500, difference: -500 });
});
