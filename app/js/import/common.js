// Shared import helpers: turning parsed rows into statement-line records with
// stable ids, so importing the same file twice never creates duplicates.

export function normalizeDesc(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 .*#&-]/g, '').trim();
}

export async function sha(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// rows: [{ date, amount_cents, description, balance_cents?, source_ref?, raw? }]
// Identical rows in one file (same day, amount, text, no balance) get an
// occurrence number so both are kept.
export async function buildStatementLines(rows, { accountId, companyId, source, importId, extra = {} }) {
  const seen = new Map();
  const out = [];
  for (const r of rows) {
    const base = [accountId, r.date, r.amount_cents, normalizeDesc(r.description), r.balance_cents ?? ''].join('|');
    const key = r.source_ref ? `${accountId}|ref|${r.source_ref}` : base;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    const fingerprint = `${key}|${n}`;
    const id = 'sl_' + (await sha(fingerprint)).slice(0, 24);
    out.push({
      id,
      type: 'statement_line',
      company_id: companyId,
      data: {
        account_id: accountId,
        date: r.date,
        amount_cents: r.amount_cents,
        description: r.description,
        balance_cents: r.balance_cents ?? null,
        source,
        source_ref: r.source_ref || null,
        import_id: importId,
        fingerprint,
        status: 'unreviewed',
        allocation: null,
        suggestion: r.suggestion || null,
        ...extra,
        ...(r.extra || {}),
      },
    });
  }
  return out;
}
