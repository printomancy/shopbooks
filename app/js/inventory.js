// Inventory and item sales: a product list loaded from your stock spreadsheet,
// a Sell screen for each event, and on-hand counts that drop as items sell.
//
// Records:
//   product    { name, price_cents, grams, count, counted_at, active }
//   item_sale  { event_id, date, sold_at, product_id, name, qty, price_cents, method: 'cash'|'card' }
//
// Item sales are a tally of what sold. The money still reaches the books through
// the day close-out (cash box count + PayPal total), so nothing is counted twice;
// the event page compares the two.
import * as db from './db.js';
import { fmt, parseMoney, toInput } from './money.js';
import { productId, parseProductSheet, withOnHand, summarizeItemSales, itemSalesTsv, stockTsv, matches } from './inventory/stock.js';

let ui; // helpers from app.js: esc, renderBar, setDock, go, $view, COMPANY, niceDate, setForm, today, getEvent
export function init(ctx) { ui = ctx; }

export async function products({ includeInactive = false } = {}) {
  const recs = await db.list('product', { companyId: ui.COMPANY });
  return recs.map((r) => ({ id: r.id, ...r.data }))
    .filter((p) => includeInactive || p.active !== false)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
export async function itemSales(eventId) {
  const recs = await db.list('item_sale', { companyId: ui.COMPANY });
  return recs.map((r) => ({ id: r.id, ...r.data })).filter((s) => !eventId || s.event_id === eventId);
}
async function stock() {
  const [ps, sales] = await Promise.all([products(), itemSales()]);
  return withOnHand(ps, sales);
}

async function copyText(text, $msg, okText) {
  try {
    await navigator.clipboard.writeText(text);
    $msg.textContent = okText;
  } catch {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/tab-separated-values' }));
    a.download = 'shopbooks.tsv';
    a.click();
    $msg.textContent = 'Copying was blocked, so it downloaded as a file instead.';
  }
}

// ---------- home section ----------

export async function homeSection() {
  const ps = await stock();
  if (!ps.length) {
    return `<h2>Inventory</h2><div class="empty"><strong>No products yet</strong>Load your stock count to tap items as sold at events. <a href="#/inventory/load">Load products</a></div>`;
  }
  const units = ps.reduce((t, p) => t + Math.max(0, p.on_hand), 0);
  const value = ps.reduce((t, p) => t + Math.max(0, p.on_hand) * (p.price_cents || 0), 0);
  const sold = ps.reduce((t, p) => t + p.sold, 0);
  return `<h2>Inventory</h2><ul class="rows"><li><a href="#/inventory">
    <div class="main"><div class="name">${ps.length} products</div><div class="meta">${units.toLocaleString()} on hand${sold ? ` &middot; ${sold} sold since the last count` : ''}</div></div>
    <div class="amt">${fmt(value)}<small>retail on hand</small></div><span class="chev" aria-hidden="true">&rsaquo;</span></a></li></ul>`;
}

// ---------- inventory list ----------

export async function inventoryView(q) {
  ui.renderBar({ title: 'Inventory', back: '#/' });
  const ps = await stock();
  const query = q.get('q') || '';
  const lastCount = ps.map((p) => p.counted_at || '').sort().pop();
  const units = ps.reduce((t, p) => t + Math.max(0, p.on_hand), 0);
  const sold = ps.reduce((t, p) => t + p.sold, 0);
  const value = ps.reduce((t, p) => t + Math.max(0, p.on_hand) * (p.price_cents || 0), 0);

  ui.$view.innerHTML = `
    <h1>Inventory</h1>
    <p class="sub">${ps.length ? `Counted ${esc(lastCount ? ui.niceDate(lastCount.slice(0, 10)) : '')}. Items you sell at events come off these counts.` : 'Load your stock count to start.'}</p>
    ${ps.length ? `
    <section class="tape" aria-label="Stock totals">
      <div class="big">${units.toLocaleString()}</div>
      <div class="big-label">units on hand</div>
      <div class="line"><span class="k">Retail value on hand</span><span class="lead"></span><span class="v">${fmt(value)}</span></div>
      <div class="line"><span class="k">Sold since the count</span><span class="lead"></span><span class="v">${sold}</span></div>
    </section>
    <div class="field" style="margin-top:20px"><label for="q">Find a product</label><input id="q" type="search" value="${esc(query)}" placeholder="dragon, z3d, skeleton" autocomplete="off"></div>
    <ul class="rows" id="list"></ul>
    <div class="actions"><button type="button" id="copy">Copy stock list</button><a class="btn btn-quiet" href="#/inventory/load">Load a new count</a></div>
    <p class="small" id="msg" role="status"></p>` : `
    <div class="empty"><strong>No products yet</strong>Paste your inventory spreadsheet or pick the file. Each product needs a name; price, grams and count are read when they're there.</div>`}`;
  ui.setDock(ps.length ? '' : `<a class="btn btn-primary" href="#/inventory/load">Load products</a>`);
  if (!ps.length) return;

  const $list = document.getElementById('list');
  const draw = (term) => {
    const shown = ps.filter((p) => matches(p.name, term));
    $list.innerHTML = shown.map((p) => `<li><div class="row">
      <div class="main"><div class="name">${esc(p.name)}</div><div class="meta">${fmt(p.price_cents)}${p.grams ? ` &middot; ${p.grams} g` : ''}${p.sold ? ` &middot; ${p.sold} sold` : ''}</div></div>
      <div class="amt">${p.on_hand}<small>on hand</small></div>
      ${p.on_hand < 0 ? '<span class="tag">Check count</span>' : ''}</div></li>`).join('')
      || `<li><div class="row"><div class="main meta">No product matches "${esc(term)}".</div></div></li>`;
  };
  draw(query);
  document.getElementById('q').addEventListener('input', (e) => draw(e.target.value));
  document.getElementById('copy').addEventListener('click', () =>
    copyText(stockTsv(ps), document.getElementById('msg'), `Copied ${ps.length} products. Paste into a spreadsheet or send to Claude.`));
}

// ---------- load / replace the count ----------

export async function loadView() {
  ui.setForm(true);
  ui.renderBar({ title: 'Load products', back: '#/inventory' });
  const existing = await products({ includeInactive: true });
  ui.$view.innerHTML = `
    <h1>Load products</h1>
    <p class="sub">Use your inventory spreadsheet: copy the rows with the header (Product, Price, Grams per unit, Count) and paste them here, or pick the file.</p>
    <div class="field"><label for="file">Spreadsheet file (CSV)</label><input id="file" type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"></div>
    <div class="field"><label for="paste">Or paste rows</label><textarea id="paste" rows="6" placeholder="Product&#9;Price&#9;Grams per unit&#9;Count"></textarea></div>
    <div id="preview"></div>
    <div id="err" class="err" role="alert"></div>`;
  ui.setDock(`<a class="btn" href="#/inventory">Cancel</a><button class="primary" id="save" type="button" disabled>Load products</button>`);

  let parsed = null;
  const $prev = document.getElementById('preview'), $err = document.getElementById('err'), $save = document.getElementById('save');
  const show = (text) => {
    parsed = parseProductSheet(text);
    $err.textContent = parsed.error;
    $save.disabled = !parsed.products.length;
    if (!parsed.products.length) { $prev.innerHTML = ''; return; }
    const known = new Set(existing.map((p) => p.id));
    const adds = parsed.products.filter((p) => !known.has(productId(p.name))).length;
    const units = parsed.products.reduce((t, p) => t + p.count, 0);
    const noPrice = parsed.products.filter((p) => p.price_cents === null).length;
    const listed = new Set(parsed.products.map((p) => productId(p.name)));
    const dropped = existing.filter((p) => p.active !== false && !listed.has(p.id)).length;
    $prev.innerHTML = `<section class="tape preview">
      <div class="line"><span class="k">Products</span><span class="lead"></span><span class="v">${parsed.products.length}</span></div>
      <div class="line"><span class="k">Units</span><span class="lead"></span><span class="v">${units.toLocaleString()}</span></div>
      <div class="line"><span class="k">New to Shopbooks</span><span class="lead"></span><span class="v">${adds}</span></div>
      ${existing.length ? `<div class="line"><span class="k">Counts replaced</span><span class="lead"></span><span class="v">${parsed.products.length - adds}</span></div>` : ''}
    </section>
    ${noPrice ? `<div class="notice">${noPrice} product${noPrice > 1 ? 's have' : ' has'} no price. You can type the price in when you sell ${noPrice > 1 ? 'them' : 'it'}.</div>` : ''}
    ${dropped ? `<label class="check"><input type="checkbox" id="hideMissing" checked> Hide the ${dropped} product${dropped > 1 ? 's' : ''} not in this list (sold out or retired). Their sales history stays.</label>` : ''}
    <p class="small">The counts here become the new starting point. Sales logged before now won't be taken off them again.</p>`;
  };
  document.getElementById('paste').addEventListener('input', (e) => show(e.target.value));
  document.getElementById('file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const text = await f.text();
    document.getElementById('paste').value = '';
    show(text);
  });
  $save.addEventListener('click', async () => {
    if (!parsed || !parsed.products.length) return;
    $save.disabled = true;
    const now = new Date().toISOString();
    const listed = new Set();
    const writes = parsed.products.map((p) => {
      const id = productId(p.name);
      listed.add(id);
      return { id, type: 'product', company_id: ui.COMPANY,
        data: { name: p.name, price_cents: p.price_cents, grams: p.grams, count: p.count, counted_at: now, active: true } };
    });
    const hide = document.getElementById('hideMissing');
    if (hide && hide.checked) {
      for (const p of existing) {
        if (p.active === false || listed.has(p.id)) continue;
        const { id, ...data } = p;
        writes.push({ id, type: 'product', company_id: ui.COMPANY, data: { ...data, active: false } });
      }
    }
    await db.saveMany(writes);
    ui.go('#/inventory');
  });
}

// ---------- event: item sales summary (on the event page) ----------

// summaryDays: the event's days from summarizeEvent (each has date, cashSales, card).
export async function eventSection(event, summaryDays) {
  const sales = await itemSales(event.id);
  const s = summarizeItemSales(sales);
  const hasProducts = (await products()).length > 0;
  if (!sales.length) {
    return `<h2>Items sold</h2>${hasProducts
      ? `<p class="small">Tap items as they sell to keep inventory counts current. Use <strong>Sell items</strong> below.</p>`
      : `<div class="empty"><strong>No products loaded</strong><a href="#/inventory/load">Load your stock count</a> to tap items as sold.</div>`}`;
  }
  // Compare the tapped items with each closed-out day: the cash box and PayPal are the money of record.
  const checks = [];
  for (const d of summaryDays) {
    const it = s.byDate[d.date];
    if (!it || d.cashSales === null) continue;
    const dc = d.cashSales - it.cash, dk = d.card - it.card;
    if (Math.abs(dc) < 100 && Math.abs(dk) < 100) continue;
    const parts = [];
    if (Math.abs(dc) >= 100) parts.push(`cash box shows ${fmt(Math.abs(dc))} ${dc > 0 ? 'more' : 'less'} than items tapped as cash`);
    if (Math.abs(dk) >= 100) parts.push(`card sales are ${fmt(Math.abs(dk))} ${dk > 0 ? 'more' : 'less'} than items tapped as card`);
    checks.push(`<li><strong>${esc(ui.niceDate(d.date, { weekday: true }))}:</strong> ${parts.join('; ')}.</li>`);
  }
  const checkHtml = checks.length
    ? `<div class="notice">Items tapped don't match the day close-out:<ul class="tight">${checks.join('')}</ul>A bigger close-out usually means a sale wasn't tapped; a smaller one, a discount or a wrong payment button.</div>`
    : summaryDays.some((d) => s.byDate[d.date] && d.cashSales !== null) ? `<p class="small">Items tapped match the closed-out days.</p>` : '';
  const top = s.byProduct.slice(0, 50).map((p) => `<div class="line"><span class="k">${esc(p.name)} &times; ${p.qty}</span><span class="lead"></span><span class="v">${fmt(p.amount)}</span></div>`).join('');
  return `<h2>Items sold</h2>
    <section class="tape" aria-label="Items sold">
      <div class="line"><span class="k">Items sold</span><span class="lead"></span><span class="v">${s.units}</span></div>
      <div class="line"><span class="k">Tapped as cash</span><span class="lead"></span><span class="v">${fmt(s.cash)}</span></div>
      <div class="line"><span class="k">Tapped as card</span><span class="lead"></span><span class="v">${fmt(s.card)}</span></div>
      <div class="line total"><span class="k">Item sales</span><span class="lead"></span><span class="v">${fmt(s.gross)}</span></div>
    </section>
    ${checkHtml}
    <details><summary>What sold (${s.byProduct.length} product${s.byProduct.length === 1 ? '' : 's'})</summary><section class="tape">${top}</section></details>
    <div class="actions"><button type="button" class="quiet" id="copyItems">Copy items sold</button><span class="small" id="itemsMsg" role="status"></span></div>`;
}
export function wireEventSection(event, sales) {
  const b = document.getElementById('copyItems');
  if (b) b.addEventListener('click', async () => {
    const all = sales || (await itemSales(event.id));
    copyText(itemSalesTsv(all), document.getElementById('itemsMsg'), 'Copied. Paste into a spreadsheet or send to Claude to take off the inventory.');
  });
}

// Item totals for one day, for the close-out screen.
export async function dayItemTotals(eventId, date) {
  return summarizeItemSales((await itemSales(eventId)).filter((x) => x.date === date));
}

// ---------- sell screen ----------

export async function sellView(eventId) {
  ui.setForm(true);
  const e = await ui.getEvent(eventId);
  if (!e) return ui.go('#/');
  const date = (() => {
    const t = ui.today();
    return t < e.start_date ? e.start_date : t > (e.end_date || e.start_date) ? (e.end_date || e.start_date) : t;
  })();
  let ps = await stock();
  const cart = new Map(); // key -> { product_id, name, qty, price_cents }
  let query = '';

  ui.renderBar({ title: 'Sell items', back: `#/event/${eventId}` });
  ui.$view.innerHTML = `
    <p class="sub">${esc(e.name)} &middot; ${esc(ui.niceDate(date, { weekday: true }))}. Tap what's being bought, then how they paid.</p>
    <section class="tape cart" id="cart" aria-live="polite"></section>
    <div class="field search-field"><label for="q" class="sr">Find a product</label><input id="q" type="search" placeholder="Find a product" autocomplete="off"></div>
    <ul class="rows pick" id="list"></ul>
    <details id="custom"><summary>Something not on the list</summary>
      <div class="two"><div class="field"><label for="cname">Item</label><input id="cname" placeholder="Custom print"></div>
      <div class="field"><label for="cprice">Price</label><div class="money-wrap"><input class="money" id="cprice" inputmode="decimal" placeholder="0.00"></div></div></div>
      <div class="actions" style="margin-top:0"><button type="button" id="cadd">Add to sale</button></div>
    </details>
    <h2>Sold today</h2>
    <ul class="rows" id="today"></ul>
    <p class="small" id="todayTotal"></p>`;

  const $cart = document.getElementById('cart'), $list = document.getElementById('list'), $today = document.getElementById('today');
  const cartTotal = () => [...cart.values()].reduce((t, c) => t + c.qty * (c.price_cents || 0), 0);
  const cartUnits = () => [...cart.values()].reduce((t, c) => t + c.qty, 0);
  const inCart = (id) => [...cart.values()].filter((c) => c.product_id === id).reduce((t, c) => t + c.qty, 0);

  function drawDock() {
    const n = cartUnits(), tot = cartTotal();
    const missingPrice = [...cart.values()].some((c) => c.price_cents === null || Number.isNaN(c.price_cents));
    ui.setDock(n
      ? `<button class="primary" id="payCash" type="button" ${missingPrice ? 'disabled' : ''}>Cash ${fmt(tot)}</button><button class="primary" id="payCard" type="button" ${missingPrice ? 'disabled' : ''}>Card ${fmt(tot)}</button>`
      : `<a class="btn" href="#/event/${eventId}">Done selling</a>`);
    const c = document.getElementById('payCash'), k = document.getElementById('payCard');
    if (c) c.addEventListener('click', () => record('cash'));
    if (k) k.addEventListener('click', () => record('card'));
  }

  function drawCart() {
    if (!cart.size) {
      $cart.innerHTML = `<div class="cart-empty">No items in this sale yet.</div>`;
    } else {
      $cart.innerHTML = [...cart.entries()].map(([key, c]) => `
        <div class="cart-line" data-key="${esc(key)}">
          <div class="cl-name">${esc(c.name)}</div>
          <div class="cl-ctrl">
            <button type="button" class="step" data-act="dec" aria-label="One less ${esc(c.name)}">&minus;</button>
            <span class="cl-qty" aria-label="Quantity">${c.qty}</span>
            <button type="button" class="step" data-act="inc" aria-label="One more ${esc(c.name)}">+</button>
            <span class="cl-x">&times;</span>
            <div class="money-wrap cl-price"><input class="money" inputmode="decimal" value="${esc(toInput(c.price_cents))}" aria-label="Price each for ${esc(c.name)}" placeholder="price"></div>
          </div>
        </div>`).join('') + `<div class="line total"><span class="k">${cartUnits()} item${cartUnits() === 1 ? '' : 's'}</span><span class="lead"></span><span class="v">${fmt(cartTotal())}</span></div>
        <div class="cart-foot"><button type="button" class="quiet" id="clear">Clear sale</button><span class="small">Prices include tax. Change a price for a deal.</span></div>`;
      const clr = document.getElementById('clear');
      if (clr) clr.addEventListener('click', () => { cart.clear(); drawAll(); });
    }
    drawDock();
  }

  function drawList() {
    const shown = ps.filter((p) => matches(p.name, query));
    $list.innerHTML = shown.slice(0, 200).map((p) => {
      const left = p.on_hand - inCart(p.id);
      return `<li><button type="button" class="pick-row" data-id="${esc(p.id)}">
        <span class="main"><span class="name">${esc(p.name)}</span><span class="meta">${left} left${left <= 0 ? ' &middot; check the count' : ''}</span></span>
        <span class="amt">${p.price_cents === null ? 'no price' : fmt(p.price_cents)}</span>
        ${inCart(p.id) ? `<span class="badge" aria-label="${inCart(p.id)} in this sale">${inCart(p.id)}</span>` : '<span class="plus" aria-hidden="true">+</span>'}
      </button></li>`;
    }).join('') || `<li><div class="row"><div class="main meta">${ps.length ? `No product matches "${esc(query)}". Use "Something not on the list" below.` : 'No products loaded. Use "Something not on the list", or load your stock from Inventory.'}</div></div></li>`;
  }

  async function drawToday() {
    const sales = (await itemSales(eventId)).filter((s) => s.date === date).sort((a, b) => (b.sold_at || '').localeCompare(a.sold_at || ''));
    // Group lines saved together into one sale.
    const groups = new Map();
    for (const s of sales) {
      const k = s.sale_id || s.id;
      (groups.get(k) || groups.set(k, []).get(k)).push(s);
    }
    $today.innerHTML = [...groups.values()].map((g) => {
      const tot = g.reduce((t, s) => t + s.qty * s.price_cents, 0);
      const time = new Date(g[0].sold_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      return `<li><div class="row">
        <div class="main"><div class="name">${g.map((s) => `${esc(s.name)}${s.qty > 1 ? ` &times; ${s.qty}` : ''}`).join(', ')}</div>
          <div class="meta">${esc(time)} &middot; ${g[0].method === 'cash' ? 'Cash' : 'Card'}</div></div>
        <div class="amt">${fmt(tot)}</div>
        <button type="button" class="quiet undo" data-ids="${g.map((s) => s.id).join(',')}">Undo</button></div></li>`;
    }).join('') || `<li><div class="row"><div class="main meta">Nothing sold yet today.</div></div></li>`;
    const s = summarizeItemSales(sales);
    document.getElementById('todayTotal').textContent = sales.length ? `${s.units} item${s.units === 1 ? '' : 's'} today: ${fmt(s.cash)} cash, ${fmt(s.card)} card.` : '';
  }

  function drawAll() { drawCart(); drawList(); }

  function add(p) {
    const key = p.id;
    const cur = cart.get(key) || { product_id: p.id, name: p.name, qty: 0, price_cents: p.price_cents };
    cur.qty += 1;
    cart.set(key, cur);
    drawAll();
  }

  $list.addEventListener('click', (ev) => {
    const b = ev.target.closest('.pick-row');
    if (!b) return;
    const p = ps.find((x) => x.id === b.dataset.id);
    if (p) add(p);
  });
  $cart.addEventListener('click', (ev) => {
    const b = ev.target.closest('.step');
    if (!b) return;
    const key = b.closest('.cart-line').dataset.key;
    const c = cart.get(key);
    if (!c) return;
    c.qty += b.dataset.act === 'inc' ? 1 : -1;
    if (c.qty <= 0) cart.delete(key);
    drawAll();
  });
  $cart.addEventListener('change', (ev) => {
    const inp = ev.target.closest('.cl-price input');
    if (!inp) return;
    const c = cart.get(inp.closest('.cart-line').dataset.key);
    const v = parseMoney(inp.value);
    c.price_cents = v === null || Number.isNaN(v) ? null : v;
    drawCart();
  });
  document.getElementById('q').addEventListener('input', (ev) => { query = ev.target.value; drawList(); });
  document.getElementById('cadd').addEventListener('click', () => {
    const name = document.getElementById('cname').value.trim();
    const price = parseMoney(document.getElementById('cprice').value);
    if (!name || price === null || Number.isNaN(price)) { document.getElementById('cname').focus(); return; }
    cart.set('custom:' + db.newId(), { product_id: null, name, qty: 1, price_cents: price });
    document.getElementById('cname').value = '';
    document.getElementById('cprice').value = '';
    document.getElementById('custom').open = false;
    drawAll();
  });
  $today.addEventListener('click', async (ev) => {
    const b = ev.target.closest('.undo');
    if (!b) return;
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap to undo'; setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.textContent = 'Undo'; } }, 3000); return; }
    for (const id of b.dataset.ids.split(',')) await db.remove(id);
    ps = await stock();
    drawAll();
    drawToday();
  });

  let busy = false;
  async function record(method) {
    if (busy || !cart.size) return;
    busy = true;
    const sold_at = new Date().toISOString();
    const sale_id = db.newId();
    const writes = [...cart.values()].map((c) => ({
      id: db.newId(), type: 'item_sale', company_id: ui.COMPANY,
      data: { event_id: eventId, date, sold_at, sale_id, product_id: c.product_id, name: c.name, qty: c.qty, price_cents: c.price_cents, method },
    }));
    await db.saveMany(writes);
    cart.clear();
    ps = await stock();
    query = '';
    document.getElementById('q').value = '';
    drawAll();
    await drawToday();
    busy = false;
    window.scrollTo(0, 0);
  }

  drawAll();
  drawToday();
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
