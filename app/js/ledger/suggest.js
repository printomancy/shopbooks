// Suggestion engine: rules, transfer matching and learning from past reviews.
// Pure functions (no storage), so they are easy to test and run anywhere.
//
// Priority for an unreviewed line:
//   1. a rule the user made            ("Rule: Whatnot payouts")
//   2. a matching transfer between two of the user's own accounts
//   3. how the user categorized the same payee before
//   4. whatever the import itself suggested (for example old Xero labels)

// ---------- payee keys ----------

// 3 words tested best on real data (89% right on unseen months).
export let KEY_WORDS = 3;
export function setKeyWords(n) { KEY_WORDS = n; }
const NOISE = /\b(pos debit|business debit card|debit card|transaction|deposit|ach|rtp|paid from|paid to|payout|chk|purchase|recurring|www|com|inc|llc|ltd|lt|co)\b/g;

// A stable short key for "who is this", ignoring dates, card numbers and ids.
export function payeeKey(desc) {
  return String(desc || '')
    .toLowerCase()
    .replace(/\d{2}-\d{2}-\d{2}/g, ' ')
    .replace(/[#*]\s*\w*\d\w*/g, ' ')
    .replace(/\b\w*\d\w*\b/g, ' ')
    .replace(NOISE, ' ')
    .replace(/[^a-z& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, KEY_WORDS)
    .join(' ');
}

// ---------- rules ----------
// rule.data: { name, match: { text, account_id?, direction?: 'in'|'out', amount_cents? }, action: { category_code, member? }, auto }

export function ruleMatches(rule, line) {
  const m = rule.match || {};
  if (m.account_id && m.account_id !== line.account_id) return false;
  if (m.direction === 'in' && line.amount_cents <= 0) return false;
  if (m.direction === 'out' && line.amount_cents >= 0) return false;
  if (m.amount_cents && Math.abs(line.amount_cents) !== Math.abs(m.amount_cents)) return false;
  if (m.text && !String(line.description || '').toLowerCase().includes(String(m.text).toLowerCase())) return false;
  return !!(m.text || m.account_id || m.amount_cents);
}

// ---------- learning from history ----------

export function buildHistory(reviewedLines) {
  const map = new Map();
  for (const l of reviewedLines) {
    if (l.status !== 'reviewed' || !l.allocation || l.allocation.splits.length !== 1) continue;
    const key = `${payeeKey(l.description)}|${l.amount_cents > 0 ? 'in' : 'out'}`;
    if (!key.split('|')[0]) continue;
    const s = l.allocation.splits[0];
    const k2 = `${s.category_code}|${s.member || ''}`;
    const e = map.get(key) || { total: 0, counts: new Map() };
    e.total += 1;
    e.counts.set(k2, (e.counts.get(k2) || 0) + 1);
    map.set(key, e);
  }
  return map;
}

export function fromHistory(history, line) {
  const e = history.get(`${payeeKey(line.description)}|${line.amount_cents > 0 ? 'in' : 'out'}`);
  if (!e || e.total < 2) return null;
  const [best, n] = [...e.counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (n / e.total < 0.75) return null;
  const [category_code, member] = best.split('|');
  return { category_code, member: member || null, reason: `You chose this for ${n} of ${e.total} similar transactions` };
}

// ---------- transfers between the user's own accounts ----------

// Wording that marks money moving between accounts (not a sale or a fee).
const TRANSFER_WORDS = /\btransfer\b|\bxfer\b|payout|withdraw|payment thank you|thank you for your payment|autopay|epayment|online pmt|\bpmt\b|paid from (paypal|etsy|whatnot|stripe|square|shopify)|paid to - paypal|money transfer|transfer from shares|transfer to shares|credit card payment/i;
const NOT_TRANSFER = /sale of goods|\bfee\b|fees and|refund|shipping label|purchase|pos debit|transfer (to|from) checking\s+[a-z]+/i;

function transferCode(a, b, accountsById) {
  const kinds = [accountsById[a.account_id]?.kind, accountsById[b.account_id]?.kind];
  if (kinds.some((k) => k === 'credit_card' || k === 'line_of_credit' || k === 'personal_card')) return '9010';
  if (kinds.includes('platform')) return '9030';
  return '9000';
}

// Pairs an outflow in one account with an inflow in another: same amount within
// a small fee allowance, dated within a few days. Returns Map(lineId -> match).
export function findTransfers(lines, accountsById, { days = 5, feeShare = 0.03, maxFee = 1500 } = {}) {
  const open = lines.filter((l) => l.status === 'unreviewed' && !l.transfer_pair_id);
  const others = lines.filter((l) => !l.transfer_pair_id && (l.status === 'unreviewed' || isTransferAlloc(l)));
  const outs = open.filter((l) => l.amount_cents < 0);
  const used = new Set();
  const result = new Map();
  const dn = (iso) => Date.parse(iso) / 864e5;

  const candidates = [];
  for (const o of outs) {
    for (const i of others) {
      if (i.amount_cents <= 0 || i.account_id === o.account_id) continue;
      const gap = Math.abs(dn(i.date) - dn(o.date));
      if (gap > days) continue;
      const diff = -o.amount_cents - i.amount_cents; // positive = fee taken in transit
      const exact = diff === 0;
      const feeOk = diff > 0 && diff <= Math.min(maxFee, Math.round(-o.amount_cents * feeShare));
      if (!exact && !feeOk) continue;
      if (NOT_TRANSFER.test(o.description) || NOT_TRANSFER.test(i.description)) continue;
      const wordy = TRANSFER_WORDS.test(o.description) || TRANSFER_WORDS.test(i.description);
      if (!wordy) continue; // amounts alone collide too often to trust
      candidates.push({ o, i, score: (exact ? 0 : 10) + gap + (wordy ? 0 : 5) });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  for (const { o, i } of candidates) {
    if (used.has(o.id) || used.has(i.id)) continue;
    used.add(o.id); used.add(i.id);
    const code = transferCode(o, i, accountsById);
    const fee = -o.amount_cents - i.amount_cents;
    const name = (l) => accountsById[l.account_id]?.name || 'another account';
    if (o.status === 'unreviewed') result.set(o.id, { pair: i.id, category_code: code, fee_cents: fee, reason: `Matches ${fmtC(i.amount_cents)} into ${name(i)} on ${i.date}${fee ? ` (${fmtC(fee)} fee in between)` : ''}` });
    if (i.status === 'unreviewed') result.set(i.id, { pair: o.id, category_code: code, fee_cents: fee, reason: `Matches ${fmtC(-o.amount_cents)} out of ${name(o)} on ${o.date}` });
  }
  return result;
}

const isTransferAlloc = (l) => l.allocation && l.allocation.splits.every((s) => /^90/.test(s.category_code));
const fmtC = (c) => `$${(Math.abs(c) / 100).toFixed(2)}`;

// ---------- put it together ----------

// Returns [{ id, suggestion, autoAllocation? }] for unreviewed lines whose suggestion should change.
export function computeSuggestions(lines, rules, accountsById) {
  const history = buildHistory(lines);
  const transfers = findTransfers(lines, accountsById);
  const activeRules = rules.filter((r) => !r.disabled);
  const out = [];
  for (const l of lines) {
    if (l.status !== 'unreviewed') continue;
    let s = null, auto = false;
    const rule = activeRules.find((r) => ruleMatches(r, l));
    if (rule) {
      s = { category_code: rule.action.category_code, member: rule.action.member || null, reason: `Rule: ${rule.name}`, rule_id: rule.id };
      auto = !!rule.auto;
    } else if (transfers.has(l.id)) {
      const t = transfers.get(l.id);
      s = { category_code: t.category_code, member: null, reason: t.reason, transfer_pair_id: t.pair, fee_cents: t.fee_cents };
    } else {
      s = fromHistory(history, l) || (l.suggestion && !l.suggestion.rule_id && !l.suggestion.transfer_pair_id && !/^You chose/.test(l.suggestion.reason || '') ? l.suggestion : null);
    }
    const same = JSON.stringify(s) === JSON.stringify(l.suggestion || null);
    if (!same || auto) out.push({ id: l.id, suggestion: s, auto });
  }
  return out;
}
