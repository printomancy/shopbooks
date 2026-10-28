import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payeeKey, ruleMatches, buildHistory, fromHistory, findTransfers, computeSuggestions } from '../app/js/ledger/suggest.js';

const accts = {
  chk: { id: 'chk', name: 'Checking', kind: 'bank' },
  pp: { id: 'pp', name: 'PayPal', kind: 'platform' },
  card: { id: 'card', name: 'Card', kind: 'credit_card' },
};
const L = (id, account_id, date, amount_cents, description, extra = {}) => ({ id, account_id, date, amount_cents, description, status: 'unreviewed', ...extra });
const reviewed = (code, extra = {}) => ({ status: 'reviewed', allocation: { splits: [{ category_code: code, member: null }] }, ...extra });

test('payee keys ignore dates, card numbers and ids', () => {
  assert.equal(
    payeeKey('POS Debit- Business Debit Card 9235 09-01-26 My Mini Factory Lt London'),
    payeeKey('POS Debit- Business Debit Card 9235 03-02-26 My Mini Factory Lt London')
  );
  assert.equal(payeeKey('Amazon Mark* 5324J Amazon.Com/MA WA'), payeeKey('Amazon Mark* 511V9 Amazon.Com/MA WA'));
});

test('rules match on text, direction and account', () => {
  const r = { match: { text: 'whatnot inc', direction: 'in' }, action: { category_code: '4050' } };
  assert.ok(ruleMatches(r, L('a', 'chk', '2026-09-04', 5713, 'Deposit - RTP Paid From Whatnot Inc.')));
  assert.ok(!ruleMatches(r, L('b', 'chk', '2026-09-04', -5713, 'Paid To Whatnot Inc.')));
  assert.ok(!ruleMatches({ match: {}, action: {} }, L('c', 'chk', '2026-09-04', 1, 'x')));
});

test('history suggests what the user chose before, only when consistent', () => {
  const past = [
    L('1', 'chk', '2026-01-01', -1000, 'POS Debit- Business Debit Card 9235 01-01-26 My Mini Factory Lt London', reviewed('6055')),
    L('2', 'chk', '2026-02-01', -1000, 'POS Debit- Business Debit Card 9235 02-01-26 My Mini Factory Lt London', reviewed('6055')),
    L('3', 'chk', '2026-03-01', -1000, 'POS Debit- Business Debit Card 9235 03-01-26 My Mini Factory Lt London', reviewed('6055')),
  ];
  const h = buildHistory(past);
  const s = fromHistory(h, L('n', 'chk', '2026-10-01', -1000, 'POS Debit- Business Debit Card 9235 10-01-26 My Mini Factory Lt London'));
  assert.equal(s.category_code, '6055');
  const mixed = buildHistory([...past, L('4', 'chk', '2026-04-01', -1000, 'POS Debit 04-01-26 My Mini Factory Lt London', reviewed('6050')), L('5', 'chk', '2026-04-02', -1000, 'POS Debit 04-02-26 My Mini Factory Lt London', reviewed('6050'))]);
  assert.equal(fromHistory(mixed, past[0]), null); // 3 of 5 is not consistent enough
});

test('transfers pair across accounts, allowing a small fee', () => {
  const lines = [
    L('pp-out', 'pp', '2026-09-29', -43345, 'Money Transfer to NAVY FEDERAL CREDIT UNION'),
    L('chk-in', 'chk', '2026-09-29', 42695, 'Deposit - RTP Paid From Paypal'),
    L('card-pay', 'card', '2026-10-22', 50000, 'PAYMENT THANK YOU'),
    L('chk-pay', 'chk', '2026-10-21', -50000, 'Paid To - Capital One Online Pmt'),
    L('noise', 'chk', '2026-10-21', 1200, 'Deposit'),
  ];
  const t = findTransfers(lines, accts);
  assert.equal(t.get('pp-out').pair, 'chk-in');
  assert.equal(t.get('pp-out').category_code, '9030');
  assert.equal(t.get('pp-out').fee_cents, 650);
  assert.equal(t.get('chk-pay').pair, 'card-pay');
  assert.equal(t.get('chk-pay').category_code, '9010');
  assert.ok(!t.has('noise'));
});

test('rules beat transfers beat history; auto rules are flagged', () => {
  const lines = [
    L('w', 'chk', '2026-09-04', 5713, 'Deposit - RTP Paid From Whatnot Inc.'),
    L('x', 'chk', '2026-09-05', -2000, 'Some shop', { suggestion: { category_code: '6900', reason: 'Xero had this' } }),
  ];
  const rules = [{ id: 'r1', name: 'Whatnot payouts', match: { text: 'whatnot inc', direction: 'in' }, action: { category_code: '4050' }, auto: true }];
  const out = computeSuggestions(lines, rules, accts);
  const w = out.find((o) => o.id === 'w');
  assert.equal(w.suggestion.category_code, '4050');
  assert.equal(w.auto, true);
  assert.ok(!out.find((o) => o.id === 'x')); // import suggestion kept, nothing to change
});

test('a cash-box deposit (already approved) pairs with the bank cash deposit', () => {
  const accts2 = { ...accts, cash: { id: 'cash', name: 'Cash box', kind: 'cash' } };
  const lines = [
    { id: 'box', account_id: 'cash', date: '2026-11-16', amount_cents: -84000, description: 'Jacksonville Fair: cash box deposit to Business checking', status: 'reviewed', allocation: { splits: [{ category_code: '9020', amount_cents: -84000 }] } },
    { id: 'bank', account_id: 'chk', date: '2026-11-17', amount_cents: 84000, description: 'Deposit 11-16-26 Fa5E Fleming Island FL', status: 'unreviewed' },
  ];
  const t = findTransfers(lines, accts2);
  assert.equal(t.get('bank').pair, 'box');
  assert.equal(t.get('bank').category_code, '9020');
  assert.ok(!t.has('box')); // already reviewed: left alone
});
