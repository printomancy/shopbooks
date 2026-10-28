// Stripe balance activity -> statement-line rows for a "Stripe" platform account.
// Works with balance_transaction objects from the Stripe API (or an AI assistant
// using a Stripe connector) and with the "Balance change from activity" CSV export.
//
// Each sale becomes two lines that add up to what Stripe kept: the full sale
// (income) and Stripe's fee (expense). Payouts to the bank are their own lines
// and get matched to the bank deposit as transfers.

const iso = (unixOrText) =>
  typeof unixOrText === 'number' ? new Date(unixOrText * 1000).toISOString().slice(0, 10) : String(unixOrText).slice(0, 10);

// charges: optional map of charge/payment id -> { name, email, description, state } for nicer descriptions
export function stripeRowsFromApi(balanceTransactions, charges = {}) {
  const rows = [];
  for (const t of balanceTransactions) {
    if (t.status && t.status !== 'available' && t.status !== 'pending') continue;
    const date = iso(t.created);
    const who = charges[t.source] || {};
    const label = [who.name, who.description || t.description].filter(Boolean).join(' · ');
    if (t.reporting_category === 'charge' || t.type === 'charge' || t.type === 'payment') {
      rows.push({
        date, amount_cents: t.amount, description: `Stripe sale${label ? ' · ' + label : ''}`, source_ref: t.id,
        extra: { stripe: { kind: 'sale', source: t.source, customer_state: who.state || null, invoice: /invoice/i.test(t.description || who.description || '') } },
        suggestion: { category_code: /invoice/i.test(t.description || who.description || '') ? '4030' : '4020', member: null, reason: 'Stripe sale' },
      });
      if (t.fee) rows.push({ date, amount_cents: -t.fee, description: `Stripe processing fee${who.name ? ' · ' + who.name : ''}`, source_ref: `${t.id}:fee`, suggestion: { category_code: '6040', member: null, reason: 'Stripe fee' } });
    } else if (t.reporting_category === 'refund' || t.type === 'refund') {
      rows.push({ date, amount_cents: t.amount, description: `Stripe refund${label ? ' · ' + label : ''}`, source_ref: t.id, suggestion: { category_code: '4900', member: null, reason: 'Stripe refund' } });
      if (t.fee) rows.push({ date, amount_cents: -t.fee, description: 'Stripe refund fee', source_ref: `${t.id}:fee`, suggestion: { category_code: '6040', member: null, reason: 'Stripe fee' } });
    } else if (t.type === 'payout' || t.reporting_category === 'payout') {
      rows.push({ date, amount_cents: t.amount, description: 'Stripe payout to bank', source_ref: t.id, extra: { stripe: { kind: 'payout', payout: t.source, arrival: t.arrival_date ? iso(t.arrival_date) : null } }, suggestion: { category_code: '9030', member: null, reason: 'Stripe payout' } });
    } else if (t.type === 'stripe_fee' || t.reporting_category === 'fee') {
      rows.push({ date, amount_cents: t.amount, description: `Stripe fee · ${t.description || 'billing'}`, source_ref: t.id, suggestion: { category_code: '6040', member: null, reason: 'Stripe fee' } });
    } else {
      rows.push({ date, amount_cents: t.amount, description: `Stripe ${t.type}${t.description ? ' · ' + t.description : ''}`, source_ref: t.id });
      if (t.fee) rows.push({ date, amount_cents: -t.fee, description: `Stripe fee · ${t.type}`, source_ref: `${t.id}:fee`, suggestion: { category_code: '6040', member: null, reason: 'Stripe fee' } });
    }
  }
  return rows;
}

// CSV export ("Balance change from activity" / "Balance history"): columns include
// id, Type, Source, Amount, Fee, Net, Created (UTC), Description, Reporting Category
export function stripeRowsFromCsv(table) {
  const [h, ...body] = table;
  const col = (re) => h.findIndex((x) => re.test(x.trim()));
  const c = {
    id: col(/^(id|balance transaction id)$/i), type: col(/^type$/i), source: col(/^source$/i), amount: col(/^(gross|amount)$/i),
    fee: col(/^fee$/i), created: col(/^created/i), desc: col(/^description$/i), cat: col(/^reporting.?category$/i),
  };
  const money = (v) => Math.round(Number(String(v || '0').replace(/[$,]/g, '')) * 100);
  const txns = body.filter((r) => r[c.id]).map((r) => ({
    id: r[c.id], type: (r[c.type] || '').toLowerCase(), reporting_category: (r[c.cat] || r[c.type] || '').toLowerCase(),
    source: r[c.source], amount: money(r[c.amount]), fee: c.fee >= 0 ? money(r[c.fee]) : 0, created: r[c.created], description: r[c.desc] || null, status: 'available',
  }));
  return stripeRowsFromApi(txns);
}
