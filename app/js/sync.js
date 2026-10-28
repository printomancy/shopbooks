// Sync with the cloud copy. Works whenever there is a connection and a sign-in;
// otherwise everything keeps working locally and syncs later.
import * as db from './db.js';

let running = null;
let timer = null;
const statusListeners = new Set();
let status = { state: 'idle', lastSync: null, pending: 0, error: null, signedIn: false };

export function onStatus(fn) {
  statusListeners.add(fn);
  fn(status);
  return () => statusListeners.delete(fn);
}
function setStatus(patch) {
  status = { ...status, ...patch };
  for (const fn of statusListeners) fn(status);
}

export async function init() {
  const token = await db.getMeta('token');
  const lastSync = await db.getMeta('lastSync');
  const pending = (await db.outbox()).length;
  setStatus({ signedIn: !!token, lastSync, pending });
  db.onChange(async (d) => {
    if (d.local) {
      setStatus({ pending: (await db.outbox()).length });
      schedule(400);
    }
  });
  window.addEventListener('online', () => schedule(200));
  document.addEventListener('visibilitychange', () => {
    // Push right away when the app is hidden (switching apps, locking the phone).
    if (document.visibilityState === 'hidden') syncNow().catch(() => {});
    else schedule(200);
  });
  setInterval(() => { if (document.visibilityState === 'visible') schedule(0); }, 60000);
  schedule(300);
}

export function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => syncNow().catch(() => {}), ms);
}

export async function signIn(passcode) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error === 'bad_passcode' ? 'That passcode is not right.' : body.detail || 'Sign-in failed.');
  await db.setMeta('token', body.token);
  setStatus({ signedIn: true, error: null });
  schedule(0);
}

export async function signOut() {
  await db.setMeta('token', null);
  setStatus({ signedIn: false });
}

export function syncNow() {
  if (running) return running;
  running = doSync().finally(() => { running = null; });
  return running;
}

async function doSync() {
  const token = await db.getMeta('token');
  if (!token) { setStatus({ state: 'idle', signedIn: false }); return; }
  if (!navigator.onLine) { setStatus({ state: 'offline' }); return; }
  setStatus({ state: 'syncing', error: null });
  try {
    let since = (await db.getMeta('cursor')) || 0;
    const BATCH = 200; // the server accepts up to 500 per request; stay well under
    let pushed = (await db.outbox()).slice(0, BATCH);
    let more = true;
    let rounds = 0;
    while (more && rounds++ < 200) {
      setStatus({ pending: (await db.outbox()).length });
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ since, changes: pushed }),
      });
      if (res.status === 401) {
        await db.setMeta('token', null);
        setStatus({ state: 'error', signedIn: false, error: 'Signed out. Enter your passcode in Settings.' });
        return;
      }
      if (!res.ok) throw new Error(`Sync failed (${res.status})`);
      const body = await res.json();
      if (pushed.length) await db.clearOutbox(pushed);
      await db.applyRemote(body.changes);
      since = body.cursor;
      await db.setMeta('cursor', since);
      // keep going while the server has more to send or we still have edits to push
      pushed = (await db.outbox()).slice(0, BATCH);
      more = body.more || pushed.length > 0;
    }
    const lastSync = new Date().toISOString();
    await db.setMeta('lastSync', lastSync);
    setStatus({ state: 'ok', lastSync, pending: 0 });
  } catch (err) {
    setStatus({ state: 'error', error: navigator.onLine ? err.message : 'Offline', pending: (await db.outbox()).length });
  }
}
