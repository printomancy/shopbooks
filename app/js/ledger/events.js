// Posts an event's sales log into the books (the Cash box account), so event
// cash sales reach the P&L and the sales tax return without double counting.
//
//   day closed out        -> cash sales (tax included at the event's rate)   [reviewed]
//   cash paid out of box  -> expense line waiting for a category             [to review]
//   opening float         -> cash put in the box (not income)               [reviewed]
//   deposit recorded      -> transfer Cash box -> bank                       [reviewed]
//
// PayPal and other card sales are NOT posted: they already arrive through the
// PayPal (or other) account. The event page compares the two instead.
// Every derived line has a stable id, so re-posting updates in place and
// deleting the event removes exactly what it added.
import { summarizeEvent } from '../money.js';

export const lineIds = {
  cash: (dayId) => `sl_evt_${dayId}_cash`,
  paidOut: (dayId) => `sl_evt_${dayId}_paid`,
  deposit: (depId) => `sl_evt_${depId}_dep`,
  float: (eventId) => `sl_evt_${eventId}_float`,
};

// Returns the full set of records this event should have in the books.
export function eventLines({ event, days, deposits, cashAccountId, companyId }) {
  const s = summarizeEvent(event, days, deposits);
  const rateBp = s.rateBp;
  const tag = { event_id: event.id, event_name: event.name, county: event.county || null, rate_bp: rateBp };
  const out = [];
  const base = (id, date, amount_cents, description, extra) => ({
    id, type: 'statement_line', company_id: companyId,
    data: { account_id: cashAccountId, date, amount_cents, description, balance_cents: null, source: 'event_log', source_ref: id,
      import_id: `event:${event.id}`, fingerprint: id, event: tag, ...extra },
  });
  if (event.opening_float_cents) {
    out.push(base(lineIds.float(event.id), event.start_date, event.opening_float_cents, `${event.name}: opening cash float put in the box`, {
      status: 'reviewed',
      allocation: { splits: [{ category_code: '9020', amount_cents: event.opening_float_cents, member: null }], memo: 'Not income. If the float came from your own pocket, change this to Member contribution.', reviewed_at: null, by: 'Event log' },
    }));
  }
  for (const d of s.days) {
    if (d.cashSales !== null && d.cashSales !== 0) {
      out.push(base(lineIds.cash(d.id), d.date, d.cashSales, `${event.name}: cash sales ${d.date}`, {
        status: 'reviewed',
        allocation: { splits: [{ category_code: '4000', amount_cents: d.cashSales, member: null }], memo: 'From the event sales log (prices include sales tax)', reviewed_at: d.updated_at || null, by: 'Event log' },
      }));
    }
    if (d.cash_paid_out_cents) {
      out.push(base(lineIds.paidOut(d.id), d.date, -d.cash_paid_out_cents, `${event.name}: paid from cash box${d.paid_out_note ? ` · ${d.paid_out_note}` : ''}`, {
        status: 'unreviewed', allocation: null, suggestion: { category_code: '6020', member: null, reason: 'Cash paid out at an event; change it if it was something else' },
      }));
    }
  }
  for (const dep of deposits) {
    if (!dep.amount_cents) continue;
    out.push(base(lineIds.deposit(dep.id), dep.date, -dep.amount_cents, `${event.name}: cash box deposit to ${dep.account || 'bank'}`, {
      status: 'reviewed',
      allocation: { splits: [{ category_code: '9020', amount_cents: -dep.amount_cents, member: null }], memo: 'Cash taken to the bank; matched to the bank deposit as a transfer', reviewed_at: null, by: 'Event log' },
    }));
  }
  return out;
}

// PayPal check: what the PayPal account shows for the event dates vs what was logged.
export function cardCheck({ event, days, lines, accountsById }) {
  const start = event.start_date, end = event.end_date || event.start_date;
  const logged = days.reduce((t, d) => t + (d.paypal_cents || 0), 0);
  const inBooks = lines.filter((l) => l.date >= start && l.date <= end && accountsById[l.account_id]?.institution === 'PayPal' && l.amount_cents > 0)
    .filter((l) => { const s = (l.allocation || {}).splits || (l.suggestion ? [{ category_code: l.suggestion.category_code }] : []); return s.some((x) => /^40/.test(x.category_code)); })
    .reduce((t, l) => t + l.amount_cents, 0);
  return { logged, inBooks, difference: inBooks - logged };
}
