// Local database (IndexedDB). Every device keeps the full set of records here,
// so the app works with no connection. Edits also go to an outbox for syncing.
//
// Record shape: { id, type, company_id, data: {...}, updated_at, deleted }

const DB_NAME = 'shopbooks';
const DB_VERSION = 1;
let dbPromise = null;
const listeners = new Set();

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('records')) {
        const s = db.createObjectStore('records', { keyPath: 'id' });
        s.createIndex('type', 'type');
      }
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(stores, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        let result;
        Promise.resolve(fn(t)).then((r) => (result = r), reject);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(detail) {
  for (const fn of listeners) {
    try { fn(detail); } catch (e) { console.error(e); }
  }
}

export function newId() {
  return crypto.randomUUID();
}

// Monotonic ISO timestamp so two quick edits never share a time.
let lastStamp = '';
function stamp() {
  let s = new Date().toISOString();
  if (s <= lastStamp) s = new Date(Date.parse(lastStamp) + 1).toISOString();
  lastStamp = s;
  return s;
}

export async function get(id) {
  return tx(['records'], 'readonly', (t) => reqP(t.objectStore('records').get(id)));
}

export async function list(type, { companyId, includeDeleted = false } = {}) {
  const rows = await tx(['records'], 'readonly', (t) => reqP(t.objectStore('records').index('type').getAll(type)));
  return rows.filter((r) => (includeDeleted || !r.deleted) && (!companyId || r.company_id === companyId));
}

export async function save({ id, type, company_id, data }) {
  const rec = { id: id || newId(), type, company_id, data, updated_at: stamp(), deleted: false };
  await tx(['records', 'outbox'], 'readwrite', (t) => {
    t.objectStore('records').put(rec);
    t.objectStore('outbox').put(rec);
  });
  emit({ local: true, ids: [rec.id] });
  return rec;
}

// Save many records in one transaction (imports). Skips records whose data is unchanged.
export async function saveMany(items) {
  let written = 0;
  await tx(['records', 'outbox'], 'readwrite', async (t) => {
    const rs = t.objectStore('records'), ob = t.objectStore('outbox');
    for (const it of items) {
      const cur = await reqP(rs.get(it.id));
      if (cur && !cur.deleted && JSON.stringify(cur.data) === JSON.stringify(it.data)) continue;
      const rec = { id: it.id, type: it.type, company_id: it.company_id, data: it.data, updated_at: stamp(), deleted: false };
      rs.put(rec);
      ob.put(rec);
      written++;
    }
  });
  if (written) emit({ local: true, bulk: true });
  return written;
}

export async function has(id) {
  const r = await get(id);
  return !!(r && !r.deleted);
}

export async function remove(id) {
  const existing = await get(id);
  if (!existing) return;
  const rec = { ...existing, deleted: true, updated_at: stamp() };
  await tx(['records', 'outbox'], 'readwrite', (t) => {
    t.objectStore('records').put(rec);
    t.objectStore('outbox').put(rec);
  });
  emit({ local: true, ids: [id] });
}

// Apply records pulled from the cloud; newer timestamp wins.
export async function applyRemote(changes) {
  if (!changes.length) return 0;
  let applied = 0;
  await tx(['records'], 'readwrite', async (t) => {
    const store = t.objectStore('records');
    for (const c of changes) {
      const local = await reqP(store.get(c.id));
      if (!local || local.updated_at < c.updated_at) {
        const { seq, ...rec } = c;
        store.put(rec);
        applied++;
      }
    }
  });
  if (applied) emit({ local: false });
  return applied;
}

export async function outbox() {
  return tx(['outbox'], 'readonly', (t) => reqP(t.objectStore('outbox').getAll()));
}

// Remove pushed items, unless they were edited again while the push was in flight.
export async function clearOutbox(pushed) {
  await tx(['outbox'], 'readwrite', async (t) => {
    const store = t.objectStore('outbox');
    for (const p of pushed) {
      const cur = await reqP(store.get(p.id));
      if (cur && cur.updated_at === p.updated_at) store.delete(p.id);
    }
  });
}

export async function getMeta(key, fallback = null) {
  const row = await tx(['meta'], 'readonly', (t) => reqP(t.objectStore('meta').get(key)));
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  await tx(['meta'], 'readwrite', (t) => t.objectStore('meta').put({ key, value }));
}

export async function exportAll() {
  return tx(['records'], 'readonly', (t) => reqP(t.objectStore('records').getAll()));
}

// Ask the browser not to evict our data under storage pressure.
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch {}
  return false;
}
