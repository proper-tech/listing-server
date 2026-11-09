// Гэр360 API — Cloudflare Worker + Hono.
// Зар, гомдол D1-д, зураг R2-д. Frontend (listing-web, Next.js) /api, /uploads хүсэлтийг API_URL-аар энд дамжуулна.
import { Hono, type Context } from 'hono';
import { search } from './search.ts';
import {
  DAY, HttpError, buildListing, cleanStr, fromRow, noFromId, pub, randomHex, toRow,
  type Listing, type ListingRow,
} from './listings.ts';

type Env = { DB: D1Database; UPLOADS: R2Bucket; ADMIN_KEY?: string };
type C = Context<{ Bindings: Env }>;
const app = new Hono<{ Bindings: Env }>();

/* ---------- helpers ---------- */
const json = (c: C, obj: unknown, status: 200 | 201 = 200) => c.json(obj, status, { 'cache-control': 'no-store' });

async function readJSON(c: C): Promise<any> {
  const text = await c.req.text();
  if (text.length > 2e6) throw new HttpError(413, 'Хүсэлт хэт том байна');
  try {
    const v = JSON.parse(text || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch { throw new HttpError(400, 'Буруу JSON'); }
}

// ADMIN_KEY тохируулаагүй бол админ хэсэг хаалттай.
const isAdmin = (c: C) => !!c.env.ADMIN_KEY && c.req.header('x-admin-key') === c.env.ADMIN_KEY;

// Хүсэлт Vercel (Next.js rewrite)-ээр дамжиж ирдэг тул жинхэнэ IP x-forwarded-for-д байна.
const clientIp = (c: C) =>
  (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || c.req.header('cf-connecting-ip') || 'unknown';

async function findListing(db: D1Database, id: string): Promise<Listing | null> {
  const no = noFromId(id);
  if (no === null) return null;
  const row = await db.prepare('SELECT * FROM listings WHERE no = ?').bind(no).first<ListingRow>();
  return row ? fromRow(row) : null;
}

/* ---------- "show phone" rate limit ----------
   Isolate бүрийн санах ойд хадгалдаг тул бүх Worker instance-д нийтлэг биш (ойролцоо хязгаар). */
const phoneHits = new Map<string, number[]>();
function phoneAllowed(ip: string) {
  const t = Date.now(), arr = (phoneHits.get(ip) || []).filter((x) => t - x < 10 * 60e3);
  if (arr.length >= 30) return false;
  arr.push(t);
  if (phoneHits.size > 5000) phoneHits.clear();
  phoneHits.set(ip, arr);
  return true;
}

/* ---------- API ---------- */
// Хугацаа дууссан идэвхтэй заруудыг 'expired' болгоно (хүсэлт бүрийн өмнө, индекстэй хурдан query).
app.use('/api/*', async (c, next) => {
  await c.env.DB.prepare(`UPDATE listings SET status = 'expired' WHERE status = 'active' AND expires_at < ?`).bind(Date.now()).run();
  await next();
});

app.get('/api/listings', async (c) => json(c, await search(c.env.DB, new URL(c.req.url).searchParams)));

app.get('/api/stats', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT deal_type, category, COUNT(*) AS n FROM listings WHERE status = 'active' GROUP BY deal_type, category`,
  ).all<{ deal_type: string; category: string; n: number }>();
  const counts: Record<string, number> = {};
  let total = 0;
  for (const r of results) { counts[`${r.deal_type}:${r.category}`] = r.n; total += r.n; }
  return json(c, { counts, total });
});

app.get('/api/listings/:id', async (c) => {
  const l = await findListing(c.env.DB, c.req.param('id'));
  const token = c.req.query('token');
  if (!l || (l.status !== 'active' && !(token && token === l.ownerToken) && !isAdmin(c))) throw new HttpError(404, 'Зар олдсонгүй');
  if (c.req.query('noview') !== '1' && l.status === 'active') {
    await c.env.DB.prepare('UPDATE listings SET views = views + 1 WHERE no = ?').bind(noFromId(l.id)).run();
    l.views++;
  }
  return json(c, pub(l));
});

app.get('/api/listings/:id/phone', async (c) => {
  const l = await findListing(c.env.DB, c.req.param('id'));
  if (!l || l.status !== 'active') throw new HttpError(404, 'Зар олдсонгүй');
  if (!phoneAllowed(clientIp(c))) throw new HttpError(429, 'Хэт олон хүсэлт. Түр хүлээгээд дахин оролдоно уу.');
  return json(c, { phone: l.ownerPhone });
});

app.post('/api/listings/:id/report', async (c) => {
  const l = await findListing(c.env.DB, c.req.param('id'));
  if (!l) throw new HttpError(404, 'Зар олдсонгүй');
  const b = await readJSON(c);
  await c.env.DB.prepare('INSERT INTO reports (id, listing_id, reason, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(randomHex(4), l.id, cleanStr(b.reason, 40) || 'other', cleanStr(b.note, 500), new Date().toISOString()).run();
  return json(c, { ok: true });
});

app.post('/api/listings/:id/owner', async (c) => {
  const l = await findListing(c.env.DB, c.req.param('id'));
  const b = await readJSON(c);
  if (!l || !b.token || b.token !== l.ownerToken) throw new HttpError(403, 'Эрхгүй');
  const db = c.env.DB, no = noFromId(l.id), t = Date.now();
  if (b.action === 'sold') await db.prepare(`UPDATE listings SET status = 'sold' WHERE no = ?`).bind(no).run();
  else if (b.action === 'renew') {
    await db.prepare(`UPDATE listings SET expires_at = ?, status = CASE status WHEN 'expired' THEN 'active' ELSE status END WHERE no = ?`)
      .bind(t + 30 * DAY, no).run();
  } else if (b.action === 'bump') {
    if (l.status !== 'active') throw new HttpError(400, 'Зөвхөн идэвхтэй зарыг дээшлүүлнэ');
    await db.prepare('UPDATE listings SET created_at = ? WHERE no = ?').bind(t, no).run();
  } else if (b.action === 'delete') await db.prepare('DELETE FROM listings WHERE no = ?').bind(no).run();
  else throw new HttpError(400, 'Үйлдэл буруу');
  return json(c, { ok: true });
});

app.post('/api/listings', async (c) => {
  const l = buildListing(await readJSON(c));
  const r = toRow(l);
  const cols = Object.keys(r);
  const res = await c.env.DB.prepare(`INSERT INTO listings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .bind(...Object.values(r)).run();
  return json(c, { id: 'L' + res.meta.last_row_id, token: l.ownerToken, status: l.status }, 201);
});

app.post('/api/mine', async (c) => {
  const b = await readJSON(c);
  const tokens = (Array.isArray(b.tokens) ? b.tokens : []).filter((x: unknown) => typeof x === 'string').slice(0, 200);
  if (!tokens.length) return json(c, { items: [] });
  // D1 нэг query-д 100 хүртэл параметр зөвшөөрдөг тул токенуудыг нэг JSON массиваар дамжуулна
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM listings WHERE owner_token IN (SELECT value FROM json_each(?)) ORDER BY no',
  ).bind(JSON.stringify(tokens)).all<ListingRow>();
  return json(c, { items: results.map((r) => { const l = fromRow(r); return { ...pub(l), token: l.ownerToken }; }) });
});

const MAX_UPLOAD = 25e6;
app.post('/api/upload', async (c) => {
  if (Number(c.req.header('content-length') || 0) > MAX_UPLOAD) throw new HttpError(413, 'Файл хэт том байна');
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.length > MAX_UPLOAD) throw new HttpError(413, 'Файл хэт том байна');
  const ascii = (a: number, b: number) => String.fromCharCode(...buf.subarray(a, b));
  let ext: string | null = null, type = '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) { ext = 'jpg'; type = 'image/jpeg'; }
  else if (buf[0] === 0x89 && ascii(1, 4) === 'PNG') { ext = 'png'; type = 'image/png'; }
  else if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') { ext = 'webp'; type = 'image/webp'; }
  if (!ext) throw new HttpError(415, 'Зөвхөн JPG, PNG, WEBP зураг');
  const name = `${randomHex(10)}.${ext}`;
  await c.env.UPLOADS.put(`u/${name}`, buf, { httpMetadata: { contentType: type } });
  return json(c, { src: `/uploads/u/${name}` }, 201);
});

/* ---------- admin ---------- */
app.use('/api/admin/*', async (c, next) => {
  if (!isAdmin(c)) throw new HttpError(401, 'Админы түлхүүр буруу');
  await next();
});

app.get('/api/admin/listings', async (c) => {
  const db = c.env.DB;
  const [listings, counts, reports] = await db.batch([
    db.prepare('SELECT * FROM listings ORDER BY created_at DESC, no ASC'),
    db.prepare('SELECT listing_id, COUNT(*) AS n FROM reports GROUP BY listing_id'),
    db.prepare('SELECT id, listing_id AS listingId, reason, note, created_at AS createdAt FROM reports ORDER BY rowid DESC LIMIT 200'),
  ]);
  const byId = new Map((counts.results as { listing_id: string; n: number }[]).map((r) => [r.listing_id, r.n]));
  const items = (listings.results as ListingRow[]).map((r) => {
    const l = fromRow(r);
    return { ...pub(l), ownerPhone: l.ownerPhone, reports: byId.get(l.id) || 0 };
  });
  return json(c, { items, reports: reports.results });
});

const STATUSES = ['active', 'rejected', 'pending', 'expired', 'sold'];
app.post('/api/admin/listings/:id', async (c) => {
  const l = await findListing(c.env.DB, c.req.param('id'));
  if (!l) throw new HttpError(404, 'Зар олдсонгүй');
  const b = await readJSON(c);
  const db = c.env.DB, no = noFromId(l.id);
  const dropReports = db.prepare('DELETE FROM reports WHERE listing_id = ?').bind(l.id);
  if (b.action === 'delete') await db.batch([db.prepare('DELETE FROM listings WHERE no = ?').bind(no), dropReports]);
  else if (STATUSES.includes(b.status)) {
    const setStatus = db.prepare('UPDATE listings SET status = ? WHERE no = ?').bind(b.status, no);
    await db.batch(b.status === 'active' ? [setStatus, dropReports] : [setStatus]);
  } else throw new HttpError(400, 'Төлөв буруу');
  return json(c, { ok: true });
});

app.all('/api/*', () => { throw new HttpError(404, 'API олдсонгүй'); });

/* ---------- uploaded images (/uploads/...) from R2 ---------- */
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
app.get('/uploads/*', async (c) => {
  let key: string;
  try { key = decodeURIComponent(c.req.path).replace(/^\/uploads\//, ''); } catch { return c.text('Олдсонгүй', 404); }
  if (!key || key.includes('..') || key.startsWith('/')) return c.text('Олдсонгүй', 404);
  const obj = await c.env.UPLOADS.get(key, { onlyIf: c.req.raw.headers });
  if (!obj) return c.text('Олдсонгүй', 404);
  const headers = new Headers({
    'content-type': obj.httpMetadata?.contentType || MIME[key.split('.').pop()!.toLowerCase()] || 'application/octet-stream',
    'cache-control': 'public, max-age=86400',
    'x-content-type-options': 'nosniff',
    etag: obj.httpEtag,
  });
  if (!('body' in obj)) return new Response(null, { status: 304, headers }); // If-None-Match таарсан
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { headers });
});

app.get('/health', (c) => json(c, { ok: true }));
app.notFound((c) => c.text('Гэр360 API.', 404));

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400, { 'cache-control': 'no-store' });
  console.error(err);
  return c.json({ error: 'Серверийн алдаа' }, 500, { 'cache-control': 'no-store' });
});

export default app;
