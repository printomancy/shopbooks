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
