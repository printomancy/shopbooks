// Sales tax: quarterly DR-15 walkthrough built from the books.
import * as db from './db.js';
import { fmt, parseMoney, toInput, pct } from './money.js';
import { FORM, TREATMENTS, periodInfo, salesItems, useTaxCandidates, computeReturn, efileSteps, quarterOf } from './tax/fl-dr15.js';

let ui;
export function init(ctx) { ui = ctx; }
const pid = (period) => `tax_${FORM.id}_${period}`;

async function load(period) {
  const [lineRecs, orderRecs, rec, settingsRec, accts] = await Promise.all([
    db.list('statement_line', { companyId: ui.COMPANY }), db.list('order', { companyId: ui.COMPANY }), db.get(pid(period)), db.get('settings:default'),
    db.list('account', { companyId: ui.COMPANY }),
  ]);
  const lines = lineRecs.map((r) => ({ id: r.id, ...r.data }));
  const orders = orderRecs.map((r) => ({ id: r.id, ...r.data }));
  const tp = rec && !rec.deleted ? rec.data : { form: FORM.id, period, status: 'open', overrides: {}, useTax: {}, payments: [] };
  const st = settingsRec ? settingsRec.data : {};
  const items = salesItems({ lines, orders, period });
  const useItems = useTaxCandidates({ lines, period });
  const opts = {
    stateBp: st.default_state_rate_bp ?? 600, surtaxBp: st.default_surtax_bp ?? 150,
    overrides: tp.overrides || {}, useTax: tp.useTax || {}, useTaxManualCents: tp.useTaxManualCents || 0,
    filedOn: tp.filed ? tp.filed.on : null, interestCents: tp.filed ? tp.filed.interest_cents || 0 : 0,
  };
  const ret = computeReturn({ period, items, useTaxItems: useItems, opts });
  const p = periodInfo(period);
  const unreviewed = lines.filter((l) => l.date >= p.start && l.date <= p.end && l.status === 'unreviewed');
  const acctName = Object.fromEntries(accts.map((a) => [a.id, a.data.name]));
  return { tp, items, useItems, ret, unreviewed, acctName, lines };
}
async function saveTp(period, tp) {
  await db.save({ id: pid(period), type: 'tax_period', company_id: ui.COMPANY, data: tp });
}

function statusOf(tp, p, today) {
  if (tp.status === 'filed') return { cls: 'done', text: `Filed ${ui.niceDate(tp.filed.on)}` };
  if (tp.status === 'amend') return { cls: 'warn', text: 'Needs an amended return' };
  if (today < p.start) return { cls: 'quiet', text: 'Not started' };
  if (today <= p.end) return { cls: 'quiet', text: `In progress · due ${ui.niceDate(p.due)}` };
  if (today <= p.lateAfter) return { cls: 'warn', text: `Due · late after ${ui.niceDate(p.lateAfter)}` };
  return { cls: 'warn', text: 'Late · not filed' };
}

// ---------- overview ----------

export async function taxesHome() {
  ui.setForm(false);
  ui.renderBar({ title: 'Sales tax', back: '#/' });
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const periods = [1, 2, 3, 4].map((q) => `${year}-Q${q}`);
  const rows = [];
  for (const period of periods) {
    const p = periodInfo(period);
    const { tp, ret } = await load(period);
    const s = statusOf(tp, p, today);
    const amount = tp.status === 'filed' && tp.filed.lines ? tp.filed.lines[5] : ret.lines[5];
    rows.push(`<li><a href="#/tax/${period}">
      <div class="main"><div class="name">${p.label}</div><div class="meta"><span class="chip ${s.cls}">${ui.esc(s.text)}</span></div></div>
      <div class="amt">${fmt(amount)}<small>${tp.status === 'filed' ? 'tax filed' : 'tax so far'}</small></div><span class="chev" aria-hidden="true">&rsaquo;</span></a></li>`);
  }
  ui.$view.innerHTML = `
    <h1>Florida sales tax</h1>
    <p class="sub">${ui.esc(FORM.name)}, filed quarterly. Each quarter's numbers come straight from your reviewed transactions. You confirm anything unclear, then copy the totals into eFile.</p>
    <ul class="rows">${rows.join('')}</ul>
    <p class="foot">Worksheets are for reference while you file, not the official form. Form ${ui.esc(FORM.revision)} &middot; <a href="${FORM.url}" target="_blank" rel="noopener">official PDF</a> &middot; DOR ${FORM.phone}. Not tax advice.</p>`;
  ui.setDock('');
}

// ---------- one quarter ----------

export async function periodView(period, query) {
  ui.setForm(true);
  const data = await load(period);
  const { tp, items, useItems, ret, unreviewed, acctName } = data;
  const p = ret.period, L = ret.lines;
  const today = new Date().toISOString().slice(0, 10);
  const s = statusOf(tp, p, today);
  const locked = tp.status === 'filed';
  ui.renderBar({ title: `Sales tax · ${p.label}`, back: '#/taxes' });

  const byAcct = {};
  for (const l of unreviewed) byAcct[l.account_id] = (byAcct[l.account_id] || 0) + 1;
  const groupOrder = ['taxable_included', 'taxable_collected', 'taxable_not_collected', 'exempt', 'not_sales', 'marketplace'];
  const groupTotal = (g) => ret.groups[g].reduce((t, x) => t + x.amount_cents, 0);
  const itemRow = (it) => `<li class="titem${it.review && !(tp.overrides || {})[it.key] ? ' needs' : ''}">
      <div class="main"><div class="name">${ui.esc((it.description || '').slice(0, 70))}</div>
        <div class="meta">${ui.esc(ui.niceDate(it.date))}${it.ship_state ? ` &middot; ships to ${ui.esc(it.ship_state)}` : ''}${it.tax_cents ? ` &middot; tax charged ${fmt(it.tax_cents)}` : ''}${it.review && !(tp.overrides || {})[it.key] ? ' &middot; <strong>check this</strong>' : ''}${it.unreviewed ? ' &middot; <span class="chip quiet">not reviewed</span>' : ''}</div>
        ${locked ? '' : `<select data-key="${ui.esc(it.key)}" aria-label="How to treat this sale">${Object.entries(TREATMENTS).map(([k, v]) => `<option value="${k}" ${k === it.treatment ? 'selected' : ''}>${ui.esc(v.label)}</option>`).join('')}</select>`}</div>
      <div class="amt">${fmt(it.amount_cents)}</div></li>`;

  const filedCmp = locked && tp.filed.lines ? ['A1', 'A2', 'A3', 'A4', 'B3', 'B4', '5', '12', '13', '14']
    .map((k) => `<tr><td>${k}</td><td class="num">${fmt(tp.filed.lines[k])}</td><td class="num">${fmt(L[k])}</td><td class="num ${tp.filed.lines[k] === L[k] ? '' : 'diff'}">${tp.filed.lines[k] === L[k] ? 'matches' : fmt(L[k] - tp.filed.lines[k])}</td></tr>`).join('') : '';

  ui.$view.innerHTML = `
    <h1>${p.label}</h1>
    <p class="sub">${ui.esc(ui.niceDate(p.start))} to ${ui.esc(ui.niceDate(p.end))}, ${p.start.slice(0, 4)} &middot; due ${ui.esc(ui.niceDate(p.due))}, late after ${ui.esc(ui.niceDate(p.lateAfter))} &middot; <span class="chip ${s.cls}">${ui.esc(s.text)}</span></p>

    <section class="tape" aria-label="Return totals">
      <div class="big">${fmt(locked && tp.filed.lines ? tp.filed.lines[5] : L[5])}</div>
      <div class="big-label">${locked ? `Tax filed${tp.filed.confirmation ? `, confirmation ${ui.esc(tp.filed.confirmation)}` : ''}` : 'Total tax due (line 5), from your books right now'}</div>
      <div class="line"><span class="k">Taxable sales (A3)</span><span class="lead"></span><span class="v">${fmt(L.A3)}</span></div>
      <div class="line"><span class="k">Sales tax (A4)</span><span class="lead"></span><span class="v">${fmt(L.A4)}</span></div>
      <div class="line"><span class="k">Use tax on purchases (B4)</span><span class="lead"></span><span class="v">${fmt(L.B4)}</span></div>
      ${L[12] ? `<div class="line warn"><span class="k">Late penalty (line 12)</span><span class="lead"></span><span class="v">${fmt(L[12])}</span></div>` : ''}
      ${L[11] ? `<div class="line"><span class="k">Collection allowance if on time</span><span class="lead"></span><span class="v">${fmt(-L[11])}</span></div>` : ''}
    </section>

    ${locked && filedCmp ? `<h2>Filed return vs your books today</h2>
      <div class="tblwrap"><table class="cmp"><thead><tr><th>Line</th><th class="num">Filed</th><th class="num">Books now</th><th class="num">Difference</th></tr></thead><tbody>${filedCmp}</tbody></table></div>
      <p class="small">A difference means the books have changed since you filed (new data or recategorized lines). Small ones can go on the next return. Large ones may need an amended return.</p>` : ''}

    <h2>1. Get the books ready</h2>
    ${unreviewed.length ? `<div class="notice">${unreviewed.length} transaction${unreviewed.length > 1 ? 's' : ''} in this quarter still need a category: ${Object.entries(byAcct).map(([a, n]) => `<a href="#/account/${a}?show=review">${ui.esc(acctName[a] || a)} (${n})</a>`).join(', ')}.</div>` : `<div class="okmsg">Every transaction in this quarter has a category.</div>`}
    ${ret.reviewCount ? `<div class="notice">${ret.reviewCount} sale${ret.reviewCount > 1 ? 's need' : ' needs'} your call below (marked &ldquo;check this&rdquo;).</div>` : ''}

    <h2>2. Sales (row A)</h2>
    <p class="small">Choose how each sale is treated. In-person prices include the ${pct(ret.rateBp)} tax. Etsy and Whatnot pay the tax themselves, so those sales stay off your return.</p>
    ${groupOrder.map((g) => ret.groups[g].length ? `<details ${['taxable_not_collected', 'not_sales'].includes(g) || ret.groups[g].some((i) => i.review) ? 'open' : ''}>
      <summary>${ui.esc(TREATMENTS[g].label)} &middot; ${ret.groups[g].length} &middot; ${fmt(groupTotal(g))}</summary>
      <ul class="rows">${ret.groups[g].sort((a, b) => a.date.localeCompare(b.date)).map(itemRow).join('')}</ul></details>` : '').join('')}

    <h2>3. Use tax on purchases (row B)</h2>
    <p class="small">Items bought without Florida tax (for example on your resale certificate) but used in the business rather than resold owe use tax. Tick the ones that apply.</p>
    ${useItems.length ? `<ul class="rows">${useItems.map((u) => `<li><label class="row check-row"><input type="checkbox" data-use="${ui.esc(u.key)}" ${((tp.useTax || {})[u.key] ?? u.flagged) ? 'checked' : ''} ${locked ? 'disabled' : ''}>
      <div class="main"><div class="name">${ui.esc(u.description.slice(0, 60))}</div><div class="meta">${ui.esc(ui.niceDate(u.date))}</div></div><div class="amt">${fmt(u.amount_cents)}</div></label></li>`).join('')}</ul>` : '<p class="small">No likely items this quarter.</p>'}
    <div class="field"><label for="usem">Other untaxed purchases used in the business (total)</label><div class="money-wrap"><input class="money" id="usem" inputmode="decimal" value="${ui.esc(toInput(tp.useTaxManualCents || 0))}" ${locked ? 'disabled' : ''}></div>
      <div class="hint">For purchases not itemized above, such as the Amazon items you marked as used.</div></div>

    <h2>4. The return</h2>
    ${worksheetTable(ret)}
    <div class="actions"><button type="button" id="print">Print worksheet</button></div>

    <h2>5. File in eFile</h2>
    <ol class="steps">${efileSteps(ret, { certificate: '4178-8' }).map((st) => `<li><strong>${ui.esc(st.title)}</strong><div>${ui.esc(st.body)}</div></li>`).join('')}</ol>
    <p class="small"><a href="${FORM.efile}" target="_blank" rel="noopener">Open Florida eServices</a></p>

    <h2>6. Record the filing</h2>
    ${locked ? `<div class="okmsg">Filed ${ui.esc(ui.niceDate(tp.filed.on))}${tp.filed.confirmation ? ` &middot; confirmation ${ui.esc(tp.filed.confirmation)}` : ''} &middot; paid ${fmt(tp.filed.paid_cents)}.</div>
      <div class="actions"><button type="button" class="quiet" id="unlock">Reopen this quarter (for an amended return)</button></div>` : `
    <form id="ff" novalidate>
      <div class="two">
        <div class="field"><label for="fon">Date filed</label><input id="fon" type="date" value="${today}"></div>
        <div class="field"><label for="fconf">Confirmation number</label><input id="fconf" inputmode="numeric"></div>
        <div class="field"><label for="fpaid">Amount paid</label><div class="money-wrap"><input class="money" id="fpaid" inputmode="decimal" value="${ui.esc(toInput(L[14]))}"></div></div>
        <div class="field"><label for="fint">Interest eFile charged</label><div class="money-wrap"><input class="money" id="fint" inputmode="decimal" placeholder="0.00"></div></div>
      </div>
      <div id="ferr" class="err" role="alert"></div>
      <div class="actions"><button class="primary" type="submit">Save filing and lock ${p.label}</button></div>
    </form>`}

    ${(tp.payments || []).length ? `<h2>Payments to DOR</h2><ul class="rows">${tp.payments.map((x) => `<li><div class="row"><div class="main"><div class="name">${ui.esc(ui.niceDate(x.date))} &middot; ${ui.esc(x.confirmation || '')}</div>
      <div class="meta">${x.posted_period && x.posted_period !== p.end ? `<span class="chip warn">DOR posted it to period ending ${ui.esc(x.posted_period)}</span>` : 'Posted to this quarter'}${x.note ? ` &middot; ${ui.esc(x.note)}` : ''}</div></div><div class="amt">${fmt(x.amount_cents)}</div></div></li>`).join('')}</ul>` : ''}
    ${tp.notes ? `<h2>Notes</h2><p class="small">${ui.esc(tp.notes)}</p>` : ''}
    <p class="foot">Worksheet for reference while filing; not the official return. Not tax advice.</p>`;
  ui.setDock('');

  const v = ui.$view;
  v.querySelectorAll('select[data-key]').forEach((sel) => sel.addEventListener('change', async () => {
    const next = { ...tp, overrides: { ...(tp.overrides || {}) } };
    const it = items.find((i) => i.key === sel.dataset.key);
    if (it && sel.value === it.default && !it.review) delete next.overrides[sel.dataset.key]; else next.overrides[sel.dataset.key] = sel.value;
    await saveTp(period, next);
    periodView(period, query);
  }));
  v.querySelectorAll('input[data-use]').forEach((cb) => cb.addEventListener('change', async () => {
    await saveTp(period, { ...tp, useTax: { ...(tp.useTax || {}), [cb.dataset.use]: cb.checked } });
    periodView(period, query);
  }));
  const usem = document.getElementById('usem');
  if (usem && !locked) usem.addEventListener('change', async () => {
    const c = parseMoney(usem.value);
    if (Number.isNaN(c)) return;
    await saveTp(period, { ...tp, useTaxManualCents: c || 0 });
    periodView(period, query);
  });
  document.getElementById('print').addEventListener('click', () => window.print());
  const ff = document.getElementById('ff');
  if (ff) ff.addEventListener('submit', async (e) => {
    e.preventDefault();
    const paid = parseMoney(document.getElementById('fpaid').value), interest = parseMoney(document.getElementById('fint').value) || 0;
    if (!document.getElementById('fon').value || paid === null || Number.isNaN(paid) || Number.isNaN(interest)) { document.getElementById('ferr').textContent = 'Enter the date filed and the amount paid.'; return; }
    const filedOn = document.getElementById('fon').value;
    const final = computeReturn({ period, items, useTaxItems: useItems, opts: { overrides: tp.overrides, useTax: tp.useTax, useTaxManualCents: tp.useTaxManualCents, filedOn, interestCents: interest } });
    await saveTp(period, { ...tp, status: 'filed', filed: { on: filedOn, confirmation: document.getElementById('fconf').value.trim(), paid_cents: paid, interest_cents: interest, lines: final.lines } });
    periodView(period, query);
  });
  const un = document.getElementById('unlock');
  if (un) un.addEventListener('click', async () => {
    if (!confirm(`Reopen ${p.label}? The filed numbers are kept for comparison.`)) return;
    await saveTp(period, { ...tp, status: 'amend', original_filing: tp.filed });
    periodView(period, query);
  });
}

function worksheetTable(ret) {
  const L = ret.lines;
  const r = (label, a, b, c, d) => `<tr><th scope="row">${label}</th><td class="num">${a === null ? '' : fmt(a)}</td><td class="num">${b === null ? '' : fmt(b)}</td><td class="num">${c === null ? '' : fmt(c)}</td><td class="num">${d === null ? '' : fmt(d)}</td></tr>`;
  const s = (label, v) => `<tr><th scope="row" colspan="4">${label}</th><td class="num">${fmt(v)}</td></tr>`;
  return `<div class="worksheet">
    <div class="wm" aria-hidden="true">WORKSHEET · NOT FOR FILING</div>
    <div class="ws-head"><strong>DR-15 ${ui.esc(FORM.revision)}</strong> &middot; ${ret.period.label} (${ret.period.start} to ${ret.period.end}) &middot; Printomancy LLC &middot; certificate ending 4178-8</div>
    <div class="tblwrap"><table class="dr15">
      <thead><tr><th></th><th class="num">1. Gross sales</th><th class="num">2. Exempt sales</th><th class="num">3. Taxable amount</th><th class="num">4. Tax due</th></tr></thead>
      <tbody>
        ${r('A. Sales/services', L.A1, L.A2, L.A3, L.A4)}
        ${r('B. Taxable purchases', null, null, L.B3, L.B4)}
        ${r('C. Commercial rentals', 0, 0, 0, 0)}
        ${r('D. Transient rentals', 0, 0, 0, 0)}
        ${r('E. Food &amp; beverage vending', 0, 0, 0, 0)}
        ${s('5. Total amount of tax due', L[5])}
        ${s('6. Less lawful deductions', L[6])}
        ${s('7. Net tax due', L[7])}
        ${s('8. Less est tax pd / DOR credit memo', L[8])}
        ${s('9. Plus est tax due current month', L[9])}
        ${s('10. Amount due', L[10])}
        ${s('11. Less collection allowance', L[11])}
        ${s('12. Plus penalty', L[12])}
        ${s('13. Plus interest', L[13])}
        ${s('14. Amount due with return', L[14])}
        ${s('15(a). Exempt amount of items over $5,000', L['15a'])}
        ${s('15(b). Other taxable amounts not subject to surtax', L['15b'])}
        ${s('15(c). Amounts subject to a different surtax rate', L['15c'])}
        ${s('15(d). Total discretionary sales surtax due', L['15d'])}
      </tbody></table></div></div>`;
}

export async function homeSection() {
  const today = new Date().toISOString().slice(0, 10);
  const period = quarterOf(today);
  const prev = (() => { const [y, q] = period.split('-Q').map(Number); return q === 1 ? `${y - 1}-Q4` : `${y}-Q${q - 1}`; })();
  const { tp: tpPrev, ret: retPrev } = await load(prev);
  const { ret } = await load(period);
  const pp = periodInfo(prev);
  const prevOpen = tpPrev.status !== 'filed';
  return `<h2>Sales tax</h2>
    <ul class="rows">
      ${prevOpen ? `<li><a href="#/tax/${prev}"><div class="main"><div class="name">${pp.label} return</div><div class="meta"><span class="chip warn">${today > pp.lateAfter ? 'Late, not filed' : `Due, late after ${ui.esc(ui.niceDate(pp.lateAfter))}`}</span></div></div><div class="amt">${fmt(retPrev.lines[5])}</div><span class="chev" aria-hidden="true">&rsaquo;</span></a></li>` : ''}
      <li><a href="#/tax/${period}"><div class="main"><div class="name">${ret.period.label} so far</div><div class="meta">Due ${ui.esc(ui.niceDate(ret.period.due))}, late after ${ui.esc(ui.niceDate(ret.period.lateAfter))}</div></div><div class="amt">${fmt(ret.lines[5])}</div><span class="chev" aria-hidden="true">&rsaquo;</span></a></li>
    </ul>
    <div class="actions"><a class="btn btn-quiet" href="#/taxes">All quarters</a></div>`;
}
