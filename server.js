'use strict';
// Гэр360 API — үл хөдлөх хөрөнгийн зарын сайтын backend.
// Хамаарал шаардахгүй Node.js API сервер: JSON API, зураг хадгалах, /uploads.
// Frontend (listing-web, Next.js) /api болон /uploads хүсэлтийг API_URL-аар энд дамжуулна.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// PORT-ийг Railway/Render/Fly зэрэг хостинг автоматаар өгнө.
const PORT = Number(process.env.PORT || process.env.API_PORT) || 4000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin';
if (process.env.NODE_ENV === 'production' && ADMIN_KEY === 'admin') {
  console.error('ADMIN_KEY орчны хувьсагчийг production дээр заавал тохируулна уу.');
  process.exit(1);
}
// Өгөгдөл (data/) болон зураг (uploads/) хадгалах хавтас. Production дээр байнгын диск (volume) руу заана.
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || __dirname);
const UP = path.join(STORAGE_DIR, 'uploads');
const DATA_DIR = path.join(STORAGE_DIR, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const CATEGORIES = ['apartment', 'house', 'land', 'office', 'shop', 'warehouse', 'garage', 'summer_house'];
const DISTRICTS = ['Баянзүрх', 'Баянгол', 'Сүхбаатар', 'Чингэлтэй', 'Хан-Уул', 'Сонгинохайрхан', 'Налайх', 'Багануур', 'Багахангай'];
const PAY_TERMS = ['Бэлэн', 'Банкны зээл', 'Ипотек', 'Бартер'];
const DAY = 864e5;

fs.mkdirSync(path.join(UP, 'u'), { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) {
  console.log('Анхны жишээ өгөгдөл, зургуудыг үүсгэж байна (хэдэн секунд)...');
  require('./seed').seed({ dbFile: DB_FILE, uploadDir: UP });
}
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(DB_FILE + '.tmp', DB_FILE);
  }, 150);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon',
};

function httpError(status, message) { return Object.assign(new Error(message), { status }); }
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
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
const hasTour = (l) => !!(l.tour && Array.isArray(l.tour.rooms) && l.tour.rooms.some((r) => r.status === 'ready'));
function pub(l) {
  const { ownerPhone, ownerToken, ...rest } = l;
  return { ...rest, hasTour: hasTour(l), promo: promoRank(l) };
}
function refreshExpiry() {
  const t = now();
  for (const l of db.listings) if (l.status === 'active' && Date.parse(l.expiresAt) < t) l.status = 'expired';
}
const findListing = (id) => db.listings.find((l) => l.id === id);
const isAdmin = (req) => req.headers['x-admin-key'] === ADMIN_KEY;
// Хүсэлт Vercel (Next.js rewrite) болон хостингийн proxy-гоор дамжиж ирдэг тул жинхэнэ IP x-forwarded-for-д байна.
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

const num = (v) => { if (v === null || v === '' || v === undefined) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

function search(q) {
  let items = db.listings.filter((l) => l.status === 'active');
  const g = (k) => q.get(k);
  if (g('deal')) items = items.filter((l) => l.dealType === g('deal'));
  if (g('cat')) items = items.filter((l) => l.category === g('cat'));
  if (g('district')) items = items.filter((l) => l.location.district === g('district'));
  if (g('placement')) items = items.filter((l) => l.placement === g('placement') && promoRank(l) > 0);
  const range = (minK, maxK, get) => {
    const lo = num(g(minK)), hi = num(g(maxK));
    if (lo !== null) items = items.filter((l) => get(l) != null && get(l) >= lo);
    if (hi !== null) items = items.filter((l) => get(l) != null && get(l) <= hi);
  };
  range('priceMin', 'priceMax', (l) => l.price);
  range('ppmMin', 'ppmMax', (l) => l.pricePerM2);
  range('areaMin', 'areaMax', (l) => l.area);
  range('floorMin', 'floorMax', (l) => l.floor);
  range('bfMin', 'bfMax', (l) => l.buildingFloors);
  range('yearMin', 'yearMax', (l) => l.yearInUse);
  if (g('rooms')) {
    const set = g('rooms').split(',').map(Number).filter(Boolean);
    items = items.filter((l) => l.rooms != null && set.some((r) => (r >= 5 ? l.rooms >= 5 : l.rooms === r)));
  }
  if (g('notFirst') === '1') items = items.filter((l) => l.floor > 1);
  if (g('notLast') === '1') items = items.filter((l) => l.floor && l.buildingFloors && l.floor < l.buildingFloors);
  if (g('leasing') === '1') items = items.filter((l) => l.leasing);
  if (g('tour') === '1') items = items.filter(hasTour);
  if (g('garage') === '1') items = items.filter((l) => l.garage);
  if (num(g('posted'))) items = items.filter((l) => Date.parse(l.createdAt) >= now() - num(g('posted')) * DAY);
  if (g('seller') === 'owner') items = items.filter((l) => l.sellerType === 'owner');
  if (g('seller') === 'agent') items = items.filter((l) => l.sellerType !== 'owner');
  if (g('q')) {
    const words = g('q').toLowerCase().split(/\s+/).filter(Boolean);
    items = items.filter((l) => {
      const hay = `${l.title} ${l.description} ${l.location.district} ${l.location.khoroo} ${l.location.address}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  const sorters = {
    new: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    cheap: (a, b) => a.price - b.price,
    expensive: (a, b) => b.price - a.price,
    ppm2: (a, b) => (a.pricePerM2 ?? Infinity) - (b.pricePerM2 ?? Infinity),
    area: (a, b) => (b.area ?? 0) - (a.area ?? 0),
  };
  const sorter = sorters[g('sort')] || sorters.new;
  const plain = g('plain') === '1';
  items.sort((a, b) => (plain ? 0 : promoRank(b) - promoRank(a)) || sorter(a, b));
  const per = Math.min(60, num(g('per')) || 24);
  const page = Math.max(1, num(g('page')) || 1);
  return { total: items.length, page, per, items: items.slice((page - 1) * per, page * per).map(pub) };
}

/* ---------- validation ---------- */
const cleanStr = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const cleanNum = (v, min, max) => { const n = Number(v); return v !== '' && v != null && Number.isFinite(n) && n >= min && n <= max ? n : undefined; };
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
function buildListing(b) {
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
  const sellerName = cleanStr(b.sellerName, 60);
  if (!sellerName) errors.push('Нэрээ оруулна уу');
  const ownerPhone = cleanStr(b.sellerPhone, 20).replace(/\D/g, '');
  if (!/^\d{8}$/.test(ownerPhone)) errors.push('Утасны дугаар 8 оронтой байна');
  const photos = (Array.isArray(b.photos) ? b.photos : []).slice(0, 20).map(cleanImg).filter(Boolean);
  if (errors.length) throw httpError(400, errors.join('. '));
  const placement = ['vip', 'top'].includes(b.placement) ? b.placement : 'free';
  const t = now();
  return {
    id: 'L' + db.nextNo++, ownerToken: crypto.randomBytes(16).toString('hex'), ownerPhone,
    sellerName, sellerType: ['owner', 'agent', 'company'].includes(b.sellerType) ? b.sellerType : 'owner',
    category, dealType, title, price, pricePerM2: Math.round(price / area),
    rooms: cleanNum(b.rooms, 0, 100), area, floor: cleanNum(b.floor, -5, 200), buildingFloors: cleanNum(b.buildingFloors, 1, 200),
    yearInUse: cleanNum(b.yearInUse, 1900, 2100), floorMaterial: cleanStr(b.floorMaterial, 40) || undefined,
    balconies: cleanNum(b.balconies, 0, 20), windowType: cleanStr(b.windowType, 40) || undefined,
    windowCount: cleanNum(b.windowCount, 0, 200), doorType: cleanStr(b.doorType, 40) || undefined,
    garage: !!b.garage, leasing: !!b.leasing,
    paymentTerms: (Array.isArray(b.paymentTerms) ? b.paymentTerms : []).filter((p) => PAY_TERMS.includes(p)),
    location: { city: 'Улаанбаатар', district, khoroo: cleanStr(loc.khoroo, 40), address: cleanStr(loc.address, 160), lat, lng },
    description: cleanStr(b.description, 5000), photos, tour: cleanTour(b.tour),
    placement, placementUntil: placement === 'free' ? undefined : new Date(t + 7 * DAY).toISOString(),
    status: 'pending', views: 0, createdAt: new Date(t).toISOString(), expiresAt: new Date(t + 30 * DAY).toISOString(),
  };
}

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
  refreshExpiry();

  if (m === 'GET' && p === '/api/listings') return send(res, 200, search(u.searchParams));

  if (m === 'GET' && p === '/api/stats') {
    const counts = {};
    for (const l of db.listings) if (l.status === 'active') {
      const k = `${l.dealType}:${l.category}`; counts[k] = (counts[k] || 0) + 1;
    }
    return send(res, 200, { counts, total: db.listings.filter((l) => l.status === 'active').length });
  }

  if ((mm = p.match(/^\/api\/listings\/(\w+)$/)) && m === 'GET') {
    const l = findListing(mm[1]);
    const token = u.searchParams.get('token');
    if (!l || (l.status !== 'active' && !(token && token === l.ownerToken) && !isAdmin(req))) throw httpError(404, 'Зар олдсонгүй');
    if (u.searchParams.get('noview') !== '1' && l.status === 'active') { l.views++; save(); }
    return send(res, 200, pub(l));
  }

  if ((mm = p.match(/^\/api\/listings\/(\w+)\/phone$/)) && m === 'GET') {
    const l = findListing(mm[1]);
    if (!l || l.status !== 'active') throw httpError(404, 'Зар олдсонгүй');
    if (!phoneAllowed(clientIp(req))) throw httpError(429, 'Хэт олон хүсэлт. Түр хүлээгээд дахин оролдоно уу.');
    return send(res, 200, { phone: l.ownerPhone });
  }

  if ((mm = p.match(/^\/api\/listings\/(\w+)\/report$/)) && m === 'POST') {
    const l = findListing(mm[1]);
    if (!l) throw httpError(404, 'Зар олдсонгүй');
    const b = await readJSON(req);
    db.reports.push({ id: crypto.randomBytes(4).toString('hex'), listingId: l.id, reason: cleanStr(b.reason, 40) || 'other', note: cleanStr(b.note, 500), createdAt: new Date().toISOString() });
    save();
    return send(res, 200, { ok: true });
  }

  if ((mm = p.match(/^\/api\/listings\/(\w+)\/owner$/)) && m === 'POST') {
    const l = findListing(mm[1]);
    const b = await readJSON(req);
    if (!l || !b.token || b.token !== l.ownerToken) throw httpError(403, 'Эрхгүй');
    const t = now();
    if (b.action === 'sold') l.status = 'sold';
    else if (b.action === 'renew') { l.expiresAt = new Date(t + 30 * DAY).toISOString(); if (l.status === 'expired') l.status = 'active'; }
    else if (b.action === 'bump') { if (l.status !== 'active') throw httpError(400, 'Зөвхөн идэвхтэй зарыг дээшлүүлнэ'); l.createdAt = new Date(t).toISOString(); }
    else if (b.action === 'delete') { db.listings.splice(db.listings.indexOf(l), 1); }
    else throw httpError(400, 'Үйлдэл буруу');
    save();
    return send(res, 200, { ok: true });
  }

  if (m === 'POST' && p === '/api/listings') {
    const l = buildListing(await readJSON(req));
    db.listings.push(l); save();
    return send(res, 201, { id: l.id, token: l.ownerToken, status: l.status });
  }

  if (m === 'POST' && p === '/api/mine') {
    const b = await readJSON(req);
    const tokens = new Set((Array.isArray(b.tokens) ? b.tokens : []).slice(0, 200));
    const items = db.listings.filter((l) => tokens.has(l.ownerToken)).map((l) => ({ ...pub(l), token: l.ownerToken }));
    return send(res, 200, { items });
  }

  if (m === 'POST' && p === '/api/upload') {
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

  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req)) throw httpError(401, 'Админы түлхүүр буруу');
    if (m === 'GET' && p === '/api/admin/listings') {
      const counts = {};
      for (const r of db.reports) counts[r.listingId] = (counts[r.listingId] || 0) + 1;
      const items = db.listings.map((l) => ({ ...pub(l), ownerPhone: l.ownerPhone, reports: counts[l.id] || 0 }))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      return send(res, 200, { items, reports: db.reports.slice(-200).reverse() });
    }
    if ((mm = p.match(/^\/api\/admin\/listings\/(\w+)$/)) && m === 'POST') {
      const l = findListing(mm[1]);
      if (!l) throw httpError(404, 'Зар олдсонгүй');
      const b = await readJSON(req);
      if (b.action === 'delete') { db.listings.splice(db.listings.indexOf(l), 1); db.reports = db.reports.filter((r) => r.listingId !== l.id); }
      else if (['active', 'rejected', 'pending', 'expired', 'sold'].includes(b.status)) {
        l.status = b.status;
        if (b.status === 'active') db.reports = db.reports.filter((r) => r.listingId !== l.id);
      } else throw httpError(400, 'Төлөв буруу');
      save();
      return send(res, 200, { ok: true });
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

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/')) return await handleApi(req, res, u);
    if (u.pathname.startsWith('/uploads/')) return serveStatic(req, res, u.pathname);
    if (u.pathname === '/health') return send(res, 200, { ok: true });
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Гэр360 API.');
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Серверийн алдаа' });
  }
}).listen(PORT, () => console.log(`Гэр360 API: http://localhost:${PORT}  (хадгалах хавтас: ${STORAGE_DIR}, админ түлхүүр: ${ADMIN_KEY === 'admin' ? 'admin' : '***'})`));
