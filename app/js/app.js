// Shopbooks app: routing and screens. Phase 0 = event sales log.
import * as db from './db.js';
import * as sync from './sync.js';
import { parseMoney, fmt, toInput, pct, splitTaxIncluded, summarizeEvent, DENOMINATIONS } from './money.js';
import * as books from './books.js';
import * as taxes from './taxes.js';
import * as inventory from './inventory.js';
import { summarizeItemSales } from './inventory/stock.js';
import { eventLines, cardCheck } from './ledger/events.js';

const APP_VERSION = '0.6.0';
const COMPANY = 'default'; // one company for now; multi-company comes with the ledger
const SETTINGS_ID = 'settings:default';

const $view = document.getElementById('view');
const $bar = document.getElementById('bar');
const $dock = document.getElementById('dock');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function niceDate(iso, { weekday = false } = {}) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const wd = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday ? wd + ', ' : ''}${MONTHS[m - 1]} ${d}`;
}
function dateRange(a, b) {
  if (!a) return '';
  if (!b || a === b) return niceDate(a);
  return `${niceDate(a)} to ${niceDate(b)}${a.slice(0, 4) !== today().slice(0, 4) ? ', ' + a.slice(0, 4) : ''}`;
}
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const bpFromPct = (s) => {
  const v = Number(String(s).replace('%', ''));
  return Number.isFinite(v) ? Math.round(v * 100) : 0;
};
function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return niceDate(iso.slice(0, 10));
}

// ---------- data access ----------

async function getSettings() {
  const rec = await db.get(SETTINGS_ID);
  return {
    business_name: '',
    default_state_rate_bp: 600,
    default_surtax_bp: 150,
    deposit_accounts: ['Business checking', 'Business savings'],
    ...(rec && !rec.deleted ? rec.data : {}),
  };
}
const saveSettings = (data) => db.save({ id: SETTINGS_ID, type: 'settings', company_id: COMPANY, data });

async function getEvent(id) {
  const r = await db.get(id);
  return r && !r.deleted && r.type === 'event' ? { id: r.id, ...r.data } : null;
}
async function eventChildren(eventId) {
  const [days, deps] = await Promise.all([db.list('event_day', { companyId: COMPANY }), db.list('event_deposit', { companyId: COMPANY })]);
  return {
    days: days.filter((d) => d.data.event_id === eventId).map((d) => ({ id: d.id, ...d.data })),
    deposits: deps.filter((d) => d.data.event_id === eventId).map((d) => ({ id: d.id, ...d.data })).sort((a, b) => (a.date || '').localeCompare(b.date || '')),
  };
}

// ---------- event -> books ----------

async function cashAccountId() {
  const accts = await db.list('account', { companyId: COMPANY });
  const cash = accts.find((a) => a.data.kind === 'cash' && a.data.active !== false);
  if (cash) return cash.id;
  const rec = await db.save({ id: 'acct_cash', type: 'account', company_id: COMPANY, data: { name: 'Cash box', kind: 'cash', institution: '', mask: '', active: true } });
  return rec.id;
}

// Bring the books in line with the event log: add/update derived lines, remove stale ones.
async function postEvent(eventId) {
  const all = await db.list('statement_line', { companyId: COMPANY });
  const existing = all.filter((l) => l.data.event && l.data.event.event_id === eventId);
  const e = await getEvent(eventId);
  if (!e) { for (const l of existing) await db.remove(l.id); return; }
  const { days, deposits } = await eventChildren(eventId);
  const want = eventLines({ event: e, days, deposits, cashAccountId: await cashAccountId(), companyId: COMPANY });
  const byId = new Map(existing.map((l) => [l.id, l]));
  const writes = [];
  for (const w of want) {
    const cur = byId.get(w.id);
    // Keep the category you chose for cash paid out or the float, as long as the amount hasn't changed.
    if (cur && cur.data.status !== 'unreviewed' && (w.data.status === 'unreviewed' || w.id.endsWith('_float')) && cur.data.amount_cents === w.data.amount_cents) {
      w.data = { ...w.data, status: cur.data.status, allocation: cur.data.allocation, suggestion: cur.data.suggestion };
    }
    writes.push(w);
  }
  if (writes.length) await db.saveMany(writes);
  const keep = new Set(want.map((w) => w.id));
  for (const l of existing) if (!keep.has(l.id)) await db.remove(l.id);
}

// ---------- chrome ----------

let syncStatus = {};
function syncLabel(s) {
  if (!s.signedIn) return { state: 'idle', text: 'On this device only' };
  if (s.state === 'syncing') return { state: 'syncing', text: 'Syncing' };
  if (s.state === 'offline' || !navigator.onLine) return { state: 'pending', text: s.pending ? `Offline, ${s.pending} to sync` : 'Offline' };
  if (s.state === 'error') return { state: 'error', text: 'Sync problem' };
  if (s.pending) return { state: 'pending', text: `${s.pending} to sync` };
  return { state: 'ok', text: `Synced ${timeAgo(s.lastSync)}` };
}
function renderBar({ title, back }) {
  const l = syncLabel(syncStatus);
  $bar.innerHTML = `
    ${back ? `<a class="back" href="${back}" aria-label="Back">&larr; Back</a>` : ''}
    <div class="title">${esc(title)}</div>
    <a class="sync" href="#/settings" data-state="${l.state}"><span class="dot" aria-hidden="true"></span>${esc(l.text)}</a>`;
}
function setDock(html) {
  $dock.innerHTML = html ? `<div class="dock"><div class="wrap">${html}</div></div>` : '';
}

// ---------- router ----------

const routes = [
  [/^#?\/?$/, homeView],
  [/^#\/event\/new$/, (m) => eventFormView(null)],
  [/^#\/event\/([\w-]+)\/edit$/, (m) => eventFormView(m[1])],
  [/^#\/event\/([\w-]+)\/day\/new$/, (m) => dayFormView(m[1], null)],
  [/^#\/event\/([\w-]+)\/day\/([\w-]+)$/, (m) => dayFormView(m[1], m[2])],
  [/^#\/event\/([\w-]+)\/sell$/, (m) => inventory.sellView(m[1])],
  [/^#\/event\/([\w-]+)\/deposit\/new$/, (m) => depositFormView(m[1], null)],
  [/^#\/event\/([\w-]+)\/deposit\/([\w-]+)$/, (m) => depositFormView(m[1], m[2])],
  [/^#\/event\/([\w-]+)$/, (m) => eventView(m[1])],
  [/^#\/settings$/, settingsView],
  [/^#\/inventory$/, (m, q) => inventory.inventoryView(q)],
  [/^#\/inventory\/load$/, () => inventory.loadView()],
  [/^#\/account\/([\w-]+)$/, (m, q) => books.accountView(m[1], q)],
  [/^#\/line\/([\w-]+)$/, (m, q) => books.lineView(m[1], q)],
  [/^#\/import$/, (m, q) => books.importView(q)],
  [/^#\/rules$/, () => books.rulesView()],
  [/^#\/taxes$/, () => taxes.taxesHome()],
  [/^#\/tax\/(\d{4}-Q[1-4])$/, (m, q) => taxes.periodView(m[1], q)],
];

let currentIsForm = false;
async function route() {
  const hash = location.hash || '#/';
  const [path, qs] = hash.split('?');
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      currentIsForm = false;
      setDock('');
      await fn(m, new URLSearchParams(qs || ''));
      return;
    }
  }
  location.hash = '#/';
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

// ---------- home ----------

async function homeView() {
  const settings = await getSettings();
  renderBar({ title: settings.business_name || 'Shopbooks' });
  const events = (await db.list('event', { companyId: COMPANY })).map((e) => ({ id: e.id, ...e.data }));
  const t = today();
  events.sort((a, b) => {
    const rank = (e) => (e.start_date <= t && (e.end_date || e.start_date) >= t ? 0 : e.start_date > t ? 1 : 2);
    return rank(a) - rank(b) || (rank(a) === 2 ? b.start_date.localeCompare(a.start_date) : a.start_date.localeCompare(b.start_date));
  });

  const rows = [];
  for (const e of events) {
    const { days, deposits } = await eventChildren(e.id);
    const s = summarizeEvent(e, days, deposits);
    const live = e.start_date <= t && (e.end_date || e.start_date) >= t;
    rows.push(`<li><a href="#/event/${e.id}">
      <div class="main"><div class="name">${esc(e.name)}</div>
        <div class="meta">${esc(dateRange(e.start_date, e.end_date))}${e.county ? ' in ' + esc(e.county) : ''}${live ? ' &middot; happening now' : ''}</div></div>
      <div class="amt">${days.length ? fmt(s.totals.gross) : ''}<small>${days.length ? `${days.length} day${days.length > 1 ? 's' : ''} logged` : 'Nothing logged'}</small></div>
      <span class="chev" aria-hidden="true">&rsaquo;</span></a></li>`);
  }

  const booksHtml = await books.accountsSection();
  const taxHtml = await taxes.homeSection();
  const invHtml = await inventory.homeSection();
  $view.innerHTML = `
    <h1>${esc(settings.business_name || 'Shopbooks')}</h1>
    ${booksHtml}
    ${taxHtml}
    <h2>Events</h2>
    <p class="sub">Markets, fairs and pop-ups. Log cash and card sales each day; the totals and sales tax add themselves up.</p>
    ${rows.length ? `<ul class="rows">${rows.join('')}</ul>` : `
      <div class="empty"><strong>No events yet</strong>Add the next market or fair you're working. You can log your opening cash float now and each day's sales as you go.</div>`}
    ${invHtml}
    ${!settings.business_name ? `<div class="notice">Add your business name in <a href="#/settings">Settings</a>.</div>` : ''}
    <p class="foot">Shopbooks ${APP_VERSION} &middot; <a href="#/settings">Settings and sync</a></p>`;
  setDock(`<a class="btn btn-primary" href="#/event/new">Add event</a>`);
}

// ---------- event form ----------

async function eventFormView(id) {
  currentIsForm = true;
  const settings = await getSettings();
  const e = id ? await getEvent(id) : null;
  if (id && !e) return go('#/');
  const v = e || {
    name: '', start_date: today(), end_date: today(), county: '',
    state_rate_bp: settings.default_state_rate_bp, surtax_bp: settings.default_surtax_bp,
    booth_fee_cents: null, opening_float_cents: null, notes: '',
  };
  renderBar({ title: e ? 'Edit event' : 'New event', back: e ? `#/event/${id}` : '#/' });
  $view.innerHTML = `
    <form id="f" novalidate>
      <div class="field"><label for="name">Event name</label><input id="name" name="name" required value="${esc(v.name)}" placeholder="Jacksonville Fair"></div>
      <div class="two">
        <div class="field"><label for="start">First day</label><input id="start" name="start_date" type="date" required value="${esc(v.start_date)}"></div>
        <div class="field"><label for="end">Last day</label><input id="end" name="end_date" type="date" value="${esc(v.end_date)}"></div>
      </div>
      <div class="field"><label for="county">County</label><input id="county" name="county" value="${esc(v.county)}" placeholder="Duval"><div class="hint">Sets which local surtax applies.</div></div>
      <div class="two">
        <div class="field"><label for="srate">State tax %</label><input id="srate" name="state_rate" inputmode="decimal" value="${esc(v.state_rate_bp / 100)}"></div>
        <div class="field"><label for="surtax">Local surtax %</label><input id="surtax" name="surtax" inputmode="decimal" value="${esc(v.surtax_bp / 100)}"></div>
      </div>
      <div class="field"><label for="float">Opening cash float</label><div class="money-wrap"><input class="money" id="float" name="opening_float" inputmode="decimal" value="${esc(toInput(v.opening_float_cents))}" placeholder="0.00"></div>
        <div class="hint">Cash you put in the box to make change. It isn't income, and it's subtracted before cash sales are counted.</div></div>
      <div class="field"><label for="booth">Booth fee</label><div class="money-wrap"><input class="money" id="booth" name="booth_fee" inputmode="decimal" value="${esc(toInput(v.booth_fee_cents))}" placeholder="0.00"></div></div>
      <div class="field"><label for="notes">Notes</label><textarea id="notes" name="notes">${esc(v.notes)}</textarea></div>
      <div id="err" class="err" role="alert"></div>
      ${e ? `<div class="actions"><button type="button" class="danger" id="del">Delete event</button></div>` : ''}
    </form>`;
  setDock(`<a class="btn" href="${e ? `#/event/${id}` : '#/'}">Cancel</a><button class="primary" form="f" type="submit">Save event</button>`);

  document.getElementById('f').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const name = String(fd.get('name')).trim();
    const start = String(fd.get('start_date'));
    const end = String(fd.get('end_date')) || start;
    const flt = parseMoney(fd.get('opening_float'));
    const booth = parseMoney(fd.get('booth_fee'));
    const err = !name ? 'Give the event a name.' : !start ? 'Pick the first day.' : end < start ? 'The last day is before the first day.'
      : Number.isNaN(flt) || Number.isNaN(booth) ? 'Money amounts should look like 150 or 150.00.' : '';
    if (err) { document.getElementById('err').textContent = err; return; }
    const rec = await db.save({
      id: e ? e.id : undefined, type: 'event', company_id: COMPANY,
      data: { name, start_date: start, end_date: end, county: String(fd.get('county')).trim(),
        state_rate_bp: bpFromPct(fd.get('state_rate')), surtax_bp: bpFromPct(fd.get('surtax')),
        opening_float_cents: flt, booth_fee_cents: booth, notes: String(fd.get('notes')) },
    });
    await postEvent(rec.id);
    go(`#/event/${rec.id}`);
  });
  const del = document.getElementById('del');
  if (del) del.addEventListener('click', async () => {
    const { days, deposits } = await eventChildren(id);
    if (!confirm(`Delete ${e.name}${days.length ? ` and its ${days.length} logged day${days.length > 1 ? 's' : ''}` : ''}? This can't be undone.`)) return;
    for (const d of [...days, ...deposits]) await db.remove(d.id);
    await db.remove(id);
    await postEvent(id); // removes the cash-box lines this event added
    go('#/');
  });
}

// ---------- event detail ----------

async function eventView(id) {
  const e = await getEvent(id);
  if (!e) return go('#/');
  const { days, deposits } = await eventChildren(id);
  const s = summarizeEvent(e, days, deposits);
  renderBar({ title: e.name, back: '#/' });

  const t = s.totals, c = s.cash;
  const [lineRecs, acctRecs] = await Promise.all([db.list('statement_line', { companyId: COMPANY }), db.list('account', { companyId: COMPANY })]);
  const allLines = lineRecs.map((r) => ({ id: r.id, ...r.data }));
  const posted = allLines.filter((l) => l.event && l.event.event_id === id);
  const postedCash = posted.filter((l) => l.allocation && l.allocation.splits.some((x) => x.category_code === '4000')).reduce((x, l) => x + l.amount_cents, 0);
  const paidOutToReview = posted.filter((l) => l.status === 'unreviewed').length;
  const pp = cardCheck({ event: e, days, lines: allLines, accountsById: Object.fromEntries(acctRecs.map((a) => [a.id, a.data])) });
  const ppNote = !pp.logged && !pp.inBooks ? 'No PayPal sales logged or in the PayPal account yet.'
    : !pp.inBooks ? `You logged ${fmt(pp.logged)} in PayPal sales. They'll show here once PayPal activity for these dates is imported.`
    : Math.abs(pp.difference) <= 100 ? `PayPal account shows ${fmt(pp.inBooks)} for these dates, matching what you logged.`
    : `PayPal account shows ${fmt(pp.inBooks)} for these dates; you logged ${fmt(pp.logged)} (${pp.difference > 0 ? 'more' : 'less'} by ${fmt(Math.abs(pp.difference))}). Check for a missed day or a refund.`;
  const dayRows = s.days.map((d) => `<li><a href="#/event/${id}/day/${d.id}">
      <div class="main"><div class="name">${esc(niceDate(d.date, { weekday: true }))}</div>
        <div class="meta">${d.cashSales === null ? '<span class="tag">Cash not counted</span>' : `Cash ${fmt(d.cashSales)} &middot; Card ${fmt(d.card)}`}</div></div>
      <div class="amt">${fmt(d.gross)}<small>tax ${fmt(d.tax)}</small></div><span class="chev" aria-hidden="true">&rsaquo;</span></a></li>`).join('');
  const depRows = deposits.map((d) => `<li><a href="#/event/${id}/deposit/${d.id}">
      <div class="main"><div class="name">${esc(niceDate(d.date))}</div><div class="meta">${esc(d.account || 'Deposit')}${d.note ? ' &middot; ' + esc(d.note) : ''}</div></div>
      <div class="amt">${fmt(d.amount_cents)}</div><span class="chev" aria-hidden="true">&rsaquo;</span></a></li>`).join('');

  const itemsHtml = await inventory.eventSection(e, s.days);
  $view.innerHTML = `
    <h1>${esc(e.name)}</h1>
    <p class="sub">${esc(dateRange(e.start_date, e.end_date))}${e.county ? ` &middot; ${esc(e.county)} County` : ''} &middot; ${pct(s.rateBp)} tax included in prices</p>

    <section class="tape" aria-label="Sales totals">
      <div class="big">${fmt(t.gross)}</div>
      <div class="big-label">Total sales, tax included${t.daysOpen ? ` &middot; ${t.daysOpen} day${t.daysOpen > 1 ? 's' : ''} not counted yet` : ''}</div>
      <div class="line"><span class="k">Cash sales</span><span class="lead"></span><span class="v">${fmt(t.cashSales)}</span></div>
      <div class="line"><span class="k">Card sales (PayPal and others)</span><span class="lead"></span><span class="v">${fmt(t.cardSales)}</span></div>
      <div class="line total"><span class="k">Sales before tax</span><span class="lead"></span><span class="v">${fmt(t.taxable)}</span></div>
      <div class="line"><span class="k">Sales tax collected (${pct(s.rateBp)})</span><span class="lead"></span><span class="v">${fmt(t.tax)}</span></div>
      ${t.boothFee ? `<div class="line muted"><span class="k">Booth fee</span><span class="lead"></span><span class="v">${fmt(-t.boothFee)}</span></div>` : ''}
      ${t.paidOut ? `<div class="line muted"><span class="k">Paid out of the cash box</span><span class="lead"></span><span class="v">${fmt(-t.paidOut)}</span></div>` : ''}
    </section>

    <h2>Days</h2>
    ${dayRows ? `<ul class="rows">${dayRows}</ul>` : `<div class="empty"><strong>No days logged</strong>At closing, count the cash box and enter the PayPal total for the day.</div>`}

    ${itemsHtml}

    <h2>Cash box</h2>
    <section class="tape" aria-label="Cash box reconciliation">
      <div class="line"><span class="k">Opening float</span><span class="lead"></span><span class="v">${fmt(c.float)}</span></div>
      <div class="line"><span class="k">Cash sales</span><span class="lead"></span><span class="v">${fmt(c.cashSales)}</span></div>
      ${c.paidOut ? `<div class="line"><span class="k">Paid out of the box</span><span class="lead"></span><span class="v">${fmt(-c.paidOut)}</span></div>` : ''}
      <div class="line total"><span class="k">Cash to deposit or keep</span><span class="lead"></span><span class="v">${fmt(c.toAccountFor)}</span></div>
      <div class="line"><span class="k">Deposited</span><span class="lead"></span><span class="v">${fmt(c.deposited)}</span></div>
      <div class="line ${c.notDeposited > 0 ? 'warn' : ''}"><span class="k">${c.notDeposited >= 0 ? 'Not deposited yet' : 'Deposited more than counted'}</span><span class="lead"></span><span class="v">${fmt(Math.abs(c.notDeposited))}</span></div>
    </section>
    ${c.deposited ? `<p class="small">Of the deposits, ${fmt(c.floatPortionOfDeposits)} is your float coming back (not income) and ${fmt(c.salesPortionOfDeposits)} is cash sales.</p>` : ''}
    ${depRows ? `<ul class="rows">${depRows}</ul>` : ''}
    <div class="actions"><a class="btn" href="#/event/${id}/deposit/new">Record a deposit</a></div>

    <h2>In your books</h2>
    <section class="tape" aria-label="Posted to the books">
      <div class="line"><span class="k">Cash sales posted to the Cash box</span><span class="lead"></span><span class="v">${fmt(postedCash)}</span></div>
      <div class="line muted"><span class="k">Sales tax inside them (on your DR-15)</span><span class="lead"></span><span class="v">${fmt(postedCash - Math.round((postedCash * 10000) / (10000 + s.rateBp)))}</span></div>
    </section>
    <p class="small">${esc(ppNote)}${paidOutToReview ? ` ${paidOutToReview} cash payout${paidOutToReview > 1 ? 's' : ''} from the box need${paidOutToReview > 1 ? '' : 's'} a category in <a href="#/account/acct_cash?show=review">Cash box</a>.` : ''}</p>

    <div class="actions">
      <button type="button" class="quiet" id="csv">Download as spreadsheet (CSV)</button>
      <a class="btn btn-quiet" href="#/event/${id}/edit">Edit event details</a>
    </div>`;
  setDock(`<a class="btn btn-primary" href="#/event/${id}/sell">Sell items</a><a class="btn" href="#/event/${id}/day/new">Close out a day</a>`);

  inventory.wireEventSection(e);
  document.getElementById('csv').addEventListener('click', async () => downloadEventCsv(e, s, deposits, await inventory.itemSales(id)));
}

function downloadEventCsv(e, s, deposits, sales = []) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const d2 = (c) => (c === null || c === undefined ? '' : (c / 100).toFixed(2));
  const lines = [
    ['Event', e.name], ['Dates', `${e.start_date} to ${e.end_date}`], ['County', e.county], ['Tax rate', pct(s.rateBp)], [],
    ['Date', 'Opening cash', 'Closing cash', 'Paid out', 'Cash sales', 'PayPal', 'Other card', 'Total sales (tax incl.)', 'Sales before tax', 'Sales tax', 'Notes'],
    ...s.days.map((d) => [d.date, d2(d.opening), d2(d.closing_cash_cents), d2(d.cash_paid_out_cents), d2(d.cashSales), d2(d.paypal_cents), d2(d.other_card_cents), d2(d.gross), d2(d.taxable), d2(d.tax), d.notes]),
    ['Total', '', '', d2(s.totals.paidOut), d2(s.totals.cashSales), '', '', d2(s.totals.gross), d2(s.totals.taxable), d2(s.totals.tax)], [],
    ['Deposits'], ['Date', 'Account', 'Amount', 'Note'],
    ...deposits.map((d) => [d.date, d.account, d2(d.amount_cents), d.note]),
    ['Opening float', '', d2(s.cash.float)], ['Not deposited yet', '', d2(s.cash.notDeposited)],
  ];
  const live = sales.filter((x) => !x.deleted).sort((a, b) => (a.sold_at || '').localeCompare(b.sold_at || ''));
  if (live.length) {
    const it = summarizeItemSales(live);
    lines.push([], ['Items sold'], ['Date', 'Product', 'Qty', 'Price each', 'Total', 'Paid by'],
      ...live.map((x) => [x.date, x.name, x.qty, d2(x.price_cents), d2(x.qty * x.price_cents), x.method === 'cash' ? 'Cash' : 'Card']),
      ['Total', '', it.units, '', d2(it.gross)]);
  }
  const csv = lines.map((r) => r.map(q).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `${e.name.replace(/[^\w-]+/g, '_')}_${e.start_date}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- day form ----------

async function dayFormView(eventId, dayId) {
  currentIsForm = true;
  const e = await getEvent(eventId);
  if (!e) return go('#/');
  const { days, deposits } = await eventChildren(eventId);
  const existing = dayId ? days.find((d) => d.id === dayId) : null;
  if (dayId && !existing) return go(`#/event/${eventId}`);

  const t = today();
  const lastDate = days.map((d) => d.date).sort().pop();
  const defaultDate = t >= e.start_date && t <= (e.end_date || e.start_date) && !days.some((d) => d.date === t) ? t
    : lastDate ? addDays(lastDate, 1) : e.start_date;
  const v = existing || { date: defaultDate, opening_cash_cents: null, closing_cash_cents: null, paypal_cents: null, other_card_cents: null,
    other_card_label: '', cash_paid_out_cents: null, paid_out_note: '', cash_removed_cents: null, counts: {}, notes: '' };

  const rateBp = (e.state_rate_bp || 0) + (e.surtax_bp || 0);
  // What would carry into this day if opening is left blank.
  const carryFor = (date) => {
    const others = days.filter((d) => d.id !== dayId && d.date < date);
    const s = summarizeEvent(e, [...others, { date, closing_cash_cents: 0 }], []);
    return s.days[s.days.length - 1].opening;
  };

  const tapped = {}; // item sales tapped per date, shown as a check while closing out
  for (const x of await inventory.itemSales(eventId)) {
    const t0 = (tapped[x.date] ||= { cash: 0, card: 0, units: 0 });
    t0[x.method === 'cash' ? 'cash' : 'card'] += x.qty * x.price_cents;
    t0.units += x.qty;
  }
  renderBar({ title: existing ? niceDate(existing.date, { weekday: true }) : 'Close out a day', back: `#/event/${eventId}` });
  $view.innerHTML = `
    <form id="f" novalidate>
      <div class="field"><label for="date">Day</label><input id="date" name="date" type="date" required value="${esc(v.date)}"></div>

      <div class="field"><label for="opening">Cash in the box at opening</label>
        <div class="money-wrap"><input class="money" id="opening" name="opening" inputmode="decimal" value="${esc(toInput(v.opening_cash_cents))}" placeholder=""></div>
        <div class="hint" id="carryHint"></div></div>

      <div class="field"><label for="closing">Cash in the box at closing</label>
        <div class="money-wrap"><input class="money" id="closing" name="closing" inputmode="decimal" value="${esc(toInput(v.closing_cash_cents))}" placeholder="0.00"></div>
        <button type="button" class="quiet" id="countToggle" aria-expanded="false">Count bills and coins</button>
        <div class="counter" id="counter" hidden>
          <div class="grid">${DENOMINATIONS.map((d) => `<label class="den"><span>${d.label}</span><input type="number" min="0" inputmode="numeric" data-cents="${d.cents}" value="${esc((v.counts || {})[d.cents] ?? '')}" aria-label="Number of ${d.label}"></label>`).join('')}</div>
          <div class="sum"><span>Counted <strong id="countSum">$0.00</strong></span><button type="button" id="useCount">Use this total</button></div>
        </div></div>

      <div class="two">
        <div class="field"><label for="paypal">PayPal sales</label><div class="money-wrap"><input class="money" id="paypal" name="paypal" inputmode="decimal" value="${esc(toInput(v.paypal_cents))}" placeholder="0.00"></div>
          <div class="hint">Day's total from the PayPal app, before fees.</div></div>
        <div class="field"><label for="other">Other card sales</label><div class="money-wrap"><input class="money" id="other" name="other" inputmode="decimal" value="${esc(toInput(v.other_card_cents))}" placeholder="0.00"></div>
          <div class="hint">Square, Cash App, Venmo.</div></div>
      </div>

      <details ${v.cash_paid_out_cents || v.cash_removed_cents ? 'open' : ''}>
        <summary>Cash taken out of the box</summary>
        <div class="field"><label for="paidout">Spent from the box on business costs</label><div class="money-wrap"><input class="money" id="paidout" name="paidout" inputmode="decimal" value="${esc(toInput(v.cash_paid_out_cents))}" placeholder="0.00"></div>
          <input id="paidnote" name="paid_out_note" value="${esc(v.paid_out_note)}" placeholder="What it was for (ice, parking)" style="margin-top:8px"></div>
        <div class="field"><label for="removed">Taken home tonight to deposit</label><div class="money-wrap"><input class="money" id="removed" name="removed" inputmode="decimal" value="${esc(toInput(v.cash_removed_cents))}" placeholder="0.00"></div>
          <div class="hint">Whatever stays in the box becomes tomorrow's opening cash.</div></div>
      </details>

      <div class="field"><label for="notes">Notes</label><textarea id="notes" name="notes" placeholder="Weather, busy hours, what sold out">${esc(v.notes)}</textarea></div>

      <section class="tape preview" aria-live="polite" id="preview"></section>
      <div id="err" class="err" role="alert"></div>
      ${existing ? `<div class="actions"><button type="button" class="danger" id="del">Delete this day</button></div>` : ''}
    </form>`;
  setDock(`<a class="btn" href="#/event/${eventId}">Cancel</a><button class="primary" form="f" type="submit">Save day</button>`);

  const f = document.getElementById('f');
  const val = (name) => parseMoney(f.elements[name].value);
  const counter = document.getElementById('counter');
  const countInputs = [...counter.querySelectorAll('input')];
  const countTotal = () => countInputs.reduce((s, i) => s + (parseInt(i.value, 10) || 0) * Number(i.dataset.cents), 0);

  function refresh() {
    const date = f.elements.date.value;
    const carry = carryFor(date);
    const opening = val('opening');
    const openingUsed = opening === null ? carry : opening;
    document.getElementById('carryHint').textContent = opening === null
      ? `Leave blank to use ${fmt(carry)} (${days.some((d) => d.id !== dayId && d.date < date) ? 'what stayed in the box last night' : 'your opening float'}).`
      : `Last night's box would have started you at ${fmt(carry)}.`;
    const closing = val('closing');
    const paid = val('paidout') || 0;
    const card = (val('paypal') || 0) + (val('other') || 0);
    const cashSales = closing === null || Number.isNaN(closing) ? null : closing - openingUsed + paid;
    const gross = (cashSales || 0) + card;
    const { taxable, tax } = splitTaxIncluded(gross, rateBp);
    document.getElementById('preview').innerHTML = `
      <div class="line"><span class="k">Cash sales today</span><span class="lead"></span><span class="v">${cashSales === null ? 'count the box' : fmt(cashSales)}</span></div>
      <div class="line"><span class="k">Card sales today</span><span class="lead"></span><span class="v">${fmt(card)}</span></div>
      <div class="line total"><span class="k">Total sales today</span><span class="lead"></span><span class="v">${fmt(gross)}</span></div>
      <div class="line"><span class="k">Before tax</span><span class="lead"></span><span class="v">${fmt(taxable)}</span></div>
      <div class="line"><span class="k">Sales tax inside (${pct(rateBp)})</span><span class="lead"></span><span class="v">${fmt(tax)}</span></div>
      ${tapped[date] ? `<div class="line muted"><span class="k">Items tapped: cash</span><span class="lead"></span><span class="v">${fmt(tapped[date].cash)}</span></div>
      <div class="line muted"><span class="k">Items tapped: card</span><span class="lead"></span><span class="v">${fmt(tapped[date].card)}</span></div>` : ''}
      ${cashSales !== null && cashSales < 0 ? `<div class="notice">Cash sales came out negative. Check the opening and closing counts.</div>` : ''}`;
    document.getElementById('countSum').textContent = fmt(countTotal());
  }
  f.addEventListener('input', refresh);
  refresh();

  document.getElementById('countToggle').addEventListener('click', (ev) => {
    counter.hidden = !counter.hidden;
    ev.currentTarget.setAttribute('aria-expanded', String(!counter.hidden));
    if (!counter.hidden) countInputs[0].focus();
  });
  document.getElementById('useCount').addEventListener('click', () => {
    f.elements.closing.value = toInput(countTotal());
    counter.hidden = true;
    document.getElementById('countToggle').setAttribute('aria-expanded', 'false');
    refresh();
  });

  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const date = f.elements.date.value;
    const nums = { opening: val('opening'), closing: val('closing'), paypal: val('paypal'), other: val('other'), paidout: val('paidout'), removed: val('removed') };
    const err = !date ? 'Pick the day.'
      : Object.values(nums).some((x) => Number.isNaN(x)) ? 'Money amounts should look like 150 or 150.00.'
      : days.some((d) => d.id !== dayId && d.date === date) ? `${niceDate(date)} is already logged. Open it from the event page to change it.`
      : '';
    if (err) { document.getElementById('err').textContent = err; return; }
    const counts = {};
    for (const i of countInputs) if (parseInt(i.value, 10) > 0) counts[i.dataset.cents] = parseInt(i.value, 10);
    await db.save({
      id: dayId || undefined, type: 'event_day', company_id: COMPANY,
      data: { event_id: eventId, date, opening_cash_cents: nums.opening, closing_cash_cents: nums.closing,
        paypal_cents: nums.paypal, other_card_cents: nums.other, cash_paid_out_cents: nums.paidout,
        paid_out_note: f.elements.paid_out_note.value.trim(), cash_removed_cents: nums.removed, counts, notes: f.elements.notes.value },
    });
    await postEvent(eventId);
    go(`#/event/${eventId}`);
  });
  const del = document.getElementById('del');
  if (del) del.addEventListener('click', async () => {
    if (!confirm(`Delete ${niceDate(existing.date, { weekday: true })}? This can't be undone.`)) return;
    await db.remove(dayId);
    await postEvent(eventId);
    go(`#/event/${eventId}`);
  });
}

// ---------- deposit form ----------

async function depositFormView(eventId, depId) {
  currentIsForm = true;
  const e = await getEvent(eventId);
  if (!e) return go('#/');
  const settings = await getSettings();
  const { days, deposits } = await eventChildren(eventId);
  const existing = depId ? deposits.find((d) => d.id === depId) : null;
  if (depId && !existing) return go(`#/event/${eventId}`);
  const s = summarizeEvent(e, days, deposits);
  const v = existing || { date: today(), amount_cents: s.cash.notDeposited > 0 ? s.cash.notDeposited : null, account: settings.deposit_accounts[0] || '', note: '' };

  renderBar({ title: existing ? 'Deposit' : 'Record a deposit', back: `#/event/${eventId}` });
  $view.innerHTML = `
    <form id="f" novalidate>
      <p class="sub">Cash from ${esc(e.name)} that went into the bank. Matching it to this event keeps the deposit from being counted as new income later.</p>
      <div class="field"><label for="date">Deposit date</label><input id="date" name="date" type="date" required value="${esc(v.date)}"></div>
      <div class="field"><label for="amt">Amount</label><div class="money-wrap"><input class="money" id="amt" name="amount" inputmode="decimal" value="${esc(toInput(v.amount_cents))}"></div>
        ${!existing && s.cash.notDeposited > 0 ? `<div class="hint">Filled in with the cash not deposited yet (${fmt(s.cash.notDeposited)}).</div>` : ''}</div>
      <div class="field"><label for="acct">Account</label><input id="acct" name="account" list="accts" value="${esc(v.account)}">
        <datalist id="accts">${settings.deposit_accounts.map((a) => `<option value="${esc(a)}">`).join('')}</datalist></div>
      <div class="field"><label for="note">Note</label><input id="note" name="note" value="${esc(v.note)}" placeholder="ATM deposit, branch"></div>
      <div id="err" class="err" role="alert"></div>
      ${existing ? `<div class="actions"><button type="button" class="danger" id="del">Delete deposit</button></div>` : ''}
    </form>`;
  setDock(`<a class="btn" href="#/event/${eventId}">Cancel</a><button class="primary" form="f" type="submit">Save deposit</button>`);

  const f = document.getElementById('f');
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const amount = parseMoney(f.elements.amount.value);
    const err = !f.elements.date.value ? 'Pick the deposit date.' : !amount || Number.isNaN(amount) ? 'Enter the deposit amount, like 450.00.' : '';
    if (err) { document.getElementById('err').textContent = err; return; }
    await db.save({
      id: depId || undefined, type: 'event_deposit', company_id: COMPANY,
      data: { event_id: eventId, date: f.elements.date.value, amount_cents: amount, account: f.elements.account.value.trim(), note: f.elements.note.value.trim() },
    });
    await postEvent(eventId);
    go(`#/event/${eventId}`);
  });
  const del = document.getElementById('del');
  if (del) del.addEventListener('click', async () => {
    if (!confirm('Delete this deposit?')) return;
    await db.remove(depId);
    await postEvent(eventId);
    go(`#/event/${eventId}`);
  });
}

// ---------- settings ----------

async function settingsView() {
  currentIsForm = true;
  const st = await getSettings();
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
  renderBar({ title: 'Settings', back: '#/' });
  const s = syncStatus;
  $view.innerHTML = `
    <h1>Settings</h1>
    <form id="f" novalidate>
      <div class="field"><label for="bn">Business name</label><input id="bn" name="business_name" value="${esc(st.business_name)}" placeholder="Printomancy"></div>
      <div class="two">
        <div class="field"><label for="sr">Default state tax %</label><input id="sr" name="state" inputmode="decimal" value="${esc(st.default_state_rate_bp / 100)}"></div>
        <div class="field"><label for="su">Default local surtax %</label><input id="su" name="surtax" inputmode="decimal" value="${esc(st.default_surtax_bp / 100)}"></div>
      </div>
      <div class="field"><label for="ac">Deposit accounts</label><input id="ac" name="accounts" value="${esc(st.deposit_accounts.join(', '))}"><div class="hint">Separate with commas.</div></div>
      <div class="actions"><button class="primary" type="submit">Save settings</button><span id="saved" class="small" role="status"></span></div>
    </form>

    <h2>Sync</h2>
    ${s.signedIn ? `
      <p>${esc(syncLabel(s).text)}.${s.error ? ` ${esc(s.error)}` : ''}</p>
      <div class="actions"><button type="button" id="syncNow">Sync now</button><button type="button" class="quiet" id="signOut">Stop syncing on this device</button></div>` : `
      <p class="small">Everything is saved on this device and works offline. Enter your passcode to sync with your other devices.</p>
      <form id="login" novalidate><div class="field"><label for="pc">Passcode</label><input id="pc" name="passcode" type="password" autocomplete="current-password"></div>
        <div id="lerr" class="err" role="alert"></div><div class="actions"><button type="submit">Turn on sync</button></div></form>`}

    <h2>Books</h2>
    <div class="actions"><a class="btn" href="#/rules">Rules</a><button type="button" id="refreshSug">Refresh suggestions</button><span class="small" id="sugMsg" role="status"></span></div>

    <h2>Your data</h2>
    <p class="small">${persisted ? 'This browser has agreed to keep your data even when storage runs low.' : 'Install the app to your home screen so your phone keeps this data safe.'}</p>
    <div class="actions"><button type="button" id="backup">Download a backup</button></div>
    <p class="foot">Shopbooks ${APP_VERSION}. Free and open source.</p>`;

  document.getElementById('f').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    await saveSettings({
      ...st,
      business_name: String(fd.get('business_name')).trim(),
      default_state_rate_bp: bpFromPct(fd.get('state')),
      default_surtax_bp: bpFromPct(fd.get('surtax')),
      deposit_accounts: String(fd.get('accounts')).split(',').map((x) => x.trim()).filter(Boolean),
    });
    document.getElementById('saved').textContent = 'Saved';
  });
  const login = document.getElementById('login');
  if (login) login.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = login.querySelector('button');
    btn.disabled = true;
    try {
      await sync.signIn(login.elements.passcode.value);
      await db.requestPersistence();
      if (location.hash.startsWith('#/settings')) settingsView();
    } catch (err) {
      document.getElementById('lerr').textContent = navigator.onLine ? err.message : 'You are offline. Connect to turn on sync.';
      btn.disabled = false;
    }
  });
  const sn = document.getElementById('syncNow');
  if (sn) sn.addEventListener('click', async () => { sn.disabled = true; await sync.syncNow(); if (location.hash.startsWith('#/settings')) settingsView(); });
  const so = document.getElementById('signOut');
  if (so) so.addEventListener('click', async () => { await sync.signOut(); settingsView(); });
  document.getElementById('refreshSug').addEventListener('click', async (e) => {
    e.target.disabled = true;
    const r = await books.refreshSuggestions();
    document.getElementById('sugMsg').textContent = `${r.updated} suggestion${r.updated === 1 ? '' : 's'} updated${r.autoApproved ? `, ${r.autoApproved} approved by rules` : ''}.`;
    e.target.disabled = false;
  });
  document.getElementById('backup').addEventListener('click', async () => {
    const all = await db.exportAll();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: 'shopbooks', version: APP_VERSION, exported_at: new Date().toISOString(), records: all }, null, 2)], { type: 'application/json' }));
    a.download = `shopbooks-backup-${today()}.json`;
    a.click();
  });
}

// ---------- boot ----------

const uiCtx = {
  esc, renderBar, setDock, go, $view, COMPANY, niceDate, today, getEvent,
  setForm: (v) => { currentIsForm = v; },
};
books.init(uiCtx);
taxes.init(uiCtx);
inventory.init(uiCtx);

sync.onStatus((s) => {
  syncStatus = s;
  const el = $bar.querySelector('.sync');
  if (el) {
    const l = syncLabel(s);
    el.dataset.state = l.state;
    el.innerHTML = `<span class="dot" aria-hidden="true"></span>${esc(l.text)}`;
  }
});
db.onChange((d) => {
  if (!d.local && !currentIsForm) route(); // refresh read-only screens when another device syncs
});
window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });

route();
sync.init();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW', e)));
}
