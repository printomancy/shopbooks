// Florida DR-15 (Sales and Use Tax Return) plug-in.
// Form revision R. 01/25 (effective 02/25): https://floridarevenue.com/rules/pdf/DR-15.pdf
// Pure functions: given the period's sales items and purchases, produce every DR-15 line.
// Output is a worksheet for filling in eFile; it is not the official return.

export const FORM = {
  id: 'FL-DR15',
  name: 'Florida Sales and Use Tax Return (DR-15)',
  revision: 'R. 01/25',
  url: 'https://floridarevenue.com/rules/pdf/DR-15.pdf',
  efile: 'https://floridarevenue.com/taxes/eservices',
  phone: '800-352-3671',
};

// How a sale is treated on the return.
export const TREATMENTS = {
  taxable_included: { label: 'Taxable, tax included in the price', short: 'Tax included' },
  taxable_collected: { label: 'Taxable, tax charged on top', short: 'Tax charged' },
  taxable_not_collected: { label: 'Taxable, no tax charged (you owe it)', short: 'Tax owed' },
  exempt: { label: 'Exempt (shipped out of state or resale)', short: 'Exempt' },
  marketplace: { label: 'Marketplace collected the tax (left off the return)', short: 'Marketplace' },
  not_sales: { label: 'Not a sale', short: 'Not a sale' },
};

const MARKETPLACE = new Set(['4040', '4050', '4060']);
const SALES = new Set(['4000', '4010', '4020', '4030', '4100', '4900']);

// ---------- periods ----------

export function quarterOf(iso) {
  const [y, m] = iso.split('-').map(Number);
  return `${y}-Q${Math.ceil(m / 3)}`;
}
export function periodInfo(period) {
  const [y, q] = period.split('-Q').map(Number);
  const startM = (q - 1) * 3 + 1;
  const pad = (n) => String(n).padStart(2, '0');
  const end = new Date(Date.UTC(y, startM + 2, 0)).toISOString().slice(0, 10);
  const dueY = q === 4 ? y + 1 : y, dueM = q === 4 ? 1 : startM + 3;
  return {
    period, label: `Q${q} ${y}`, start: `${y}-${pad(startM)}-01`, end,
    due: `${dueY}-${pad(dueM)}-01`, lateAfter: `${dueY}-${pad(dueM)}-20`,
  };
}

// ---------- building items from the books ----------

// lines: statement lines {id, account_id, date, amount_cents, description, allocation, extra...}
// orders: orders paid outside the ledger {id, date, total_cents, tax_cents, ship_state, paid_by, matched_line_id}
// accounts: {id: {kind}}
export function salesItems({ lines, orders = [], period, homeState = 'FL' }) {
  const p = periodInfo(period);
  const inP = (d) => d >= p.start && d <= p.end;
  const items = [];
  for (const l of lines) {
    if (!inP(l.date) || l.status === 'excluded') continue;
    // Unreviewed lines count using their suggestion, so the quarter's picture is complete; they're marked.
    const alloc = l.status === 'reviewed' ? l.allocation
      : l.suggestion ? { splits: l.suggestion.splits || [{ category_code: l.suggestion.category_code, amount_cents: l.amount_cents }] } : null;
    if (!alloc) continue;
    const unreviewed = l.status !== 'reviewed';
    const splits = alloc.splits;
    const taxPart = splits.filter((s) => s.category_code === '2100').reduce((t, s) => t + s.amount_cents, 0);
    splits.forEach((s, i) => {
      const code = s.category_code;
      if (!SALES.has(code) && !MARKETPLACE.has(code) && !['4950', '4990'].includes(code)) return;
      const shop = l.shopify || (l.extra && l.extra.shopify) || null;
      let t;
      if (MARKETPLACE.has(code)) t = 'marketplace';
      else if (['4950', '4990'].includes(code)) t = 'not_sales';
      else if (shop) t = shop.ship_state && shop.ship_state !== homeState ? 'exempt' : taxPart ? 'taxable_collected' : 'taxable_not_collected';
      else t = 'taxable_included';
      const review = (['4020', '4030', '4100'].includes(code) && !shop) || (t === 'not_sales' && /stripe|paypal|square|venmo|cash app/i.test(l.description));
      items.push({ key: `${l.id}:${i}`, line_id: l.id, date: l.date, account_id: l.account_id, description: l.description, category_code: code,
        amount_cents: s.amount_cents, tax_cents: t === 'taxable_collected' ? taxPart : 0, ship_state: shop ? shop.ship_state : null, default: t, review, unreviewed });
    });
  }
  for (const o of orders) {
    if (!inP(o.date) || o.matched_line_id) continue;
    const t = o.ship_state && o.ship_state !== homeState ? 'exempt' : o.tax_cents ? 'taxable_collected' : 'taxable_not_collected';
    items.push({ key: `order:${o.id}`, order_id: o.id, date: o.date, description: `${o.order || 'Order'} · ${o.customer || ''} · paid ${o.paid_by || 'outside the books'}`,
      category_code: '4020', amount_cents: o.total_cents - (o.tax_cents || 0), tax_cents: o.tax_cents || 0, ship_state: o.ship_state, default: t, review: false });
  }
  return items;
}

// Purchases that may owe use tax: business-use items, not resold, bought without Florida tax.
const USE_TAX_CATS = new Set(['6000', '6010', '6090', '6900', '1500', '6020']);
export function useTaxCandidates({ lines, period }) {
  const p = periodInfo(period);
  return lines.filter((l) => l.date >= p.start && l.date <= p.end && l.status === 'reviewed' && l.allocation && l.amount_cents < 0)
    .flatMap((l) => l.allocation.splits.map((s, i) => ({ key: `${l.id}:${i}`, line_id: l.id, date: l.date, description: l.description, category_code: s.category_code, amount_cents: -s.amount_cents, flagged: !!s.use_tax })))
    .filter((x) => x.flagged || USE_TAX_CATS.has(x.category_code));
}

// ---------- the return ----------

const r2 = (x) => Math.round(x);

// opts: { stateBp, surtaxBp, overrides: {key: treatment}, useTax: {key: bool}, useTaxManualCents,
//         lawfulDeductionsCents, creditMemoCents, filedOn, electronic, interestCents }
export function computeReturn({ period, items, useTaxItems = [], opts = {} }) {
  const p = periodInfo(period);
  const stateBp = opts.stateBp ?? 600, surtaxBp = opts.surtaxBp ?? 150, rateBp = stateBp + surtaxBp;
  const groups = { taxable_included: [], taxable_collected: [], taxable_not_collected: [], exempt: [], marketplace: [], not_sales: [] };
  for (const it of items) {
    const t = (opts.overrides && opts.overrides[it.key]) || it.default;
    groups[t].push({ ...it, treatment: t });
  }
  const sum = (arr, f = (x) => x.amount_cents) => arr.reduce((t, x) => t + f(x), 0);

  const incGross = sum(groups.taxable_included);
  const incTaxable = r2((incGross * 10000) / (10000 + rateBp));
  const inc = { gross: incGross, taxable: incTaxable, tax: incGross - incTaxable };
  const col = { taxable: sum(groups.taxable_collected), tax: sum(groups.taxable_collected, (x) => x.tax_cents) };
  const nc = { taxable: sum(groups.taxable_not_collected) };
  nc.tax = r2((nc.taxable * rateBp) / 10000);
  const exempt = sum(groups.exempt);

  const A = {
    taxable: inc.taxable + col.taxable + nc.taxable,
    exempt,
    tax: inc.tax + col.tax + nc.tax,
  };
  A.gross = A.taxable + A.exempt;

  const useFlagged = useTaxItems.filter((u) => (opts.useTax && u.key in opts.useTax ? opts.useTax[u.key] : u.flagged));
  const B = { taxable: sum(useFlagged) + (opts.useTaxManualCents || 0) };
  B.tax = r2((B.taxable * rateBp) / 10000);
  B.gross = B.taxable; B.exempt = 0;

  const line5 = A.tax + B.tax;
  const line6 = opts.lawfulDeductionsCents || 0;
  const line7 = line5 - line6;
  const line8 = opts.creditMemoCents || 0;
  const line9 = 0; // estimated tax applies only to $200,000+ annual filers
  const line10 = line7 - line8 + line9;
  const filedOn = opts.filedOn || null;
  const onTime = filedOn ? filedOn <= p.lateAfter : null;
  const line11 = onTime && opts.electronic !== false ? Math.min(3000, r2(Math.min(Math.max(line7, 0), 120000) * 0.025)) : 0;
  const late = lateMonths(p.lateAfter, filedOn);
  const line12 = late ? Math.max(5000, Math.min(r2(line10 * 0.1 * late), r2(line10 * 0.5))) : 0;
  const line13 = late ? opts.interestCents || 0 : 0;
  const line14 = line10 - line11 + line12 + line13;
  const surtax = rateBp ? r2((line5 * surtaxBp) / rateBp) : 0;

  return {
    period: p, rateBp, stateBp, surtaxBp, groups, parts: { inc, col, nc, exempt },
    lines: {
      A1: A.gross, A2: A.exempt, A3: A.taxable, A4: A.tax,
      B1: B.gross, B2: 0, B3: B.taxable, B4: B.tax,
      5: line5, 6: line6, 7: line7, 8: line8, 9: line9, 10: line10, 11: line11, 12: line12, 13: line13, 14: line14,
      '15a': 0, '15b': 0, '15c': 0, '15d': surtax,
    },
    late, onTime,
    reviewCount: items.filter((i) => i.review && !(opts.overrides && opts.overrides[i.key])).length,
    unreviewedCount: items.filter((i) => i.unreviewed && i.default !== 'marketplace').length,
  };
}

// Florida: 10% of the tax due for each month or part of a month late, up to 50%, minimum $50.
export function lateMonths(lateAfter, filedOn) {
  if (!filedOn || filedOn <= lateAfter) return 0;
  const [ly, lm, ld] = lateAfter.split('-').map(Number);
  const [fy, fm, fd] = filedOn.split('-').map(Number);
  let months = (fy - ly) * 12 + (fm - lm);
  if (fd > ld) months += 1;
  return Math.max(1, Math.min(5, months));
}

// ---------- eFile walkthrough ----------
// The order eFile asks for things; wording on the DOR screens may differ slightly.
export function efileSteps(ret, { certificate } = {}) {
  const f = (c) => (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const L = ret.lines;
  return [
    { title: 'Sign in and pick the period', body: `Go to floridarevenue.com, then eServices → File and Pay → Sales and Use Tax. Sign in${certificate ? ` with certificate number ending ${certificate}` : ''} and choose the return for ${ret.period.label} (${ret.period.start} to ${ret.period.end}).` },
    { title: 'Sales and services (row A)', body: `Gross sales: ${f(L.A1)}. Exempt sales: ${f(L.A2)}. Taxable amount: ${f(L.A3)}. Tax due: ${f(L.A4)}.` },
    { title: 'Taxable purchases (row B, use tax)', body: `Taxable purchases: ${f(L.B3)}. Tax due: ${f(L.B4)}. Leave commercial rentals, transient rentals and vending (rows C–E) at 0.` },
    { title: 'Discretionary sales surtax (line 15)', body: `Lines 15(a)–(c): 0. All of your sales were in counties with the same 1.5% surtax as your registered county. Line 15(d), surtax included in the tax above: ${f(L['15d'])}.` },
    { title: 'Deductions and estimated tax (lines 6–9)', body: `Lawful deductions: ${f(L[6])}. DOR credit memo: ${f(L[8])}. Estimated tax due (line 9): 0.00. That line is only for businesses that paid $200,000 or more last year.` },
    { title: 'Check the totals eFile calculates', body: `Total tax due (line 5) should read ${f(L[5])}. ${L[11] ? `Collection allowance ${f(L[11])} if filed and paid by ${ret.period.lateAfter}.` : 'No collection allowance (it only applies when the return is filed and paid on time).'} ${ret.late ? `Late: expect penalty around ${f(L[12])} plus interest, both calculated by eFile.` : ''}` },
    { title: 'Pay', body: `Amount due with the return: ${f(L[14])}${ret.late ? ' plus the interest eFile shows' : ''}. Pay by ACH debit from NFCU Business Checking.` },
    { title: 'Save the confirmation', body: 'Copy the confirmation number and the amount paid into "Record the filing" below. That locks this period so the numbers can\'t change by accident.' },
  ];
}
