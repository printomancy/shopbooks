// Money math. All amounts are integer cents; rates are basis points (7.5% = 750).
// Pure functions only, so they run the same in the browser and in tests.

export function parseMoney(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).replace(/[$,\s]/g, '');
  if (s === '') return null;
  if (!/^-?\d*\.?\d*$/.test(s) || s === '.' || s === '-') return NaN;
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const cents = Number(whole || 0) * 100 + Number((frac + '00').slice(0, 2));
  // round half up on a third decimal
  const extra = frac.length > 2 && Number(frac[2]) >= 5 ? 1 : 0;
  return (neg ? -1 : 1) * (cents + extra);
}

export function fmt(cents, { blank = '—' } = {}) {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return blank;
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${neg ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

export function toInput(cents) {
  if (cents === null || cents === undefined) return '';
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function pct(bp) {
  return `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : bp % 10 === 0 ? 1 : 2)}%`;
}

// Split a tax-included amount into the taxable price and the tax inside it.
// $5.00 at 7.5% -> { taxable: 465, tax: 35 }
export function splitTaxIncluded(grossCents, rateBp) {
  if (!grossCents) return { taxable: 0, tax: 0 };
  const taxable = Math.round((grossCents * 10000) / (10000 + rateBp));
  return { taxable, tax: grossCents - taxable };
}

const n = (v) => (typeof v === 'number' && !Number.isNaN(v) ? v : 0);

// Event roll-up. Days are walked in date order so each day's opening cash
// defaults to what was left in the box the night before.
export function summarizeEvent(event, days, deposits) {
  const rateBp = n(event.state_rate_bp) + n(event.surtax_bp);
  const sorted = [...days].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  let carry = n(event.opening_float_cents);
  const rows = [];
  const t = { cash: 0, card: 0, paidOut: 0, removed: 0, daysCounted: 0, daysOpen: 0 };

  for (const d of sorted) {
    const opening = d.opening_cash_cents ?? carry;
    const closing = d.closing_cash_cents;
    const paidOut = n(d.cash_paid_out_cents);
    const removed = n(d.cash_removed_cents);
    const cashSales = closing === null || closing === undefined ? null : closing - opening + paidOut;
    const card = n(d.paypal_cents) + n(d.other_card_cents);
    const gross = (cashSales ?? 0) + card;
    rows.push({ ...d, opening, cashSales, card, gross, ...splitTaxIncluded(gross, rateBp) });
    if (cashSales === null) t.daysOpen += 1;
    else {
      t.daysCounted += 1;
      t.cash += cashSales;
    }
    t.card += card;
    t.paidOut += paidOut;
    t.removed += removed;
    carry = closing === null || closing === undefined ? opening : closing - removed;
  }

  const gross = t.cash + t.card;
  const float = n(event.opening_float_cents);
  const deposited = deposits.reduce((s, d) => s + n(d.amount_cents), 0);
  // All cash that came through the box should end up deposited or still on hand.
  const cashToAccountFor = float + t.cash - t.paidOut;
  const notDeposited = cashToAccountFor - deposited;

  return {
    rateBp,
    days: rows,
    totals: {
      cashSales: t.cash,
      cardSales: t.card,
      gross,
      ...splitTaxIncluded(gross, rateBp),
      paidOut: t.paidOut,
      boothFee: n(event.booth_fee_cents),
      daysCounted: t.daysCounted,
      daysOpen: t.daysOpen,
    },
    cash: {
      float,
      cashSales: t.cash,
      paidOut: t.paidOut,
      toAccountFor: cashToAccountFor,
      deposited,
      notDeposited,
      floatPortionOfDeposits: Math.min(float, deposited),
      salesPortionOfDeposits: Math.max(0, deposited - float),
    },
  };
}

export const DENOMINATIONS = [
  { label: '$100', cents: 10000 },
  { label: '$50', cents: 5000 },
  { label: '$20', cents: 2000 },
  { label: '$10', cents: 1000 },
  { label: '$5', cents: 500 },
  { label: '$2', cents: 200 },
  { label: '$1', cents: 100 },
  { label: '25¢', cents: 25 },
  { label: '10¢', cents: 10 },
  { label: '5¢', cents: 5 },
  { label: '1¢', cents: 1 },
];
