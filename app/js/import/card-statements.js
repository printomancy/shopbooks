// Credit card statement parsers. Amounts come back from the business's point of
// view: a purchase, fee or interest is negative; a payment or credit is positive.
// Each parser checks its lines against the statement's own balance summary.

const money = (s) => {
  const t = String(s).trim();
  const credit = /CR$/i.test(t) || /^CR/i.test(t) || t.startsWith('-');
  const n = Math.round(Number(t.replace(/CR|[$,+\-\s]/gi, '')) * 100);
  return credit ? -n : n; // statement sign: charges positive, credits negative
};

// ---------- American Express (plain text extraction) ----------
export function parseAmexStatement(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const closing = (text.match(/Closing Date (\d{2})\/(\d{2})\/(\d{2})/) || []).slice(1);
  if (!closing.length) throw new Error('Not an American Express statement: no closing date.');
  const out = [];
  let cur = null;
  const DATE = /^(\d{2})\/(\d{2})\/(\d{2})\*?\s+(.*)$/;
  const AMT = /(-?\$[\d,]+\.\d{2}|CR\$[\d,]+\.\d{2})$/;
  for (const l of lines) {
    const d = l.match(DATE);
    if (d) {
      if (cur && cur.amount === null) cur = null; // an incomplete row (summary text) - drop it
      cur = { date: `20${d[3]}-${d[1]}-${d[2]}`, desc: d[4].replace(AMT, '').trim(), amount: null };
      const a = d[4].match(AMT);
      if (a) { cur.amount = money(a[1]); out.push(cur); cur = null; }
      continue;
    }
    if (!cur) continue;
    const a = l.match(/^(-?\$[\d,]+\.\d{2})$/);
    if (a) { cur.amount = money(a[1]); out.push(cur); cur = null; continue; }
    if (l && !/^p\. \d/.test(l) && cur.desc.length < 120) cur.desc += ` ${l}`;
  }
  // Credits to points ("PAY WITH POINTS CREDIT") are listed twice by AmEx: once as the credit and
  // again as the reversed charge line underneath; keep both - they net against the original charge.
  const sumIdx = lines.indexOf('Account Summary');
  const vals = [];
  for (let i = sumIdx + 1; i < lines.length && vals.length < 7; i++) {
    const m = lines[i].match(/^([+\-]?(?:CR)?\$[\d,]+\.\d{2})$/);
    if (m) vals.push(money(m[1].replace('+', '')));
  }
  const [previous, , , , , , total] = vals;
  const rows = out.map((r) => ({ date: r.date, amount_cents: -r.amount, description: r.desc.replace(/\s+/g, ' ').trim() }));
  const check = previous !== undefined && total !== undefined ? previous - rows.reduce((t, r) => t + r.amount_cents, 0) === total : null;
  return { issuer: 'American Express', closing_date: `20${closing[2]}-${closing[0]}-${closing[1]}`, previous_balance_cents: previous ?? null, new_balance_cents: total ?? null, balanced: check, rows };
}

// ---------- U.S. Bank (layout text extraction) ----------
export function parseUsBankStatement(text) {
  const per = text.match(/(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/) || text.match(/Open Date:\s*(\d{2})\/(\d{2})\/(\d{4})\s+Closing Date:\s*(\d{2})\/(\d{2})\/(\d{4})/);
  if (!per) throw new Error('Not a U.S. Bank statement: no statement period.');
  const [, om, , oy, cm, cd, cy] = per;
  const yearFor = (mm) => (oy !== cy && Number(mm) >= Number(om) ? oy : cy);
  const grab = (label) => {
    const m = text.match(new RegExp(`${label}\\s+[+\\-=]?\\s*(\\$[\\d,]+\\.\\d{2}(?:CR)?)`));
    return m ? money(m[1]) : null;
  };
  const previous = grab('Previous Balance');
  const newBal = grab('New Balance\\s+=') ?? grab('New Balance');
  const rows = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s{1,6}(\d{2})\/(\d{2})\s+(?:(\d{2})\/(\d{2})\s+)?(?:(\d{4})\s+)?(.+?)\s{2,}(\$[\d,]+\.\d{2}(?:CR)?)\s*(.*)$/);
    if (!m || /^TOTAL|Total for Account/i.test(m[6].trim())) continue;
    const [, pm, pd, tm, td, ref, desc, amt] = m;
    const date = `${yearFor(tm || pm)}-${tm || pm}-${td || pd}`;
    rows.push({ date, amount_cents: -money(amt), description: desc.replace(/\s+/g, ' ').trim(), ref: ref || null });
  }
  const check = previous !== null && newBal !== null ? previous - rows.reduce((t, r) => t + r.amount_cents, 0) === newBal : null;
  return { issuer: 'U.S. Bank', closing_date: `${cy}-${cm}-${cd}`, previous_balance_cents: previous, new_balance_cents: newBal, balanced: check, rows };
}
