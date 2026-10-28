#!/usr/bin/env node
// Bulk-load records (for example a history backfill) into your shopbooks cloud copy.
// By default existing records are never overwritten, so it is safe to run again.
// Pass --update to apply corrections: a record replaces the cloud copy when its
// updated_at is newer (the same rule devices use).
//
//   SHOPBOOKS_URL=https://shopbooks.example.workers.dev SHOPBOOKS_PASSCODE=... node tools/push-records.mjs records.json [--update]
//
// records.json: [{ id, type, company_id, data, updated_at }]
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const update = args.includes('--update');
const [file] = args.filter((a) => !a.startsWith('--'));
const base = (process.env.SHOPBOOKS_URL || '').replace(/\/$/, '');
const passcode = process.env.SHOPBOOKS_PASSCODE;
if (!file || !base || !passcode) {
  console.error('Usage: SHOPBOOKS_URL=... SHOPBOOKS_PASSCODE=... node tools/push-records.mjs records.json');
  process.exit(1);
}

const records = JSON.parse(readFileSync(file, 'utf8'));
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode }) });
if (!login.ok) { console.error('Login failed:', login.status, await login.text()); process.exit(1); }
const { token } = await login.json();

const BATCH = 200;
let accepted = 0;
for (let i = 0; i < records.length; i += BATCH) {
  const changes = records.slice(i, i + BATCH);
  const res = await fetch(`${base}/api/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ since: 2 ** 31, insert_only: !update, changes }),
  });
  if (!res.ok) { console.error(`Batch at ${i} failed:`, res.status, await res.text()); process.exit(1); }
  const body = await res.json();
  accepted += body.accepted;
  process.stdout.write(`\r${Math.min(i + BATCH, records.length)} / ${records.length} sent, ${accepted} new`);
}
console.log(`\nDone. ${accepted} ${update ? 'written' : 'new'}, ${records.length - accepted} ${update ? 'unchanged (cloud copy newer)' : 'already there'}.`);
