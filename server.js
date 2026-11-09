'use strict';
// Гэр360 API — үл хөдлөх хөрөнгийн зарын сайтын backend.
// Node.js API сервер: JSON API, нэвтрэлт (админ, агент), зураг хадгалах (/uploads).
// Өгөгдөл: PostgreSQL (Neon) — db.js. Зураг: диск (STORAGE_DIR/uploads).
// Frontend (listing-web, Next.js) /api болон /uploads хүсэлтийг API_URL-аар энд дамжуулна.
const path = require('path');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env file: use real environment variables */ }

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');

// PORT-ийг Railway/Render/Fly зэрэг хостинг автоматаар өгнө.
const PORT = Number(process.env.PORT || process.env.API_PORT) || 4000;
const PRODUCTION = process.env.NODE_ENV === 'production';
// Зураг (uploads/) хадгалах хавтас. Production дээр байнгын диск (volume) руу заана.
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || __dirname);
const UP = path.join(STORAGE_DIR, 'uploads');

const CATEGORIES = ['apartment', 'house', 'land', 'office', 'shop', 'warehouse', 'garage', 'summer_house'];
const DISTRICTS = ['Баянзүрх', 'Баянгол', 'Сүхбаатар', 'Чингэлтэй', 'Хан-Уул', 'Сонгинохайрхан', 'Налайх', 'Багануур', 'Багахангай'];
const PAY_TERMS = ['Бэлэн', 'Банкны зээл', 'Ипотек', 'Бартер'];
const DAY = 864e5;

fs.mkdirSync(path.join(UP, 'u'), { recursive: true });

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

function httpError(status, message) { return Object.assign(new Error(message), { status }); }
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'Файл хэт том байна')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSON(req) {
  const b = await readBody(req, 2e6);
  try { return JSON.parse(b.toString('utf8') || '{}'); } catch { throw httpError(400, 'Буруу JSON'); }
}

/* ---------- helpers ---------- */
const now = () => Date.now();
const promoRank = (l) => (!l.placementUntil || Date.parse(l.placementUntil) < now()) ? 0 : l.placement === 'top' ? 2 : l.placement === 'vip' ? 1 : 0;
function pub(l) {
  const { ownerPhone, ownerId, ...rest } = l;
  return { ...rest, promo: promoRank(l) };
}
// Хүсэлт Vercel (Next.js rewrite) болон хостингийн proxy-гоор дамжиж ирдэг тул жинхэнэ IP x-forwarded-for-д байна.
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

/* ---------- validation ---------- */
const cleanStr = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const cleanNum = (v, min, max) => { const n = Number(v); return v !== '' && v != null && Number.isFinite(n) && n >= min && n <= max ? n : undefined; };
const cleanInt = (v, min, max) => { const n = cleanNum(v, min, max); return n === undefined ? undefined : Math.round(n); };
function cleanImg(o) {
  if (!o || typeof o.src !== 'string' || !/^\/uploads\/[\w\-/]+\.(jpg|jpeg|png|webp)$/.test(o.src) || o.src.includes('..')) return null;
  return { src: o.src, width: cleanNum(o.width, 1, 20000) || 0, height: cleanNum(o.height, 1, 20000) || 0 };
}
function cleanTour(t) {
  if (!t || !Array.isArray(t.rooms)) return undefined;
  const rooms = t.rooms.slice(0, 30).map((r) => {
    const panorama = cleanImg(r && r.panorama);
    if (!panorama) return null;
    return {
      id: cleanStr(r.id, 40) || crypto.randomBytes(4).toString('hex'),
      name: cleanStr(r.name, 60) || 'Өрөө',
      source: ['upload360', 'stitched', 'ai', 'splat'].includes(r.source) ? r.source : 'upload360',
      sourcePhotos: [], panorama, status: 'ready',
      startYaw: cleanNum(r.startYaw, -360, 360) || 0,
      hotspots: (Array.isArray(r.hotspots) ? r.hotspots : []).slice(0, 20).map((h) => ({
        yaw: cleanNum(h.yaw, -360, 360) || 0, pitch: cleanNum(h.pitch, -90, 90) || 0,
        targetRoomId: cleanStr(h.targetRoomId, 40), label: cleanStr(h.label, 60),
      })),
    };
  }).filter(Boolean);
  if (!rooms.length) return undefined;
  const ids = new Set(rooms.map((r) => r.id));
  rooms.forEach((r) => { r.hotspots = r.hotspots.filter((h) => ids.has(h.targetRoomId) && h.targetRoomId !== r.id); });
  return { startRoomId: ids.has(t.startRoomId) ? t.startRoomId : rooms[0].id, rooms };
}
async function buildListing(b, user) {
  const errors = [];
  const category = CATEGORIES.includes(b.category) ? b.category : null;
  if (!category) errors.push('Ангилал сонгоно уу');
  const dealType = b.dealType === 'rent' ? 'rent' : 'sale';
  const title = cleanStr(b.title, 120);
  if (title.length < 5) errors.push('Гарчиг хамгийн багадаа 5 тэмдэгт');
  const price = cleanNum(b.price, 1, 1e13);
  if (!price) errors.push('Үнэ оруулна уу');
  const area = cleanNum(b.area, 0.5, 1e7);
  if (!area) errors.push('Талбай оруулна уу');
  const loc = b.location || {};
  const district = DISTRICTS.includes(loc.district) ? loc.district : null;
  if (!district) errors.push('Дүүрэг сонгоно уу');
  const lat = cleanNum(loc.lat, 41, 52.5), lng = cleanNum(loc.lng, 87, 120);
  if (lat === undefined || lng === undefined) errors.push('Газрын зураг дээр байршлаа тэмдэглэнэ үү');
  const sellerName = cleanStr(b.sellerName, 60) || user.name;
  if (!sellerName) errors.push('Нэрээ оруулна уу');
  const ownerPhone = cleanStr(b.sellerPhone, 20).replace(/\D/g, '') || user.phone || '';
  if (!/^\d{8}$/.test(ownerPhone)) errors.push('Утасны дугаар 8 оронтой байна');
  const photos = (Array.isArray(b.photos) ? b.photos : []).slice(0, 20).map(cleanImg).filter(Boolean);
  if (errors.length) throw httpError(400, errors.join('. '));
  const placement = ['vip', 'top'].includes(b.placement) ? b.placement : 'free';
  const t = now();
  return {
    id: await db.nextListingId(), ownerId: user.id, ownerPhone, sellerName,
    // agents always post as agents; an admin may label the seller type
    sellerType: user.role === 'agent' ? 'agent' : ['owner', 'agent', 'company'].includes(b.sellerType) ? b.sellerType : 'agent',
    category, dealType, title, price, pricePerM2: Math.round(price / area),
    rooms: cleanInt(b.rooms, 0, 100), area, floor: cleanInt(b.floor, -5, 200), buildingFloors: cleanInt(b.buildingFloors, 1, 200),
    yearInUse: cleanInt(b.yearInUse, 1900, 2100), floorMaterial: cleanStr(b.floorMaterial, 40) || undefined,
    balconies: cleanInt(b.balconies, 0, 20), windowType: cleanStr(b.windowType, 40) || undefined,
    windowCount: cleanInt(b.windowCount, 0, 200), doorType: cleanStr(b.doorType, 40) || undefined,
    garage: !!b.garage, leasing: !!b.leasing,
    paymentTerms: (Array.isArray(b.paymentTerms) ? b.paymentTerms : []).filter((p) => PAY_TERMS.includes(p)),
    location: { city: 'Улаанбаатар', district, khoroo: cleanStr(loc.khoroo, 40), address: cleanStr(loc.address, 160), lat, lng },
    description: cleanStr(b.description, 5000), photos, tour: cleanTour(b.tour),
    placement, placementUntil: placement === 'free' ? undefined : new Date(t + 7 * DAY).toISOString(),
    // agents' ads wait for admin approval; the admin's own ads go live directly
    status: user.role === 'admin' ? 'active' : 'pending',
    views: 0, createdAt: new Date(t).toISOString(), expiresAt: new Date(t + 30 * DAY).toISOString(),
  };
}

/* ---------- users & sessions ----------
   Only admins and agents have accounts (no public sign-up: the admin creates agents).
   Login: email + password. Passwords: scrypt + per-user salt. Sessions: random token in an
   HttpOnly cookie; only its SHA-256 hash is stored in Postgres. */
const SESSION_COOKIE = 'ger360_session';
const SESSION_DAYS = 14;
const ROLES = ['admin', 'agent'];
const COOKIE_SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === '1' : PRODUCTION;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPassword(user, pw) {
  const got = crypto.scryptSync(String(pw), user.salt, 64);
  const want = Buffer.from(user.hash, 'hex');
  return want.length === got.length && crypto.timingSafeEqual(got, want);
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email || '', phone: u.phone, role: u.role, active: u.active, createdAt: u.createdAt, mustChangePassword: !!u.mustChangePassword };
}
const validPassword = (pw) => typeof pw === 'string' && pw.length >= 8 && pw.length <= 200;
/** Login identifier: an email address (Gmail or any other), stored lower-case. */
const normEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase().slice(0, 254) : '');
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const DEFAULT_ADMIN_EMAIL = 'admin@example.com';
const DEMO_AGENT_EMAIL = 'agent@example.com';

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* bad cookie */ } }
  }
  return out;
}
function sessionCookie(token, maxAgeSec) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${COOKIE_SECURE ? '; Secure' : ''}`;
}
async function currentUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return db.sessionUser(sha256(token));
}
async function requireUser(req, roles, { allowMustChange = false } = {}) {
  const u = await currentUser(req);
  if (!u) throw httpError(401, 'Нэвтэрнэ үү');
  if (roles && !roles.includes(u.role)) throw httpError(403, 'Танд энэ үйлдлийг хийх эрх байхгүй');
  // default / admin-set passwords must be replaced before doing anything else
  if (u.mustChangePassword && !allowMustChange) throw httpError(403, 'Эхлээд нууц үгээ солино уу');
  return u;
}

/* login attempts: 10 failures per IP+email in 15 minutes (in memory: one API instance) */
const loginFails = new Map();
function loginBlocked(key) {
  const t = now(), arr = (loginFails.get(key) || []).filter((x) => t - x < 15 * 60e3);
  loginFails.set(key, arr);
  return arr.length >= 10;
}
function loginFailed(key) { loginFails.set(key, [...(loginFails.get(key) || []), now()]); }
const DUMMY_USER = hashPassword(crypto.randomBytes(8).toString('hex')); // same work for unknown emails

/* ---------- rate limit for "show phone" ---------- */
const phoneHits = new Map();
function phoneAllowed(ip) {
  const t = now(), arr = (phoneHits.get(ip) || []).filter((x) => t - x < 10 * 60e3);
  if (arr.length >= 30) return false;
  arr.push(t); phoneHits.set(ip, arr); return true;
}

/* ---------- API ---------- */
async function handleApi(req, res, u) {
  const p = u.pathname, m = req.method;
  let mm;
  await db.expireOld();

  if (m === 'GET' && p === '/api/listings') {
    const r = await db.searchListings(u.searchParams);
    return send(res, 200, { ...r, items: r.items.map(pub) });
  }

  if (m === 'GET' && p === '/api/stats') return send(res, 200, await db.stats());

  /* --- auth --- */
  if (m === 'POST' && p === '/api/auth/login') {
    const b = await readJSON(req);
    const email = normEmail(b.email);
    if (!validEmail(email)) throw httpError(400, 'Имэйл хаягаа зөв оруулна уу');
    const key = `${clientIp(req)}|${email}`;
    if (loginBlocked(key)) throw httpError(429, 'Хэт олон удаа буруу оролдлоо. 15 минутын дараа дахин оролдоно уу.');
    const user = await db.userByEmail(email);
    const ok = checkPassword(user || DUMMY_USER, b.password || '');
    if (!user || !ok) { loginFailed(key); throw httpError(401, 'Имэйл эсвэл нууц үг буруу'); }
    if (!user.active) throw httpError(403, 'Таны эрх идэвхгүй болсон байна. Админд хандана уу.');
    loginFails.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    await db.createSession(sha256(token), user.id, SESSION_DAYS);
    return send(res, 200, { user: publicUser(user) }, { 'set-cookie': sessionCookie(token, SESSION_DAYS * 86400) });
  }

  if (m === 'POST' && p === '/api/auth/logout') {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) await db.deleteSession(sha256(token));
    return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
  }

  if (m === 'GET' && p === '/api/auth/me') {
    const user = await currentUser(req);
    return send(res, 200, { user: user ? publicUser(user) : null });
  }

  if (m === 'POST' && p === '/api/auth/password') {
    const user = await requireUser(req, ROLES, { allowMustChange: true });
    const b = await readJSON(req);
    if (!checkPassword(user, b.current || '')) throw httpError(400, 'Одоогийн нууц үг буруу');
    if (!validPassword(b.next)) throw httpError(400, 'Шинэ нууц үг хамгийн багадаа 8 тэмдэгт байна');
    if (b.next === b.current) throw httpError(400, 'Шинэ нууц үг хуучнаасаа өөр байх ёстой');
    const updated = await db.updateUser(user.id, { ...hashPassword(b.next), mustChangePassword: false });
    await db.deleteUserSessions(user.id, sha256(parseCookies(req)[SESSION_COOKIE] || '')); // log out other devices
    return send(res, 200, { user: publicUser(updated) });
  }

  /* --- listings --- */
  if ((mm = p.match(/^\/api\/listings\/(\w+)$/)) && m === 'GET') {
    const l = await db.getListing(mm[1]);
    const me = l && l.status !== 'active' ? await currentUser(req) : null;
    if (!l || (l.status !== 'active' && !(me && (me.role === 'admin' || me.id === l.ownerId)))) throw httpError(404, 'Зар олдсонгүй');
    if (u.searchParams.get('noview') !== '1' && l.status === 'active') { await db.addView(l.id); l.views++; }
    return send(res, 200, pub(l));
  }

  if ((mm = p.match(/^\/api\/listings\/(\w+)\/phone$/)) && m === 'GET') {
    const l = await db.getListing(mm[1]);
    if (!l || l.status !== 'active') throw httpError(404, 'Зар олдсонгүй');
    if (!phoneAllowed(clientIp(req))) throw httpError(429, 'Хэт олон хүсэлт. Түр хүлээгээд дахин оролдоно уу.');
    return send(res, 200, { phone: l.ownerPhone });
  }

  if ((mm = p.match(/^\/api\/listings\/(\w+)\/report$/)) && m === 'POST') {
    const l = await db.getListing(mm[1]);
    if (!l) throw httpError(404, 'Зар олдсонгүй');
    const b = await readJSON(req);
    await db.addReport({ id: crypto.randomBytes(6).toString('hex'), listingId: l.id, reason: cleanStr(b.reason, 40) || 'other', note: cleanStr(b.note, 500) });
    return send(res, 200, { ok: true });
  }

  if ((mm = p.match(/^\/api\/listings\/(\w+)\/owner$/)) && m === 'POST') {
    const me = await requireUser(req, ROLES);
    const l = await db.getListing(mm[1]);
    const b = await readJSON(req);
    if (!l) throw httpError(404, 'Зар олдсонгүй');
    if (me.role !== 'admin' && l.ownerId !== me.id) throw httpError(403, 'Энэ зар таных биш');
    if (b.action === 'sold') await db.setListingStatus(l.id, 'sold');
    else if (b.action === 'renew') await db.renewListing(l.id);
    else if (b.action === 'bump') { if (l.status !== 'active') throw httpError(400, 'Зөвхөн идэвхтэй зарыг дээшлүүлнэ'); await db.bumpListing(l.id); }
    else if (b.action === 'delete') await db.deleteListing(l.id);
    else throw httpError(400, 'Үйлдэл буруу');
    return send(res, 200, { ok: true });
  }

  if (m === 'POST' && p === '/api/listings') {
    const me = await requireUser(req, ROLES);
    const l = await buildListing(await readJSON(req), me);
    await db.insertListing(l);
    return send(res, 201, { id: l.id, status: l.status });
  }

  if (m === 'GET' && p === '/api/mine') {
    const me = await requireUser(req, ROLES);
    return send(res, 200, { items: (await db.listingsByOwner(me.id)).map(pub) });
  }

  if (m === 'POST' && p === '/api/upload') {
    await requireUser(req, ROLES);
    const buf = await readBody(req, 25e6);
    let ext = null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ext = 'jpg';
    else if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') ext = 'png';
    else if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') ext = 'webp';
    if (!ext) throw httpError(415, 'Зөвхөн JPG, PNG, WEBP зураг');
    const name = `${crypto.randomBytes(10).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(UP, 'u', name), buf);
    return send(res, 201, { src: `/uploads/u/${name}` });
  }

  /* --- admin --- */
  if (p.startsWith('/api/admin/')) {
    const me = await requireUser(req, ['admin']);
    if (m === 'GET' && p === '/api/admin/listings') {
      const [items, reports] = await Promise.all([db.adminListings(), db.recentReports()]);
      return send(res, 200, { items: items.map((l) => ({ ...pub(l), ownerPhone: l.ownerPhone, ownerName: l.ownerName, reports: l.reports })), reports });
    }
    if ((mm = p.match(/^\/api\/admin\/listings\/(\w+)$/)) && m === 'POST') {
      const l = await db.getListing(mm[1]);
      if (!l) throw httpError(404, 'Зар олдсонгүй');
      const b = await readJSON(req);
      if (b.action === 'delete') await db.deleteListing(l.id); // reports go with it (on delete cascade)
      else if (['active', 'rejected', 'pending', 'expired', 'sold'].includes(b.status)) {
        await db.setListingStatus(l.id, b.status);
        if (b.status === 'active') await db.clearReports(l.id);
      } else throw httpError(400, 'Төлөв буруу');
      return send(res, 200, { ok: true });
    }

    /* agent accounts (created by the admin; no public sign-up) */
    if (m === 'GET' && p === '/api/admin/users') {
      return send(res, 200, { users: (await db.listUsers()).map((x) => ({ ...publicUser(x), listings: x.listings })) });
    }
    if (m === 'POST' && p === '/api/admin/users') {
      const b = await readJSON(req);
      const name = cleanStr(b.name, 60);
      const email = normEmail(b.email);
      const phone = cleanStr(b.phone, 20).replace(/\D/g, '');
      const errors = [];
      if (!name) errors.push('Нэр оруулна уу');
      if (!validEmail(email)) errors.push('Имэйл хаяг буруу байна');
      else if (await db.emailTaken(email)) errors.push('Энэ имэйлтэй хэрэглэгч бүртгэлтэй байна');
      if (!/^\d{8}$/.test(phone)) errors.push('Утасны дугаар (зар дээрх холбоо барих) 8 оронтой байна');
      if (!validPassword(b.password)) errors.push('Нууц үг хамгийн багадаа 8 тэмдэгт');
      if (errors.length) throw httpError(400, errors.join('. '));
      const user = {
        id: 'u-' + crypto.randomBytes(6).toString('hex'), name, email, phone, role: 'agent', active: true,
        mustChangePassword: true, ...hashPassword(b.password),
      };
      await db.insertUser(user);
      return send(res, 201, { user: publicUser(await db.userById(user.id)) });
    }
    if ((mm = p.match(/^\/api\/admin\/users\/([\w-]+)$/)) && m === 'POST') {
      const user = await db.userById(mm[1]);
      if (!user) throw httpError(404, 'Хэрэглэгч олдсонгүй');
      const b = await readJSON(req);
      if (user.id === me.id && b.active === false) throw httpError(400, 'Өөрийгөө идэвхгүй болгох боломжгүй');
      const patch = {};
      if (typeof b.name === 'string' && cleanStr(b.name, 60)) patch.name = cleanStr(b.name, 60);
      if (b.email !== undefined) {
        const email = normEmail(b.email);
        if (!validEmail(email)) throw httpError(400, 'Имэйл хаяг буруу байна');
        if (await db.emailTaken(email, user.id)) throw httpError(400, 'Энэ имэйлтэй хэрэглэгч бүртгэлтэй байна');
        patch.email = email;
      }
      if (typeof b.active === 'boolean') patch.active = b.active;
      if (b.password !== undefined) {
        if (!validPassword(b.password)) throw httpError(400, 'Нууц үг хамгийн багадаа 8 тэмдэгт');
        Object.assign(patch, hashPassword(b.password), { mustChangePassword: true });
      }
      const updated = await db.updateUser(user.id, patch);
      if (patch.active === false || patch.hash) await db.deleteUserSessions(user.id);
      return send(res, 200, { user: publicUser(updated) });
    }
  }
  throw httpError(404, 'API олдсонгүй');
}

/* ---------- uploaded images (/uploads/...) ---------- */
function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/uploads\//, '');
  const fp = path.normalize(path.join(UP, rel));
  if (!fp.startsWith(UP + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Олдсонгүй'); }
    res.writeHead(200, {
      'content-type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    });
    fs.createReadStream(fp).pipe(res);
  });
}

/* ---------- startup: schema, demo data, first accounts ---------- */
async function bootstrap() {
  await db.migrate();
  const seed = require('./seed');
  const { rows: [{ n }] } = await db.q('select count(*) as n from listings');
  const wantDemo = process.env.SEED_DEMO ? process.env.SEED_DEMO === '1' : !PRODUCTION;
  if (n === 0 && wantDemo) {
    console.log('Хоосон өгөгдлийн сан: жишээ зар оруулж байна…');
    for (const l of seed.seedListings()) await db.insertListing(l);
    await db.syncListingSequence();
  }
  // demo images live on disk: (re)generate them when the database has demo ads but this disk doesn't
  const { rows: demoRows } = await db.q(`select 1 from listings where details->>'demo' = 'true' limit 1`);
  if (demoRows.length && !seed.demoImagesPresent(UP)) {
    console.log('Жишээ зургуудыг үүсгэж байна (хэдэн секунд)…');
    seed.generateImages(UP);
  }

  if ((await db.countUsers('admin')) === 0) {
    const email = normEmail(process.env.ADMIN_EMAIL) || DEFAULT_ADMIN_EMAIL;
    const pw = process.env.ADMIN_PASSWORD;
    if (PRODUCTION && !pw) {
      console.error('Анхны админ үүсгэхийн тулд production дээр ADMIN_EMAIL, ADMIN_PASSWORD орчны хувьсагчийг тохируулна уу.');
      process.exit(1);
    }
    await db.insertUser({ id: 'u-admin', name: 'Админ', email, role: 'admin', mustChangePassword: !pw, ...hashPassword(pw || 'admin') });
    console.log(pw ? `Админ хэрэглэгч үүслээ: ${email}` : `Админ хэрэглэгч үүслээ: ${email} / "admin" — анх нэвтрээд нууц үгээ солино уу.`);
  }
  if ((await db.countUsers('agent')) === 0 && (await db.hasDemoAgencyListings())) {
    await db.insertUser({ id: 'u-demo-agent', name: 'Гэр Агент ХХК', email: DEMO_AGENT_EMAIL, phone: '99000004', role: 'agent', ...hashPassword('agent1234') });
    console.log(`Жишээ агент үүслээ: ${DEMO_AGENT_EMAIL} / "agent1234".`);
  }
  await db.linkListingsToAgents();
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/')) return await handleApi(req, res, u);
    if (u.pathname.startsWith('/uploads/')) return serveStatic(req, res, u.pathname);
    if (u.pathname === '/health') {
      try { await db.q('select 1'); return send(res, 200, { ok: true, db: 'ok' }); } catch { return send(res, 503, { ok: false, db: 'down' }); }
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Гэр360 API.');
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Серверийн алдаа' });
  }
});

bootstrap()
  .then(() => server.listen(PORT, () => {
    const host = (() => { try { return new URL(process.env.DATABASE_URL).host; } catch { return '?'; } })();
    console.log(`Гэр360 API: http://localhost:${PORT}  (Postgres: ${host}, зураг: ${UP})`);
  }))
  .catch((e) => { console.error('Эхлүүлэхэд алдаа гарлаа:', e.message); process.exit(1); });
