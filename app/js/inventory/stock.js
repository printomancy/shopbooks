// Stock math for item sales. Pure functions only, so they run the same in the browser and in tests.
//
// A product carries the count from the last time stock was loaded (count + counted_at).
// On hand = that count minus every item sold for it since counted_at.
// Loading a fresh count later resets the starting point, so sales already
// deducted in the spreadsheet are not deducted twice.
import { parseMoney } from '../money.js';
import { parseCsv } from '../import/csv.js';

export const productId = (name) =>
  'prod_' + String(name).toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);

// Reads a pasted or uploaded product sheet (tab- or comma-separated) with a header row.
// Needs a Product column; Price, Grams per unit and Count are read when present.
// Returns { products: [{ name, price_cents, grams, count }], skipped, error }.
export function parseProductSheet(text) {
  const src = String(text || '').replace(/^﻿/, '');
  if (!src.trim()) return { products: [], skipped: 0, error: 'Nothing to read. Paste the rows or pick a file.' };
  const firstLine = src.split(/\r?\n/).find((l) => l.trim()) || '';
  const rows = firstLine.includes('\t')
    ? src.split(/\r?\n/).map((l) => l.split('\t'))
    : parseCsv(src);
  const norm = (s) => String(s || '').trim().toLowerCase();
  const hi = rows.findIndex((r) => r.some((c) => norm(c) === 'product' || norm(c) === 'product name'));
  if (hi < 0) return { products: [], skipped: 0, error: 'No "Product" column found. Copy the header row along with the products.' };
  const head = rows[hi].map(norm);
  const col = (test) => head.findIndex(test);
  const cName = col((h) => h === 'product' || h === 'product name');
  const cPrice = col((h) => /^price/.test(h));
  const cGrams = col((h) => /gram/.test(h) && !/total/.test(h));
  const cCount = col((h) => h === 'count' || h === 'on hand' || h === 'qty' || h === 'quantity');
  const num = (v) => {
    const s = String(v ?? '').replace(/[,\s]/g, '');
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const byName = new Map();
  let skipped = 0;
  for (const r of rows.slice(hi + 1)) {
    const name = String(r[cName] ?? '').trim();
    if (!name || /^total$/i.test(name)) { if (r.some((c) => String(c).trim())) skipped++; continue; }
    const price = cPrice >= 0 ? parseMoney(r[cPrice]) : null;
    const p = {
      name,
      price_cents: price === null || Number.isNaN(price) ? null : price,
      grams: cGrams >= 0 ? num(r[cGrams]) : null,
      count: cCount >= 0 ? Math.max(0, Math.round(num(r[cCount]) ?? 0)) : 0,
    };
    const dup = byName.get(name.toLowerCase());
    if (dup) dup.count += p.count; // same product listed twice: add the counts
    else byName.set(name.toLowerCase(), p);
  }
  const products = [...byName.values()];
  return { products, skipped, error: products.length ? '' : 'No product rows found under the header.' };
}

const live = (s) => s && !s.deleted;

// Units sold for each product since its count was taken. sales: [{ product_id, qty, sold_at }]
export function soldSinceCount(products, sales) {
  const since = new Map(products.map((p) => [p.id, p.counted_at || '']));
  const out = new Map();
  for (const s of sales) {
    if (!live(s) || !s.product_id || !since.has(s.product_id)) continue;
    if ((s.sold_at || '') < since.get(s.product_id)) continue;
    out.set(s.product_id, (out.get(s.product_id) || 0) + (s.qty || 0));
  }
  return out;
}

export function withOnHand(products, sales) {
  const sold = soldSinceCount(products, sales);
  return products.map((p) => ({ ...p, sold: sold.get(p.id) || 0, on_hand: (p.count || 0) - (sold.get(p.id) || 0) }));
}

// Item sales totals for an event (or one day): units, money by payment method, and per product.
export function summarizeItemSales(sales) {
  const t = { units: 0, cash: 0, card: 0, gross: 0, byProduct: [], byDate: {} };
  const byP = new Map();
  for (const s of sales) {
    if (!live(s)) continue;
    const amt = (s.qty || 0) * (s.price_cents || 0);
    t.units += s.qty || 0;
    if (s.method === 'cash') t.cash += amt; else t.card += amt;
    t.gross += amt;
    const d = (t.byDate[s.date] ||= { units: 0, cash: 0, card: 0 });
    d.units += s.qty || 0;
    if (s.method === 'cash') d.cash += amt; else d.card += amt;
    const key = s.product_id || 'name:' + s.name;
    const row = byP.get(key) || { product_id: s.product_id || null, name: s.name, qty: 0, amount: 0 };
    row.qty += s.qty || 0;
    row.amount += amt;
    byP.set(key, row);
  }
  t.byProduct = [...byP.values()].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
  return t;
}

// Text a spreadsheet (or Claude) can take straight from the clipboard.
export function itemSalesTsv(sales) {
  const d2 = (c) => (c / 100).toFixed(2);
  const rows = [['Date', 'Time', 'Product', 'Qty', 'Price each', 'Total', 'Paid by']];
  const sorted = sales.filter(live).sort((a, b) => (a.sold_at || '').localeCompare(b.sold_at || ''));
  for (const s of sorted) {
    const time = s.sold_at ? new Date(s.sold_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
    rows.push([s.date, time, s.name, s.qty, d2(s.price_cents), d2(s.qty * s.price_cents), s.method === 'cash' ? 'Cash' : 'Card']);
  }
  return rows.map((r) => r.join('\t')).join('\n');
}

export function stockTsv(products) {
  const d2 = (c) => (c === null || c === undefined ? '' : (c / 100).toFixed(2));
  const rows = [['Product', 'Price', 'Grams per unit', 'Counted', 'Sold since', 'On hand']];
  for (const p of [...products].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))) {
    rows.push([p.name, d2(p.price_cents), p.grams ?? '', p.count ?? 0, p.sold ?? 0, p.on_hand ?? p.count ?? 0]);
  }
  return rows.map((r) => r.join('\t')).join('\n');
}

// Loose search: every word typed must appear somewhere in the name.
export function matches(name, query) {
  const n = String(name).toLowerCase();
  return String(query || '').toLowerCase().split(/\s+/).filter(Boolean).every((w) => n.includes(w));
}
