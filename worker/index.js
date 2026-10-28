// shopbooks Worker: serves the app (static assets) and a small sync API.
// The API is intentionally thin: devices are the source of truth, the cloud copy
// exists so phone, desktop and AI assistants all see the same books.

const TOKEN_DAYS = 365;
const MAX_CHANGES_PER_PUSH = 500;
const MAX_CHANGES_PER_PULL = 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    try {
      return await handleApi(request, env, url);
    } catch (err) {
      console.error(err);
      return json({ error: 'server_error', detail: String(err && err.message || err) }, 500);
    }
  },
};

async function handleApi(request, env, url) {
  const path = url.pathname;

  if (path === '/api/health') {
    return json({ ok: true, app: 'shopbooks', time: new Date().toISOString() });
  }

  if (path === '/api/login' && request.method === 'POST') {
    if (!env.APP_PASSCODE || !env.TOKEN_SECRET) {
      return json({ error: 'not_configured', detail: 'Set APP_PASSCODE and TOKEN_SECRET secrets.' }, 500);
    }
    const body = await readJson(request);
    const passcode = typeof body.passcode === 'string' ? body.passcode : '';
    if (!(await safeEqual(passcode, env.APP_PASSCODE))) {
      await sleep(800); // slow down guessing
      return json({ error: 'bad_passcode' }, 401);
    }
    const exp = Date.now() + TOKEN_DAYS * 864e5;
    const token = await signToken({ sub: 'owner', exp }, env.TOKEN_SECRET);
    return json({ token, exp });
  }

  // Everything below needs a valid token.
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const claims = token && env.TOKEN_SECRET ? await verifyToken(token, env.TOKEN_SECRET) : null;
  if (!claims) return json({ error: 'unauthorized' }, 401);

  if (path === '/api/sync' && request.method === 'POST') {
    return sync(await readJson(request), env);
  }

  return json({ error: 'not_found' }, 404);
}

// Push local changes, then pull everything newer than the client's cursor.
async function sync(body, env) {
  const db = env.DB;
  const since = Number.isInteger(body.since) ? body.since : 0;
  const changes = Array.isArray(body.changes) ? body.changes.slice(0, MAX_CHANGES_PER_PUSH) : [];

  let accepted = 0;
  if (changes.length) {
    const ids = changes.map((c) => String(c.id));
    const existing = new Map();
    // D1 limits bound parameters per statement; look up in chunks.
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const rows = await db
        .prepare(`SELECT id, updated_at FROM records WHERE id IN (${chunk.map(() => '?').join(',')})`)
        .bind(...chunk)
        .all();
      for (const r of rows.results) existing.set(r.id, r.updated_at);
    }

    const seqRow = await db.prepare(`SELECT value FROM meta WHERE key = 'seq'`).first();
    let seq = Number(seqRow ? seqRow.value : 0);
    const stmts = [];
    for (const c of changes) {
      if (!isValidChange(c)) continue;
      const prev = existing.get(c.id);
      if (prev && prev >= c.updated_at) continue; // server copy is as new or newer
      seq += 1;
      accepted += 1;
      stmts.push(
        db
          .prepare(
            `INSERT INTO records (id, company_id, type, data, updated_at, deleted, seq)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET company_id = excluded.company_id, type = excluded.type,
               data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted, seq = excluded.seq`
          )
          .bind(c.id, c.company_id, c.type, JSON.stringify(c.data || {}), c.updated_at, c.deleted ? 1 : 0, seq)
      );
    }
    if (stmts.length) {
      stmts.push(db.prepare(`UPDATE meta SET value = ? WHERE key = 'seq'`).bind(String(seq)));
      await db.batch(stmts);
    }
  }

  const rows = await db
    .prepare(`SELECT id, company_id, type, data, updated_at, deleted, seq FROM records WHERE seq > ? ORDER BY seq LIMIT ?`)
    .bind(since, MAX_CHANGES_PER_PULL)
    .all();
  const pulled = rows.results.map((r) => ({
    id: r.id,
    company_id: r.company_id,
    type: r.type,
    data: JSON.parse(r.data),
    updated_at: r.updated_at,
    deleted: !!r.deleted,
    seq: r.seq,
  }));
  const cursor = pulled.length ? pulled[pulled.length - 1].seq : since;
  return json({ accepted, cursor, more: pulled.length === MAX_CHANGES_PER_PULL, changes: pulled });
}

function isValidChange(c) {
  return (
    c &&
    typeof c.id === 'string' && c.id.length > 0 && c.id.length <= 64 &&
    typeof c.type === 'string' && /^[a-z_]{1,40}$/.test(c.type) &&
    typeof c.company_id === 'string' && c.company_id.length <= 64 &&
    typeof c.updated_at === 'string' && !Number.isNaN(Date.parse(c.updated_at))
  );
}

// ---------- helpers ----------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, enc.encode(data));
}

async function signToken(claims, secret) {
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  return `${payload}.${b64url(await hmac(secret, payload))}`;
}

async function verifyToken(token, secret) {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = b64url(await hmac(secret, payload));
  if (!(await safeEqual(sig, expected))) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    return claims.exp > Date.now() ? claims : null;
  } catch {
    return null;
  }
}

// Constant-time comparison via hashing both sides.
async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
