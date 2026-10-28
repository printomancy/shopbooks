// Books: accounts, account registers, reviewing lines, and CSV import.
import * as db from './db.js';
import { fmt } from './money.js';
import { DEFAULT_CATEGORIES, GROUP_LABELS, ACCOUNT_KINDS } from './ledger/chart.js';
import { parseCsv, guessMapping, rowsFromCsv } from './import/csv.js';
import { buildStatementLines } from './import/common.js';

let ui; // helpers from app.js: esc, renderBar, setDock, go, $view, COMPANY, niceDate, setForm
export function init(ctx) { ui = ctx; }

const CATS = new Map(DEFAULT_CATEGORIES.map((c) => [c.code, c]));
export const catName = (code) => (CATS.get(code) ? CATS.get(code).name : code);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const SOURCE_LABEL = {
  nfcu_statement: 'Bank statement',
  xero_history: 'Xero history',
  plaid_history: 'Plaid history',
  csv: 'CSV import',
};

// "POS Debit- Business Debit Card 9235 09-01-26 My Mini Factory Lt London" -> "My Mini Factory Lt London"
export function payeeOf(desc) {
  return String(desc || '')
    .replace(/^POS Debit\s*-?\s*(Business )?Debit Card \d{4}\s*(Transaction\s*)?\d{2}-\d{2}-\d{2}\s*/i, '')
    .replace(/^Deposit - (ACH|RTP) Paid From\s*/i, '')
    .replace(/^Paid To - ?/i, '')
    .replace(/\s+Chk \d+$/i, '')
    .trim() || desc;
}

async function accounts() {
  return (await db.list('account', { companyId: ui.COMPANY })).map((a) => ({ id: a.id, ...a.data })).filter((a) => a.active !== false);
}
async function allLines() {
  return (await db.list('statement_line', { companyId: ui.COMPANY })).map((l) => ({ id: l.id, ...l.data }));
}
const byDate = (a, b) => a.date.localeCompare(b.date) || (a.fingerprint || '').localeCompare(b.fingerprint || '');

function accountStats(acct, lines) {
  const mine = lines.filter((l) => l.account_id === acct.id).sort(byDate);
  const toReview = mine.filter((l) => l.status === 'unreviewed').length;
  const withBal = mine.filter((l) => l.balance_cents !== null && l.balance_cents !== undefined);
  const lastBal = withBal.length ? withBal[withBal.length - 1] : null;
  return { mine, count: mine.length, toReview, first: mine[0]?.date, last: mine[mine.length - 1]?.date, lastBal };
}

// ---------- home section ----------

export async function accountsSection() {
  const [accts, lines] = await Promise.all([accounts(), allLines()]);
  if (!accts.length) {
    return `<h2>Books</h2><div class="empty"><strong>No accounts yet</strong>Add your bank, card and sales-platform accounts, then import a statement.</div>`;
  }
  const totalReview = lines.filter((l) => l.status === 'unreviewed').length;
  const rows = accts.map((a) => {
    const s = accountStats(a, lines);
    const right = s.lastBal ? `${fmt(s.lastBal.balance_cents)}<small>on ${ui.niceDate(s.lastBal.date)}</small>`
      : s.count ? `${s.count}<small>lines</small>` : `<small>No data yet</small>`;
    return `<li><a href="#/account/${a.id}">
      <div class="main"><div class="name">${ui.esc(a.name)}</div>
        <div class="meta">${s.count ? `${ui.esc(ui.niceDate(s.first))} to ${ui.esc(ui.niceDate(s.last))}` : ui.esc(ACCOUNT_KINDS[a.kind] || '')}${s.toReview ? ` &middot; <span class="tag">${s.toReview} to review</span>` : ''}</div></div>
      <div class="amt">${right}</div><span class="chev" aria-hidden="true">&rsaquo;</span></a></li>`;
  }).join('');
  return `<h2>Books</h2>
    <p class="sub">${totalReview ? `${totalReview.toLocaleString()} transactions waiting for a category.` : 'Everything is reviewed.'}</p>
    <ul class="rows">${rows}</ul>
    <div class="actions"><a class="btn" href="#/import">Import a statement (CSV)</a></div>`;
}

// ---------- account register ----------

export async function accountView(id, query) {
  const accts = await accounts();
  const acct = accts.find((a) => a.id === id);
  if (!acct) return ui.go('#/');
  const lines = await allLines();
  const s = accountStats(acct, lines);
  const filter = query.get('show') || (s.toReview ? 'review' : 'all');
  const q = (query.get('q') || '').toLowerCase();
  let shown = s.mine.filter((l) => (filter === 'review' ? l.status === 'unreviewed' : true));
  if (q) shown = shown.filter((l) => `${l.description} ${(l.amount_cents / 100).toFixed(2)}`.toLowerCase().includes(q));
  shown = shown.slice().reverse(); // newest first
  const limit = Number(query.get('n') || 250);

  ui.renderBar({ title: acct.name, back: '#/' });
  let html = `
    <h1>${ui.esc(acct.name)}</h1>
    <p class="sub">${ui.esc(ACCOUNT_KINDS[acct.kind] || '')}${acct.mask ? ` ending ${ui.esc(acct.mask)}` : ''}${s.count ? ` &middot; ${ui.esc(ui.niceDate(s.first))} to ${ui.esc(ui.niceDate(s.last))}` : ''}</p>`;
  if (s.lastBal) {
    html += `<section class="tape" aria-label="Balance">
      <div class="big">${fmt(s.lastBal.balance_cents)}</div>
      <div class="big-label">Balance on ${ui.esc(ui.niceDate(s.lastBal.date))}, per the bank statement</div>
      ${acct.opening ? `<div class="line muted"><span class="k">Starting balance ${ui.esc(ui.niceDate(acct.opening.date))}</span><span class="lead"></span><span class="v">${fmt(acct.opening.balance_cents)}</span></div>` : ''}
      <div class="line"><span class="k">Money in</span><span class="lead"></span><span class="v">${fmt(s.mine.filter((l) => l.amount_cents > 0).reduce((t, l) => t + l.amount_cents, 0))}</span></div>
      <div class="line"><span class="k">Money out</span><span class="lead"></span><span class="v">${fmt(s.mine.filter((l) => l.amount_cents < 0).reduce((t, l) => t + l.amount_cents, 0))}</span></div>
    </section>`;
  }
  html += `
    <form class="filters" id="flt" role="search">
      <div class="seg" role="tablist">
        <a role="tab" aria-selected="${filter === 'review'}" href="#/account/${id}?show=review">To review (${s.toReview})</a>
        <a role="tab" aria-selected="${filter === 'all'}" href="#/account/${id}?show=all">All (${s.count})</a>
      </div>
      <input type="search" name="q" value="${ui.esc(query.get('q') || '')}" placeholder="Search description or amount" aria-label="Search">
    </form>`;

  if (!shown.length) {
    html += `<div class="empty"><strong>${filter === 'review' ? 'Nothing to review here' : 'No transactions'}</strong>${filter === 'review' ? 'Every line in this account has a category.' : 'Import a statement to fill this account.'}</div>`;
  } else {
    let month = '';
    let open = false;
    for (const l of shown.slice(0, limit)) {
      const mk = l.date.slice(0, 7);
      if (mk !== month) {
        if (open) html += '</ul>';
        month = mk;
        html += `<h3 class="month">${MONTHS[Number(mk.slice(5, 7)) - 1]} ${mk.slice(0, 4)}</h3><ul class="rows">`;
        open = true;
      }
      html += lineRow(l, filter);
    }
    if (open) html += '</ul>';
    if (shown.length > limit) html += `<div class="actions"><a class="btn" href="#/account/${id}?show=${filter}&n=${limit + 250}${q ? `&q=${encodeURIComponent(q)}` : ''}">Show more (${shown.length - limit} left)</a></div>`;
  }
  ui.$view.innerHTML = html;
  if (s.toReview && filter === 'review') {
    const first = shown[shown.length - 1]; // oldest unreviewed first when reviewing
    ui.setDock(`<a class="btn btn-primary" href="#/line/${first.id}?flow=${id}">Start reviewing (oldest first)</a>`);
  } else ui.setDock(`<a class="btn" href="#/import?account=${id}">Import a statement</a>`);

  const flt = document.getElementById('flt');
  flt.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = flt.elements.q.value.trim();
    ui.go(`#/account/${id}?show=${filter}${v ? `&q=${encodeURIComponent(v)}` : ''}`);
  });
}

function lineRow(l, filter) {
  const alloc = l.allocation;
  const meta = l.status === 'excluded' ? '<span class="chip quiet">Not business</span>'
    : alloc ? `<span class="chip done">${ui.esc(alloc.splits.length > 1 ? `${alloc.splits.length} categories` : catName(alloc.splits[0].category_code))}</span>`
    : l.suggestion ? `<span class="chip">Suggested: ${ui.esc(catName(l.suggestion.category_code))}</span>`
    : '<span class="chip warn">No suggestion</span>';
  return `<li><a href="#/line/${l.id}${filter === 'review' ? `?flow=${l.account_id}` : ''}">
    <div class="main"><div class="name">${ui.esc(payeeOf(l.description))}</div><div class="meta">${ui.esc(ui.niceDate(l.date))} &middot; ${meta}</div></div>
    <div class="amt ${l.amount_cents > 0 ? 'in' : ''}">${fmt(l.amount_cents)}</div><span class="chev" aria-hidden="true">&rsaquo;</span></a></li>`;
}

// ---------- one line: review ----------

function categoryOptions(selected) {
  const groups = {};
  for (const c of DEFAULT_CATEGORIES) (groups[c.group] ||= []).push(c);
  return `<option value="">Choose a category</option>` + Object.entries(groups).map(([g, cs]) =>
    `<optgroup label="${ui.esc(GROUP_LABELS[g])}">${cs.map((c) => `<option value="${c.code}" ${c.code === selected ? 'selected' : ''}>${ui.esc(c.name)}</option>`).join('')}</optgroup>`).join('');
}

export async function lineView(id, query) {
  ui.setForm(true);
  const rec = await db.get(id);
  if (!rec || rec.deleted) return ui.go('#/');
  const l = { id, ...rec.data };
  const accts = await accounts();
  const acct = accts.find((a) => a.id === l.account_id) || { name: 'Account' };
  const flow = query.get('flow');
  const members = (await db.list('member', { companyId: ui.COMPANY })).map((m) => ({ id: m.id, ...m.data }));
  const sug = l.suggestion;
  const current = l.allocation ? l.allocation.splits[0] : sug ? { category_code: sug.category_code, member: sug.member ? `member_${sug.member}` : null } : {};
  const back = flow ? `#/account/${flow}?show=review` : `#/account/${l.account_id}?show=all`;

  ui.renderBar({ title: payeeOf(l.description), back });
  ui.$view.innerHTML = `
    <section class="tape" aria-label="Transaction">
      <div class="big ${l.amount_cents > 0 ? 'in' : ''}">${fmt(l.amount_cents)}</div>
      <div class="big-label">${l.amount_cents > 0 ? 'Money in' : 'Money out'} &middot; ${ui.esc(ui.niceDate(l.date, { weekday: true }))}, ${l.date.slice(0, 4)}</div>
      <div class="line"><span class="k">Account</span><span class="lead"></span><span class="v">${ui.esc(acct.name)}</span></div>
      ${l.balance_cents !== null && l.balance_cents !== undefined ? `<div class="line"><span class="k">Balance after</span><span class="lead"></span><span class="v">${fmt(l.balance_cents)}</span></div>` : ''}
      <div class="line muted"><span class="k">From</span><span class="lead"></span><span class="v">${ui.esc(SOURCE_LABEL[l.source] || l.source)}</span></div>
    </section>
    <p class="desc">${ui.esc(l.description)}</p>

    ${l.status !== 'unreviewed' ? `<div class="okmsg">${l.status === 'excluded' ? 'Marked as not a business transaction.' : `Reviewed: ${ui.esc(l.allocation.splits.map((s) => catName(s.category_code)).join(', '))}.`}</div>` : ''}
    ${sug && l.status === 'unreviewed' ? `<div class="suggest"><div><strong>${ui.esc(catName(sug.category_code))}</strong>${sug.member ? ` &middot; ${ui.esc(sug.member === 'alec' ? 'Alec' : sug.member === 'gwen' ? 'Gwen' : sug.member)}` : ''}<div class="small">${ui.esc(sug.reason || '')}</div></div>
      <button type="button" class="primary" id="accept">Approve</button></div>` : ''}

    <form id="f" novalidate>
      <div class="field"><label for="cat">Category</label><select id="cat" name="cat">${categoryOptions(current.category_code)}</select>
        <div class="hint" id="catNote"></div></div>
      <div class="field" id="memberField" hidden><label for="mem">Member</label>
        <select id="mem" name="member"><option value="">Choose who</option>${members.map((m) => `<option value="${m.id}" ${current.member === m.id ? 'selected' : ''}>${ui.esc(m.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="memo">Note</label><input id="memo" name="memo" value="${ui.esc(l.allocation?.memo || '')}" placeholder="Optional"></div>
      <div id="err" class="err" role="alert"></div>
      <div class="actions">
        ${l.status === 'unreviewed' ? `<button type="button" class="quiet" id="exclude">Not a business transaction</button>` : `<button type="button" class="quiet" id="reopen">Move back to review</button>`}
      </div>
    </form>`;
  ui.setDock(`<a class="btn" href="${back}">Back</a><button class="primary" form="f" type="submit">${flow ? 'Save and next' : 'Save'}</button>`);

  const f = document.getElementById('f');
  const sync = () => {
    const c = CATS.get(f.elements.cat.value);
    document.getElementById('memberField').hidden = !(c && c.member);
    document.getElementById('catNote').textContent = c && c.note ? c.note : '';
  };
  f.elements.cat.addEventListener('change', sync);
  sync();

  const next = async () => {
    if (!flow) return ui.go(back);
    const lines = (await allLines()).filter((x) => x.account_id === flow && x.status === 'unreviewed' && x.id !== id).sort(byDate);
    const after = lines.find((x) => byDate(x, l) > 0) || lines[0];
    ui.go(after ? `#/line/${after.id}?flow=${flow}` : back);
  };
  const save = async (code, member, memo) => {
    const c = CATS.get(code);
    if (!c) { document.getElementById('err').textContent = 'Choose a category.'; return; }
    if (c.member && !member) { document.getElementById('err').textContent = 'Choose which member this was.'; return; }
    await db.save({ id, type: 'statement_line', company_id: rec.company_id, data: {
      ...rec.data, status: 'reviewed',
      allocation: { splits: [{ category_code: code, amount_cents: l.amount_cents, member: member || null }], memo: memo || '', reviewed_at: new Date().toISOString() },
    } });
    next();
  };
  f.addEventListener('submit', (e) => { e.preventDefault(); save(f.elements.cat.value, f.elements.member.value, f.elements.memo.value.trim()); });
  const acc = document.getElementById('accept');
  if (acc) acc.addEventListener('click', () => save(sug.category_code, sug.member ? `member_${sug.member}` : f.elements.member.value, f.elements.memo.value.trim()));
  const ex = document.getElementById('exclude');
  if (ex) ex.addEventListener('click', async () => {
    await db.save({ id, type: 'statement_line', company_id: rec.company_id, data: { ...rec.data, status: 'excluded', allocation: null } });
    next();
  });
  const ro = document.getElementById('reopen');
  if (ro) ro.addEventListener('click', async () => {
    await db.save({ id, type: 'statement_line', company_id: rec.company_id, data: { ...rec.data, status: 'unreviewed', allocation: null } });
    lineView(id, query);
  });
}

// ---------- CSV import ----------

export async function importView(query) {
  ui.setForm(true);
  const accts = await accounts();
  ui.renderBar({ title: 'Import a statement', back: '#/' });
  const pre = query.get('account') || '';
  ui.$view.innerHTML = `
    <h1>Import a statement</h1>
    <p class="sub">Download a CSV from your bank, card or sales platform, then add it here. Lines you've already imported are skipped, so overlapping files are fine.</p>
    ${accts.length ? '' : `<div class="notice">Add an account first.</div>`}
    <div class="field"><label for="acct">Account</label><select id="acct">${accts.map((a) => `<option value="${a.id}" ${a.id === pre ? 'selected' : ''}>${ui.esc(a.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="file">CSV file</label><input id="file" type="file" accept=".csv,text/csv"></div>
    <div id="map"></div>`;
  ui.setDock('');

  document.getElementById('file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const table = parseCsv(await file.text());
    if (table.length < 2) { document.getElementById('map').innerHTML = `<div class="notice">That file has no rows. Check that it's a CSV export.</div>`; return; }
    renderMapping(file.name, table, guessMapping(table[0]));
  });

  function renderMapping(fileName, table, m) {
    const header = table[0];
    const opts = (sel) => `<option value="-1">(none)</option>` + header.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${ui.esc(h || `Column ${i + 1}`)}</option>`).join('');
    const box = document.getElementById('map');
    box.innerHTML = `
      <h2>Match the columns</h2>
      <p class="small">${table.length - 1} rows in ${ui.esc(fileName)}. Use one Amount column, or separate money-in and money-out columns.</p>
      <div class="two">
        <div class="field"><label>Date</label><select data-k="date">${opts(m.date)}</select></div>
        <div class="field"><label>Description</label><select data-k="description">${opts(m.description)}</select></div>
        <div class="field"><label>Amount</label><select data-k="amount">${opts(m.amount)}</select></div>
        <div class="field"><label>Balance (optional)</label><select data-k="balance">${opts(m.balance)}</select></div>
        <div class="field"><label>Money out (if separate)</label><select data-k="debit">${opts(m.amount >= 0 ? -1 : m.debit)}</select></div>
        <div class="field"><label>Money in (if separate)</label><select data-k="credit">${opts(m.amount >= 0 ? -1 : m.credit)}</select></div>
        <div class="field"><label>Transaction ID (optional)</label><select data-k="ref">${opts(m.ref)}</select></div>
      </div>
      <label class="check"><input type="checkbox" id="flip"> Purchases show as positive numbers in this file (common on card statements)</label>
      <section class="tape preview" id="pv"></section>
      <div id="ierr" class="err" role="alert"></div>`;
    const read = () => {
      const mm = {};
      box.querySelectorAll('select[data-k]').forEach((s) => (mm[s.dataset.k] = Number(s.value)));
      mm.flip = document.getElementById('flip').checked;
      return mm;
    };
    let pending = [];
    const preview = async () => {
      const mm = read();
      const rows = mm.date >= 0 && (mm.amount >= 0 || mm.debit >= 0 || mm.credit >= 0) ? rowsFromCsv(table, mm) : [];
      const accountId = document.getElementById('acct').value;
      const importId = `imp_csv_${Date.now()}`;
      pending = rows.length ? await buildStatementLines(rows, { accountId, companyId: ui.COMPANY, source: 'csv', importId, extra: { source_file: fileName } }) : [];
      let fresh = 0;
      for (const p of pending) if (!(await db.has(p.id))) fresh++;
      const sample = rows.slice(0, 5).map((r) => `<div class="line"><span class="k">${ui.esc(r.date)} ${ui.esc(payeeOf(r.description).slice(0, 34))}</span><span class="lead"></span><span class="v">${fmt(r.amount_cents)}</span></div>`).join('');
      document.getElementById('pv').innerHTML = rows.length
        ? `${sample}<div class="line total"><span class="k">${fresh} new, ${pending.length - fresh} already imported</span><span class="lead"></span><span class="v">${pending.length}</span></div>`
        : `<p class="small">Pick at least the Date and Amount columns.</p>`;
      ui.setDock(rows.length && fresh ? `<button class="primary" id="go">Import ${fresh} line${fresh > 1 ? 's' : ''}</button>` : '');
      const goBtn = document.getElementById('go');
      if (goBtn) goBtn.addEventListener('click', async () => {
        goBtn.disabled = true;
        const n = await db.saveMany(pending);
        await db.save({ id: importId, type: 'import', company_id: ui.COMPANY, data: { file: fileName, account_id: accountId, lines: n, imported_at: new Date().toISOString(), mapping: read() } });
        ui.go(`#/account/${accountId}?show=review`);
      });
    };
    box.addEventListener('change', preview);
    document.getElementById('acct').addEventListener('change', preview);
    preview();
  }
}
