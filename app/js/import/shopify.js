// Shopify orders -> statement-line rows for a "Shopify payouts" platform account.
// Input: order objects from the Shopify Admin API (GraphQL shape used below), as
// fetched by an AI assistant with a Shopify connector or by a script.
//
// Only money that moved through Shopify Payments becomes ledger lines (sale, fee,
// refund). Orders paid some other way (marked paid manually, or created by a
// connected sales channel) come back as `orders` so they can be matched to the
// account where the money actually arrived, and checked for sales tax.

const cents = (v) => Math.round(Number(v || 0) * 100);
const money = (set) => cents(set && set.shopMoney ? set.shopMoney.amount : 0);
const day = (ts) => String(ts).slice(0, 10);

export function shopifyRowsFromOrders(orders, { homeState = 'FL' } = {}) {
  const rows = [];
  const other = [];
  for (const o of orders) {
    const tx = (o.transactions || []).filter((t) => t.gateway === 'shopify_payments');
    const sales = tx.filter((t) => (t.kind === 'SALE' || t.kind === 'CAPTURE') && (t.status === 'SUCCESS' || o.displayFinancialStatus === 'PAID'));
    const state = (o.shippingAddress && o.shippingAddress.provinceCode) || (o.billingAddress && o.billingAddress.provinceCode) || (o.sourceName === 'pos' ? homeState : null);
    const tax = money(o.totalTaxSet);
    const who = o.customer ? o.customer.displayName : o.sourceName === 'pos' ? 'in-person sale' : '';
    const info = { order: o.name, source: o.sourceName, ship_state: state, tax_cents: tax, subtotal_cents: money(o.subtotalPriceSet), shipping_cents: money(o.totalShippingPriceSet) };

    if (!sales.length) {
      if (!o.cancelledAt) other.push({ ...info, date: day(o.createdAt), total_cents: money(o.totalPriceSet), gateway: (o.paymentGatewayNames || []).join(', '), customer: who,
        flag: state === homeState && tax === 0 && o.sourceName !== 'pos' ? `Shipped to ${homeState} with no sales tax charged` : null });
      continue;
    }
    // One capture per order in practice; use the successful sale/capture amount.
    const s = sales[sales.length - 1];
    const gross = money(s.amountSet);
    const income = o.sourceName === 'pos' ? '4010' : '4020';
    const taxPart = Math.min(tax, gross);
    rows.push({
      date: day(s.processedAt || o.createdAt), amount_cents: gross,
      description: `Shopify order ${o.name}${who ? ' · ' + who : ''}${state ? ' · ' + state : ''}`, source_ref: `${o.name}:sale`,
      extra: { shopify: info },
      suggestion: {
        category_code: income, member: null, strong: true,
        reason: taxPart ? `Shopify ${o.sourceName === 'pos' ? 'in-person' : 'online'} sale; ${(taxPart / 100).toFixed(2)} of it is sales tax` : `Shopify ${o.sourceName === 'pos' ? 'in-person' : 'online'} sale`
          + (state === homeState && !taxPart && o.sourceName !== 'pos' ? ` (shipped to ${homeState}, no tax charged)` : ''),
        splits: taxPart ? [{ category_code: income, amount_cents: gross - taxPart }, { category_code: '2100', amount_cents: taxPart }] : null,
      },
    });
    const fee = sales.reduce((t, x) => t + (x.fees || []).reduce((u, f) => u + cents(f.amount && f.amount.amount), 0), 0);
    if (fee) rows.push({ date: day(s.processedAt || o.createdAt), amount_cents: -fee, description: `Shopify payment fee · ${o.name}`, source_ref: `${o.name}:fee`,
      suggestion: { category_code: '6040', member: null, strong: true, reason: 'Shopify Payments processing fee' } });
    for (const r of tx.filter((t) => t.kind === 'REFUND' && t.status === 'SUCCESS')) {
      rows.push({ date: day(r.processedAt), amount_cents: -money(r.amountSet), description: `Shopify refund · ${o.name}${who ? ' · ' + who : ''}`, source_ref: `${o.name}:refund:${r.processedAt}`,
        suggestion: { category_code: '4900', member: null, strong: true, reason: 'Refund of a Shopify order' } });
    }
  }
  return { rows, orders: other };
}
