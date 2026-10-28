// Small RFC 4180 CSV parser (quotes, escaped quotes, CRLF, BOM) and helpers
// for mapping columns to date / amount / description.

export function parseCsv(text) {
  const s = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((x) => x !== '')) rows.push(row); }
  return rows;
}

// Accepts 2026-03-01, 03/01/2026, 3/1/26, Mar 1, 2026
export function parseDate(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const d = Date.parse(s);
  if (!Number.isNaN(d)) return new Date(d).toISOString().slice(0, 10);
  return null;
}

export function parseAmount(v) {
  let s = String(v ?? '').trim();
  if (!s) return null;
  const paren = /^\(.*\)$/.test(s);
  s = s.replace(/[()$,\s]/g, '');
  if (!/^[-+]?\d*\.?\d+$/.test(s)) return null;
  const n = Math.round(Number(s) * 100);
  return paren ? -Math.abs(n) : n;
}

// Guess which columns hold what, from header names.
export function guessMapping(header) {
  const h = header.map((x) => x.toLowerCase().trim());
  const find = (...re) => h.findIndex((x) => re.some((r) => r.test(x)));
  return {
    date: find(/^(transaction |posted |post )?date$/, /date/),
    description: find(/description|memo|payee|merchant|name|details/),
    amount: find(/^amount$/, /^net$/, /amount/),
    debit: find(/debit|withdrawal|money out/),
    credit: find(/credit|deposit|money in/),
    balance: find(/balance/),
    ref: find(/transaction id|reference|ref/),
  };
}

// mapping: { date, description, amount?, debit?, credit?, balance?, ref?, flip? }
export function rowsFromCsv(table, mapping) {
  const [, ...body] = table;
  const out = [];
  for (const r of body) {
    const date = parseDate(r[mapping.date]);
    if (!date) continue;
    let amount = null;
    if (mapping.amount >= 0) amount = parseAmount(r[mapping.amount]);
    else {
      const dr = mapping.debit >= 0 ? parseAmount(r[mapping.debit]) : null;
      const cr = mapping.credit >= 0 ? parseAmount(r[mapping.credit]) : null;
      if (dr !== null || cr !== null) amount = (cr ? Math.abs(cr) : 0) - (dr ? Math.abs(dr) : 0);
    }
    if (amount === null) continue;
    if (mapping.flip) amount = -amount;
    out.push({
      date,
      amount_cents: amount,
      description: (r[mapping.description] || '').trim(),
      balance_cents: mapping.balance >= 0 ? parseAmount(r[mapping.balance]) : null,
      source_ref: mapping.ref >= 0 ? (r[mapping.ref] || '').trim() || null : null,
    });
  }
  return out;
}
