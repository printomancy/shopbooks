import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseDate, parseAmount, guessMapping, rowsFromCsv } from '../app/js/import/csv.js';
import { buildStatementLines } from '../app/js/import/common.js';
import { parseNfcuStatement } from '../app/js/import/nfcu-statement.js';

test('csv parsing handles quotes, commas and CRLF', () => {
  const t = parseCsv('﻿Date,Description,Amount\r\n01/02/2026,"Coffee, large",-4.50\r\n"2026-01-03","He said ""hi""",10\r\n');
  assert.deepEqual(t[1], ['01/02/2026', 'Coffee, large', '-4.50']);
  assert.equal(t[2][1], 'He said "hi"');
});

test('dates and amounts', () => {
  assert.equal(parseDate('3/1/26'), '2026-03-01');
  assert.equal(parseDate('2026-11-05'), '2026-11-05');
  assert.equal(parseAmount('($1,234.50)'), -123450);
  assert.equal(parseAmount(''), null);
});

test('debit/credit columns and sign flip', () => {
  const t = parseCsv('Transaction Date,Description,Debit,Credit\n2026-10-20,BAMBU LAB,129.99,\n2026-10-22,PAYMENT,,500.00\n');
  const m = guessMapping(t[0]);
  const rows = rowsFromCsv(t, { ...m, amount: -1 });
  assert.equal(rows[0].amount_cents, -12999);
  assert.equal(rows[1].amount_cents, 50000);
});

test('identical rows in one file are both kept, and ids are stable', async () => {
  const rows = [
    { date: '2026-03-09', amount_cents: -100000, description: 'Transfer' },
    { date: '2026-03-09', amount_cents: -100000, description: 'Transfer' },
  ];
  const a = await buildStatementLines(rows, { accountId: 'acct', companyId: 'c', source: 'csv', importId: 'i1' });
  const b = await buildStatementLines(rows, { accountId: 'acct', companyId: 'c', source: 'csv', importId: 'i2' });
  assert.notEqual(a[0].id, a[1].id);
  assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id));
});

test('NFCU statement layout parses and checks running balances', () => {
  const text = [
    'Statement Period',
    '09/01/26 - 09/30/26',
    'Business Checking - 0000001234',
    'Date     Transaction Detail                                  Amount($)              Balance($)',
    '09-01    Beginning Balance                                                             321.40',
    '09-01    Deposit - ACH Paid From Etsy, Inc. Payout 090126    121.93                    443.33',
    '09-03    POS Debit- Business Debit Card 9235 09-02-26 Amazon Mark* 5324J',
    '         Amazon.Com/MA WA                                    155.98         -          287.35',
    '09-29    Transfer To Checking                                100.00         -          187.35',
    '         Jane Q Owner',
    '09-30    Ending Balance                                                                187.35',
  ].join('\n');
  const r = parseNfcuStatement(text);
  const a = r.accounts[0];
  assert.equal(a.mask, '1234');
  assert.equal(a.ok, true, a.problems.join('; '));
  assert.equal(a.lines.length, 3);
  assert.equal(a.lines[1].amount_cents, -15598);
  assert.match(a.lines[1].description, /Amazon\.Com\/MA WA$/);
  assert.equal(a.lines[2].description, 'Transfer To Checking Jane Q Owner');
});

import { shopifyRowsFromOrders } from '../app/js/import/shopify.js';
import { stripeRowsFromApi } from '../app/js/import/stripe.js';

test('shopify: sale + fee with tax split; manual orders kept aside and flagged', () => {
  const m = (a) => ({ shopMoney: { amount: String(a) } });
  const { rows, orders } = shopifyRowsFromOrders([
    { name: '#1029', createdAt: '2026-04-25T15:00:38Z', sourceName: 'pos', displayFinancialStatus: 'PAID', totalPriceSet: m(10.75), subtotalPriceSet: m(10), totalTaxSet: m(0.75), totalShippingPriceSet: m(0),
      transactions: [{ kind: 'SALE', status: 'SUCCESS', gateway: 'shopify_payments', processedAt: '2026-04-25T15:00:36Z', amountSet: m(10.75), fees: [{ amount: { amount: '0.38' } }] }] },
    { name: '#1037', createdAt: '2026-08-06T03:08:22Z', sourceName: 'shopify_draft_order', displayFinancialStatus: 'PAID', totalPriceSet: m(130), subtotalPriceSet: m(130), totalTaxSet: m(0), totalShippingPriceSet: m(0),
      shippingAddress: { provinceCode: 'FL' }, paymentGatewayNames: ['manual'], customer: { displayName: 'A Customer' },
      transactions: [{ kind: 'SALE', status: 'SUCCESS', gateway: 'manual', processedAt: '2026-08-06T03:08:21Z', amountSet: m(130), fees: [] }] },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].amount_cents, 1075);
  assert.deepEqual(rows[0].suggestion.splits, [{ category_code: '4010', amount_cents: 1000 }, { category_code: '2100', amount_cents: 75 }]);
  assert.equal(rows[1].amount_cents, -38);
  assert.equal(orders.length, 1);
  assert.match(orders[0].flag, /no sales tax/);
});

test('stripe: sale and fee lines add up to net; payouts are transfers', () => {
  const rows = stripeRowsFromApi([
    { id: 'txn_1', type: 'payment', reporting_category: 'charge', amount: 5660, fee: 194, net: 5466, created: 1789999418, description: 'Payment for Invoice', status: 'available' },
    { id: 'txn_2', type: 'payout', reporting_category: 'payout', amount: -5443, fee: 0, created: 1790554271, status: 'available', source: 'po_1' },
    { id: 'txn_3', type: 'stripe_fee', reporting_category: 'fee', amount: -23, fee: 0, created: 1790009846, description: 'Invoicing', status: 'available' },
  ]);
  assert.equal(rows.reduce((t, r) => t + r.amount_cents, 0), 0);
  assert.equal(rows[0].suggestion.category_code, '4030');
  assert.equal(rows.find((r) => r.source_ref === 'txn_2').suggestion.category_code, '9030');
});

import { parseAmexStatement, parseUsBankStatement } from '../app/js/import/card-statements.js';

test('amex statement: charges negative, payments positive, balances check', () => {
  const text = ['Closing Date 03/09/26 Next Closing Date 04/08/26', 'Account Summary', 'Previous Balance', 'Payments/Credits', '$100.00', '-$50.00',
    'New Standard Bal. Charges', 'New Payment Terms Charges', '+$30.00', '+$0.00', 'Fees', 'Interest Charges', '+$39.00', '+$0.00', 'Total Balance', 'Minimum Payment Due', '$119.00', '$0.00',
    '02/08/26* ONLINE PAYMENT - THANK YOU -$50.00', '02/09/26 AMAZON MARKETPLACE NA PA AMZN.COM/BILL WA', 'AMZN.COM/BILL', '$30.00', '02/10/26* RETURNED PAYMENT FEE $39.00'].join('\n');
  const r = parseAmexStatement(text);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].amount_cents, 5000);
  assert.equal(r.rows[1].amount_cents, -3000);
  assert.equal(r.balanced, true);
});

test('us bank statement: purchases, fee reversals (CR) and interest; balances check', () => {
  const text = [
    'Open Date:    09/10/2026     Closing Date:   10/08/2026',
    '                                            Previous Balance                 +           $2,950.08',
    '                                            New Balance                      =           $3,020.34',
    '   10/06   10/06            LATE FEE - PAYMENT DUE ON 10/06                                            $40.00',
    '   10/07   10/07            REVERSAL OF LATE PAYMENT FEE                                               $40.00CR',
    '   10/07   10/07            REVERSAL OF LATE PAYMENT FEE                                               $40.00CR',
    '   09/12   09/12    4230    AMAZON MARK* 5O3JQ1PG0 SEATTLE      WA                                     $40.00',
    '   10/08                    INTEREST CHARGE ON PURCHASES                                               $70.26',
    '                            TOTAL INTEREST FOR THIS PERIOD                                             $70.26',
  ].join('\n');
  const r = parseUsBankStatement(text);
  assert.equal(r.rows.length, 5);
  assert.equal(r.rows[1].amount_cents, 4000);
  assert.equal(r.rows[3].date, '2026-09-12');
  assert.equal(r.balanced, true);
});
