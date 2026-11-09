// Гэр360 API — Cloudflare Worker + Hono.
// Зар, хэрэглэгч, сесс PostgreSQL (Neon)-д, зураг R2-д.
// Frontend (listing-web, Next.js) /api, /uploads хүсэлтийг API_URL-аар энд дамжуулна.
import { Hono, type Context } from 'hono';
import { connect, databaseUrl, type Sql } from './db.ts';
import { search } from './search.ts';
import {
  HttpError, buildListing, cleanStr, fromRow, noFromId, pub, randomHex, toRow,
  type Listing, type ListingRow,
} from './listings.ts';
import {
  ROLES, SESSION_COOKIE, SESSION_DAYS, checkLogin, clearLoginFailures, createSession, createUser, deleteSession,
  deleteUserSessions, emailTaken, listUsers, loginBlocked, normEmail, publicUser, readCookie, recordLoginFailure,
  sessionCookie, sessionUser, updateUser, userByEmail, userById, validEmail, validPassword, type Role, type User,
} from './auth.ts';

type Env = {
  DATABASE_URL?: string;                          // .dev.vars / `wrangler secret put DATABASE_URL`
  HYPERDRIVE?: { connectionString: string };      // optional Hyperdrive binding in production
  UPLOADS: R2Bucket;
  COOKIE_SECURE?: string;                         // '1' / '0'; default: Secure when the request is https
};
type Vars = { sql: Sql; user: User | null | undefined };
type C = Context<{ Bindings: Env; Variables: Vars }>;
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

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

// Хүсэлт Vercel (Next.js rewrite)-ээр дамжиж ирдэг тул жинхэнэ IP x-forwarded-for-д байна.
const clientIp = (c: C) =>
  (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || c.req.header('cf-connecting-ip') || 'unknown';

const cookieSecure = (c: C) => (c.env.COOKIE_SECURE ? c.env.COOKIE_SECURE === '1' : new URL(c.req.url).protocol === 'https:');
const sessionToken = (c: C) => readCookie(c.req.header('cookie'), SESSION_COOKIE);

async function findListing(sql: Sql, id: string): Promise<Listing | null> {
  const no = noFromId(id);
  if (no === null) return null;
  const [row] = await sql<ListingRow[]>`select * from listings where no = ${no}`;
  return row ? fromRow(row) : null;
}

async function currentUser(c: C) {
  if (c.get('user') === undefined) c.set('user', await sessionUser(c.get('sql'), sessionToken(c)));
  return c.get('user')!;
}
async function requireUser(c: C, roles: Role[] = ROLES, { allowMustChange = false } = {}) {
  const u = await currentUser(c);
  if (!u) throw new HttpError(401, 'Нэвтэрнэ үү');
  if (!roles.includes(u.role)) throw new HttpError(403, 'Танд энэ үйлдлийг хийх эрх байхгүй');
  // default / admin-set passwords must be replaced before doing anything else
  if (u.mustChangePassword && !allowMustChange) throw new HttpError(403, 'Эхлээд нууц үгээ солино уу');
  return u;
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

/* ---------- database per request ---------- */
let lastExpiry = 0;
app.use('/api/*', async (c, next) => {
  const sql = connect(databaseUrl(c.env));
  c.set('sql', sql);
  try {
    // Хугацаа дууссан идэвхтэй заруудыг 'expired' болгоно (isolate бүрт минутад нэг удаа; fromRow ч бас шалгадаг)
    if (Date.now() - lastExpiry > 60_000) {
      lastExpiry = Date.now();
      await sql`update listings set status = 'expired' where status = 'active' and expires_at < now()`;
    }
    await next();
  } finally {
    c.executionCtx.waitUntil(sql.end());
  }
});

/* ---------- public ---------- */
app.get('/api/listings', async (c) => json(c, await search(c.get('sql'), new URL(c.req.url).searchParams)));

app.get('/api/stats', async (c) => {
  const rows = await c.get('sql')<{ deal_type: string; category: string; n: number }[]>`
    select deal_type, category, count(*)::int as n from listings where status = 'active' group by deal_type, category`;
  const counts: Record<string, number> = {};
  let total = 0;
  for (const r of rows) { counts[`${r.deal_type}:${r.category}`] = r.n; total += r.n; }
  return json(c, { counts, total });
});

app.get('/api/listings/:id', async (c) => {
  const sql = c.get('sql');
  const l = await findListing(sql, c.req.param('id'));
  if (!l) throw new HttpError(404, 'Зар олдсонгүй');
  if (l.status !== 'active') {
    const me = await currentUser(c);
    if (!me || (me.role !== 'admin' && me.id !== l.ownerId)) throw new HttpError(404, 'Зар олдсонгүй');
  }
  if (c.req.query('noview') !== '1' && l.status === 'active') {
    await sql`update listings set views = views + 1 where no = ${noFromId(l.id)}`;
    l.views++;
  }
  return json(c, pub(l));
});

app.get('/api/listings/:id/phone', async (c) => {
  const l = await findListing(c.get('sql'), c.req.param('id'));
  if (!l || l.status !== 'active') throw new HttpError(404, 'Зар олдсонгүй');
  if (!phoneAllowed(clientIp(c))) throw new HttpError(429, 'Хэт олон хүсэлт. Түр хүлээгээд дахин оролдоно уу.');
  return json(c, { phone: l.ownerPhone });
});

app.post('/api/listings/:id/report', async (c) => {
  const sql = c.get('sql');
  const l = await findListing(sql, c.req.param('id'));
  if (!l) throw new HttpError(404, 'Зар олдсонгүй');
  const b = await readJSON(c);
  await sql`insert into reports (id, listing_id, reason, note)
            values (${randomHex(6)}, ${l.id}, ${cleanStr(b.reason, 40) || 'other'}, ${cleanStr(b.note, 500)})`;
  return json(c, { ok: true });
});

/* ---------- auth ---------- */
app.post('/api/auth/login', async (c) => {
  const sql = c.get('sql');
  const b = await readJSON(c);
  const email = normEmail(b.email);
  if (!validEmail(email)) throw new HttpError(400, 'Имэйл хаягаа зөв оруулна уу');
  const key = `${clientIp(c)}|${email}`;
  if (await loginBlocked(sql, key)) throw new HttpError(429, 'Хэт олон удаа буруу оролдлоо. 15 минутын дараа дахин оролдоно уу.');
  const user = await userByEmail(sql, email);
  if (!(await checkLogin(user, b.password))) {
    await recordLoginFailure(sql, key);
    throw new HttpError(401, 'Имэйл эсвэл нууц үг буруу');
  }
  if (!user!.active) throw new HttpError(403, 'Таны эрх идэвхгүй болсон байна. Админд хандана уу.');
  await clearLoginFailures(sql, key);
  const token = await createSession(sql, user!.id);
  c.header('set-cookie', sessionCookie(token, SESSION_DAYS * 86400, cookieSecure(c)));
  return json(c, { user: publicUser(user!) });
});

app.post('/api/auth/logout', async (c) => {
  await deleteSession(c.get('sql'), sessionToken(c));
  c.header('set-cookie', sessionCookie('', 0, cookieSecure(c)));
  return json(c, { ok: true });
});

app.get('/api/auth/me', async (c) => {
  const u = await currentUser(c);
  return json(c, { user: u ? publicUser(u) : null });
});

app.post('/api/auth/password', async (c) => {
  const sql = c.get('sql');
  const me = await requireUser(c, ROLES, { allowMustChange: true });
  const b = await readJSON(c);
  if (!(await checkLogin(me, b.current))) throw new HttpError(400, 'Одоогийн нууц үг буруу');
  if (!validPassword(b.next)) throw new HttpError(400, 'Шинэ нууц үг хамгийн багадаа 8 тэмдэгт байна');
  if (b.next === b.current) throw new HttpError(400, 'Шинэ нууц үг хуучнаасаа өөр байх ёстой');
  const updated = await updateUser(sql, me.id, { password: b.next, mustChangePassword: false });
  await deleteUserSessions(sql, me.id, sessionToken(c)); // log out other devices
  return json(c, { user: publicUser(updated!) });
});

/* ---------- agent / admin: own ads ---------- */
app.post('/api/listings', async (c) => {
  const sql = c.get('sql');
  const me = await requireUser(c);
  const l = buildListing(await readJSON(c), me);
  const r = toRow(l);
  const cols = Object.keys(r);
  // postgres.js serializes the jsonb `data` object itself (the server tells it the parameter type)
  const vals = cols.map((k, i) => `$${i + 1}${k === 'data' ? '::jsonb' : ''}`);
  const [{ no }] = await sql.unsafe<{ no: number }[]>(
    `insert into listings (${cols.join(', ')}) values (${vals.join(', ')}) returning no`, Object.values(r) as any[]);
  return json(c, { id: 'L' + no, status: l.status }, 201);
});

app.get('/api/mine', async (c) => {
  const me = await requireUser(c);
  const rows = await c.get('sql')<ListingRow[]>`select * from listings where owner_id = ${me.id} order by created_at desc`;
  return json(c, { items: rows.map((r) => pub(fromRow(r))) });
});

app.post('/api/listings/:id/owner', async (c) => {
  const sql = c.get('sql');
  const me = await requireUser(c);
  const l = await findListing(sql, c.req.param('id'));
  const b = await readJSON(c);
  if (!l) throw new HttpError(404, 'Зар олдсонгүй');
  if (me.role !== 'admin' && l.ownerId !== me.id) throw new HttpError(403, 'Энэ зар таных биш');
  const no = noFromId(l.id);
  if (b.action === 'sold') await sql`update listings set status = 'sold' where no = ${no}`;
  else if (b.action === 'renew') {
    await sql`update listings set expires_at = now() + interval '30 days',
              status = case status when 'expired' then 'active' else status end where no = ${no}`;
  } else if (b.action === 'bump') {
    if (l.status !== 'active') throw new HttpError(400, 'Зөвхөн идэвхтэй зарыг дээшлүүлнэ');
    await sql`update listings set created_at = now() where no = ${no}`;
  } else if (b.action === 'delete') {
    await sql`delete from reports where listing_id = ${l.id}`;
    await sql`delete from listings where no = ${no}`;
  } else throw new HttpError(400, 'Үйлдэл буруу');
  return json(c, { ok: true });
});

const MAX_UPLOAD = 25e6;
app.post('/api/upload', async (c) => {
  await requireUser(c);
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
  await requireUser(c, ['admin']);
  await next();
});

app.get('/api/admin/listings', async (c) => {
  const sql = c.get('sql');
  const rows = await sql<(ListingRow & { owner_name: string | null; report_count: number })[]>`
    select l.*, u.name as owner_name,
           (select count(*)::int from reports r where r.listing_id = 'L' || l.no) as report_count
    from listings l left join users u on u.id = l.owner_id
    order by l.created_at desc, l.no asc`;
  const reports = await sql`select id, listing_id as "listingId", reason, note, created_at as "createdAt" from reports order by created_at desc limit 200`;
  const items = rows.map((r) => {
    const l = fromRow(r);
    return { ...pub(l), ownerPhone: l.ownerPhone, ownerName: r.owner_name, reports: r.report_count };
  });
  return json(c, { items, reports });
});

const STATUSES = ['active', 'rejected', 'pending', 'expired', 'sold'];
app.post('/api/admin/listings/:id', async (c) => {
  const sql = c.get('sql');
  const l = await findListing(sql, c.req.param('id'));
  if (!l) throw new HttpError(404, 'Зар олдсонгүй');
  const b = await readJSON(c);
  const no = noFromId(l.id);
  if (b.action === 'delete') {
    await sql`delete from reports where listing_id = ${l.id}`;
    await sql`delete from listings where no = ${no}`;
  } else if (STATUSES.includes(b.status)) {
    await sql`update listings set status = ${b.status} where no = ${no}`;
    if (b.status === 'active') await sql`delete from reports where listing_id = ${l.id}`;
  } else throw new HttpError(400, 'Төлөв буруу');
  return json(c, { ok: true });
});

/* agent accounts (created by the admin; no public sign-up) */
app.get('/api/admin/users', async (c) => json(c, { users: await listUsers(c.get('sql')) }));

app.post('/api/admin/users', async (c) => {
  const sql = c.get('sql');
  const b = await readJSON(c);
  const name = cleanStr(b.name, 60);
  const email = normEmail(b.email);
  const phone = cleanStr(b.phone, 20).replace(/\D/g, '');
  const errors: string[] = [];
  if (!name) errors.push('Нэр оруулна уу');
  if (!validEmail(email)) errors.push('Имэйл хаяг буруу байна');
  else if (await emailTaken(sql, email)) errors.push('Энэ имэйлтэй хэрэглэгч бүртгэлтэй байна');
  if (!/^\d{8}$/.test(phone)) errors.push('Утасны дугаар (зар дээрх холбоо барих) 8 оронтой байна');
  if (!validPassword(b.password)) errors.push('Нууц үг хамгийн багадаа 8 тэмдэгт');
  if (errors.length) throw new HttpError(400, errors.join('. '));
  const user = await createUser(sql, { name, email, phone, role: 'agent', password: b.password, mustChangePassword: true });
  return json(c, { user: publicUser(user) }, 201);
});

app.post('/api/admin/users/:id', async (c) => {
  const sql = c.get('sql');
  const me = (await currentUser(c))!;
  const user = await userById(sql, c.req.param('id'));
  if (!user) throw new HttpError(404, 'Хэрэглэгч олдсонгүй');
  const b = await readJSON(c);
  if (user.id === me.id && b.active === false) throw new HttpError(400, 'Өөрийгөө идэвхгүй болгох боломжгүй');
  const patch: Parameters<typeof updateUser>[2] = {};
  if (typeof b.name === 'string' && cleanStr(b.name, 60)) patch.name = cleanStr(b.name, 60);
  if (b.email !== undefined) {
    const email = normEmail(b.email);
    if (!validEmail(email)) throw new HttpError(400, 'Имэйл хаяг буруу байна');
    if (await emailTaken(sql, email, user.id)) throw new HttpError(400, 'Энэ имэйлтэй хэрэглэгч бүртгэлтэй байна');
    patch.email = email;
  }
  if (typeof b.active === 'boolean') patch.active = b.active;
  if (b.password !== undefined) {
    if (!validPassword(b.password)) throw new HttpError(400, 'Нууц үг хамгийн багадаа 8 тэмдэгт');
    patch.password = b.password;
    patch.mustChangePassword = true;
  }
  const updated = await updateUser(sql, user.id, patch);
  if (patch.active === false || patch.password) await deleteUserSessions(sql, user.id);
  return json(c, { user: publicUser(updated!) });
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

app.get('/health', async (c) => {
  const sql = connect(databaseUrl(c.env));
  try {
    await sql`select 1`;
    return json(c, { ok: true, db: 'ok' });
  } catch {
    return c.json({ ok: false, db: 'down' }, 503, { 'cache-control': 'no-store' });
  } finally {
    c.executionCtx.waitUntil(sql.end());
  }
});
app.notFound((c) => c.text('Гэр360 API.', 404));

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400, { 'cache-control': 'no-store' });
  console.error(err);
  return c.json({ error: 'Серверийн алдаа' }, 500, { 'cache-control': 'no-store' });
});

export default app;
