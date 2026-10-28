// Navy Federal (NFCU) monthly statement parser.
// Input: the statement's text in "layout" form (one printed line per text line,
// columns kept in place). Output: one entry per account section, each with its
// transactions, beginning and ending balances, and a balance check.
//
// Every NFCU row carries a running balance, so each parsed line is verified:
// previous balance +/- amount must equal the printed balance.

const ROW = /^(\d{2})-(\d{2})\s{2,}(.+?)\s{2,}([\d,]+\.\d{2})\s+(-)?\s+(-?[\d,]+\.\d{2})\s*$/;
const ROW_NO_AMOUNT = /^(\d{2})-(\d{2})\s{2,}(\S.*?)\s*$/;
const BAL = /^(\d{2})-(\d{2})\s{2,}(Beginning|Ending) Balance\s+(-?[\d,]+\.\d{2})\s*$/;
const CONT_WITH_AMOUNT = /^\s{4,}(.+?)\s{2,}([\d,]+\.\d{2})\s+(-)?\s+(-?[\d,]+\.\d{2})\s*$/;
const CONT_TEXT = /^\s{4,}(\S.*?)\s*$/;
const SECTION = /^\s*(.+?) - \d{0,12}(\d{4})(?:\s|$)/;
const PERIOD = /(\d{2})\/(\d{2})\/(\d{2}) - (\d{2})\/(\d{2})\/(\d{2})/;

const cents = (s) => {
  const neg = s.startsWith('-');
  const [w, f] = s.replace(/[-,]/g, '').split('.');
  return (neg ? -1 : 1) * (Number(w) * 100 + Number(f));
};

export function parseNfcuStatement(text) {
  const lines = text.split(/\r?\n/);
  const pm = text.match(PERIOD);
  if (!pm) throw new Error('Not an NFCU statement: no statement period found.');
  const start = { y: 2000 + Number(pm[3]), m: Number(pm[1]) };
  const end = { y: 2000 + Number(pm[6]), m: Number(pm[4]), d: Number(pm[5]) };
  const isoFor = (mm, dd) => {
    const m = Number(mm);
    // A December-January statement spans two years.
    const y = start.y !== end.y && m === start.m ? start.y : end.y;
    return `${y}-${mm}-${dd}`;
  };

  const accounts = new Map();
  let cur = null;
  let pending = null; // a dated row whose amount is on a continuation line
  let last = null;
  let inTable = false;

  const section = (name, mask) => {
    const key = mask;
    if (!accounts.has(key)) accounts.set(key, { name: name.trim(), mask, beginning: null, ending: null, lines: [], problems: [] });
    return accounts.get(key);
  };

  const push = (mm, dd, desc, amt, minus, bal) => {
    const amount = cents(amt) * (minus ? -1 : 1);
    const balance = cents(bal);
    const prev = cur.lines.length ? cur.lines[cur.lines.length - 1].balance_cents : cur.beginning;
    const line = { date: isoFor(mm, dd), description: desc.replace(/\s+/g, ' ').trim(), amount_cents: amount, balance_cents: balance };
    if (prev !== null && prev + amount !== balance) {
      // Sign markers are sometimes lost; trust the running balance if it explains the row.
      if (prev - amount === balance) line.amount_cents = -amount;
      else cur.problems.push(`${line.date} ${line.description}: balance does not follow (${prev} -> ${balance}, amount ${amount})`);
    }
    cur.lines.push(line);
    last = line;
  };

  for (const raw of lines) {
    const s = raw.replace(/\s+$/, '');
    if (!s.trim()) continue;

    const sec = s.match(SECTION);
    if (sec && /(Checking|Savings|Credit|Money Market|Certificate)/i.test(sec[1]) && !/^\d{2}-\d{2}/.test(s.trim())) {
      cur = section(sec[1].replace(/^\s*/, ''), sec[2]);
      inTable = false;
      pending = null;
      last = null;
      continue;
    }
    if (!cur) continue;
    if (/^Date\s+Transaction Detail/.test(s)) { inTable = true; continue; }
    if (/^(Average Daily Balance|Items Paid|Interest Charge|Dividend|Page \d|\s*Statement Period)/.test(s.trim())) { inTable = false; continue; }

    const b = s.match(BAL);
    if (b) {
      if (b[3] === 'Beginning') cur.beginning = cents(b[4]);
      else { cur.ending = cents(b[4]); inTable = false; }
      pending = null;
      continue;
    }
    if (!inTable) continue;

    let m = s.match(ROW);
    if (m) { pending = null; push(m[1], m[2], m[3], m[4], !!m[5], m[6]); continue; }
    m = s.match(CONT_WITH_AMOUNT);
    if (m && pending) { push(pending.mm, pending.dd, `${pending.desc} ${m[1]}`, m[2], !!m[3], m[4]); pending = null; continue; }
    m = s.match(ROW_NO_AMOUNT);
    if (m && !/No Transactions/.test(s)) { pending = { mm: m[1], dd: m[2], desc: m[3] }; continue; }
    m = s.match(CONT_TEXT);
    if (m && last && !pending && !/No Transactions|Continued/.test(s)) { last.description = `${last.description} ${m[1].replace(/\s+/g, ' ')}`; continue; }
  }

  const out = [...accounts.values()].map((a) => {
    const lastBal = a.lines.length ? a.lines[a.lines.length - 1].balance_cents : a.beginning;
    if (a.ending !== null && lastBal !== a.ending) a.problems.push(`ending balance ${a.ending} does not match last running balance ${lastBal}`);
    if (pending) a.problems.push('a row was left without an amount');
    return { ...a, ok: a.problems.length === 0 };
  });
  return {
    institution: 'Navy Federal Credit Union',
    period_start: `${start.y}-${pm[1]}-${pm[2]}`,
    period_end: `${end.y}-${pm[4]}-${pm[5]}`,
    accounts: out,
  };
}
