'use strict';
// PostgreSQL (Neon) давхарга: холболт, схем, бүх SQL асуулга энд.
// DATABASE_URL-д Neon-ий connection string (…?sslmode=require) өгнө.
const { Pool, types } = require('pg');

types.setTypeParser(20, (v) => Number(v)); // int8 / count(*) → number

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL тохируулаагүй байна. .env файлд Neon-ий connection string-ийг оруулна уу (README-г үзнэ үү).');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30_000,
});
pool.on('error', (e) => console.error('Postgres холболтын алдаа:', e.message));
const q = (text, params) => pool.query(text, params);

const SCHEMA = `
create table if not exists users (
  id text primary key,
  name text not null,
  email text unique,
  phone text not null default '',
  role text not null check (role in ('admin', 'agent')),
  active boolean not null default true,
  must_change_password boolean not null default false,
  salt text not null,
  hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  token_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_idx on sessions (user_id);

create sequence if not exists listing_no start with 100001;

create table if not exists listings (
  id text primary key,
  owner_id text references users(id) on delete set null,
  owner_phone text not null,
  seller_name text not null,
  seller_type text not null,
  category text not null,
  deal_type text not null,
  title text not null,
  price double precision not null,
  price_per_m2 double precision,
  rooms integer,
  area double precision,
  floor integer,
  building_floors integer,
  year_in_use integer,
  garage boolean not null default false,
  leasing boolean not null default false,
  has_tour boolean not null default false,
  district text not null,
  lat double precision not null,
  lng double precision not null,
  placement text not null default 'free',
  placement_until timestamptz,
  status text not null,
  views integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- the rest (description, photos, 360° tour, materials, payment terms, address…)
  details jsonb not null default '{}'::jsonb
);
create index if not exists listings_browse_idx on listings (status, deal_type, category);
create index if not exists listings_district_idx on listings (district);
create index if not exists listings_created_idx on listings (created_at desc);
create index if not exists listings_price_idx on listings (price);
create index if not exists listings_owner_idx on listings (owner_id);

create table if not exists reports (
  id text primary key,
  listing_id text not null references listings(id) on delete cascade,
  reason text not null,
  note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists reports_listing_idx on reports (listing_id);
`;

async function migrate() { await q(SCHEMA); }

/* ---------- row mapping ---------- */
const nn = (v) => (v === null ? undefined : v);
const iso = (d) => (d ? new Date(d).toISOString() : undefined);

function rowToListing(r) {
  const d = r.details || {};
  return {
    id: r.id, ownerId: nn(r.owner_id), ownerPhone: r.owner_phone, sellerName: r.seller_name, sellerType: r.seller_type,
    category: r.category, dealType: r.deal_type, title: r.title, price: r.price, pricePerM2: nn(r.price_per_m2),
    rooms: nn(r.rooms), area: nn(r.area), floor: nn(r.floor), buildingFloors: nn(r.building_floors), yearInUse: nn(r.year_in_use),
    floorMaterial: d.floorMaterial, balconies: d.balconies, windowType: d.windowType, windowCount: d.windowCount, doorType: d.doorType,
    garage: r.garage, leasing: r.leasing, paymentTerms: d.paymentTerms || [],
    location: { city: d.city || 'Улаанбаатар', district: r.district, khoroo: d.khoroo || '', address: d.address || '', lat: r.lat, lng: r.lng },
    description: d.description || '', photos: d.photos || [], tour: d.tour || undefined,
    placement: r.placement, placementUntil: iso(r.placement_until), status: r.status, views: r.views,
    createdAt: iso(r.created_at), expiresAt: iso(r.expires_at),
    hasTour: r.has_tour,
  };
}

const LISTING_COLS = [
  'id', 'owner_id', 'owner_phone', 'seller_name', 'seller_type', 'category', 'deal_type', 'title', 'price', 'price_per_m2',
  'rooms', 'area', 'floor', 'building_floors', 'year_in_use', 'garage', 'leasing', 'has_tour', 'district', 'lat', 'lng',
  'placement', 'placement_until', 'status', 'views', 'created_at', 'expires_at', 'details',
];
const toInt = (v) => (v === undefined || v === null || v === '' ? null : Math.round(Number(v)));
const hasReadyTour = (t) => !!(t && Array.isArray(t.rooms) && t.rooms.some((r) => r.status === 'ready'));

function listingToParams(l) {
  const loc = l.location || {};
  const details = {
    floorMaterial: l.floorMaterial, balconies: l.balconies, windowType: l.windowType, windowCount: l.windowCount, doorType: l.doorType,
    paymentTerms: l.paymentTerms || [], city: loc.city, khoroo: loc.khoroo, address: loc.address,
    description: l.description || '', photos: l.photos || [], tour: l.tour,
    demo: String(l.ownerToken || '').startsWith('demo-') || l.demo || undefined,
  };
  return [
    l.id, l.ownerId || null, l.ownerPhone, l.sellerName, l.sellerType, l.category, l.dealType, l.title, l.price, l.pricePerM2 ?? null,
    toInt(l.rooms), l.area ?? null, toInt(l.floor), toInt(l.buildingFloors), toInt(l.yearInUse), !!l.garage, !!l.leasing, hasReadyTour(l.tour),
    loc.district, loc.lat, loc.lng, l.placement || 'free', l.placementUntil || null, l.status, l.views || 0,
    l.createdAt || new Date().toISOString(), l.expiresAt, JSON.stringify(details),
  ];
}

async function insertListing(l) {
  const ph = LISTING_COLS.map((_, i) => `$${i + 1}`).join(', ');
  await q(`insert into listings (${LISTING_COLS.join(', ')}) values (${ph}) on conflict (id) do nothing`, listingToParams(l));
}

async function nextListingId() {
  const { rows } = await q("select nextval('listing_no') as n");
  return 'L' + rows[0].n;
}
async function syncListingSequence() {
  await q(`select setval('listing_no', greatest(100000, coalesce((select max(substring(id from 2)::bigint) from listings where id ~ '^L[0-9]+$'), 100000)))`);
}

/* ---------- listings ---------- */
const PROMO_SQL = `(case when placement_until > now() then (case placement when 'top' then 2 when 'vip' then 1 else 0 end) else 0 end)`;
const SORTS = {
  new: 'created_at desc',
  cheap: 'price asc',
  expensive: 'price desc',
  ppm2: 'price_per_m2 asc nulls last',
  area: 'area desc nulls last',
};
const num = (v) => { if (v === null || v === '' || v === undefined) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/** Public search: every filter from the plan's §4, done in SQL. */
async function searchListings(qs) {
  const g = (k) => qs.get(k);
  const where = ["status = 'active'"];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };

  if (g('deal')) where.push(`deal_type = ${p(g('deal'))}`);
  if (g('cat')) where.push(`category = ${p(g('cat'))}`);
  if (g('district')) where.push(`district = ${p(g('district'))}`);
  if (g('placement')) where.push(`placement = ${p(g('placement'))} and ${PROMO_SQL} > 0`);
  for (const [lo, hi, col] of [
    ['priceMin', 'priceMax', 'price'], ['ppmMin', 'ppmMax', 'price_per_m2'], ['areaMin', 'areaMax', 'area'],
    ['floorMin', 'floorMax', 'floor'], ['bfMin', 'bfMax', 'building_floors'], ['yearMin', 'yearMax', 'year_in_use'],
  ]) {
    if (num(g(lo)) !== null) where.push(`${col} >= ${p(num(g(lo)))}`);
    if (num(g(hi)) !== null) where.push(`${col} <= ${p(num(g(hi)))}`);
  }
  if (g('rooms')) {
    const set = g('rooms').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const exact = set.filter((r) => r < 5), five = set.some((r) => r >= 5);
    const parts = [];
    if (exact.length) parts.push(`rooms = any(${p(exact)}::int[])`);
    if (five) parts.push('rooms >= 5');
    if (parts.length) where.push(`(${parts.join(' or ')})`);
  }
  if (g('notFirst') === '1') where.push('floor > 1');
  if (g('notLast') === '1') where.push('floor < building_floors');
  if (g('leasing') === '1') where.push('leasing');
  if (g('tour') === '1') where.push('has_tour');
  if (g('garage') === '1') where.push('garage');
  if (num(g('posted'))) where.push(`created_at >= now() - ${p(num(g('posted')))}::float8 * interval '1 day'`);
  if (g('seller') === 'owner') where.push("seller_type = 'owner'");
  if (g('seller') === 'agent') where.push("seller_type <> 'owner'");
  if (g('q')) {
    const hay = `(title || ' ' || coalesce(details->>'description', '') || ' ' || district || ' ' || coalesce(details->>'khoroo', '') || ' ' || coalesce(details->>'address', ''))`;
    for (const w of g('q').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) where.push(`${hay} ilike ${p('%' + escapeLike(w) + '%')}`);
  }

  const sort = SORTS[g('sort')] || SORTS.new;
  const order = `${g('plain') === '1' ? '' : PROMO_SQL + ' desc, '}${sort}, id`;
  const per = Math.min(60, num(g('per')) || 24);
  const page = Math.max(1, Math.floor(num(g('page')) || 1));
  const whereSql = where.join(' and ');

  const [{ rows: [{ total }] }, { rows }] = await Promise.all([
    q(`select count(*) as total from listings where ${whereSql}`, params),
    q(`select * from listings where ${whereSql} order by ${order} limit ${per} offset ${(page - 1) * per}`, params),
  ]);
  return { total, page, per, items: rows.map(rowToListing) };
}

async function getListing(id) {
  const { rows } = await q('select * from listings where id = $1', [id]);
  return rows[0] ? rowToListing(rows[0]) : null;
}
async function addView(id) { await q('update listings set views = views + 1 where id = $1', [id]); }

async function stats() {
  const { rows } = await q(`select deal_type, category, count(*) as n from listings where status = 'active' group by deal_type, category`);
  const counts = {};
  let total = 0;
  for (const r of rows) { counts[`${r.deal_type}:${r.category}`] = r.n; total += r.n; }
  return { counts, total };
}

let lastExpiry = 0;
/** Mark ads past their end date as expired (at most once a minute). */
async function expireOld() {
  if (Date.now() - lastExpiry < 60_000) return;
  lastExpiry = Date.now();
  await q(`update listings set status = 'expired' where status = 'active' and expires_at < now()`);
}

async function listingsByOwner(ownerId) {
  const { rows } = await q('select * from listings where owner_id = $1 order by created_at desc', [ownerId]);
  return rows.map(rowToListing);
}

async function setListingStatus(id, status) { await q('update listings set status = $2 where id = $1', [id, status]); }
async function renewListing(id) {
  await q(`update listings set expires_at = now() + interval '30 days', status = case when status = 'expired' then 'active' else status end where id = $1`, [id]);
}
async function bumpListing(id) { await q('update listings set created_at = now() where id = $1', [id]); }
async function deleteListing(id) { await q('delete from listings where id = $1', [id]); }

async function adminListings() {
  const { rows } = await q(`
    select l.*, u.name as owner_name, (select count(*) from reports r where r.listing_id = l.id) as report_count
    from listings l left join users u on u.id = l.owner_id
    order by l.created_at desc`);
  return rows.map((r) => ({ ...rowToListing(r), ownerName: r.owner_name || null, reports: r.report_count }));
}

/* ---------- reports ---------- */
async function addReport(r) {
  await q('insert into reports (id, listing_id, reason, note) values ($1, $2, $3, $4)', [r.id, r.listingId, r.reason, r.note || '']);
}
async function recentReports() {
  const { rows } = await q('select * from reports order by created_at desc limit 200');
  return rows.map((r) => ({ id: r.id, listingId: r.listing_id, reason: r.reason, note: r.note, createdAt: iso(r.created_at) }));
}
async function clearReports(listingId) { await q('delete from reports where listing_id = $1', [listingId]); }

/* ---------- users & sessions ---------- */
function rowToUser(r) {
  return {
    id: r.id, name: r.name, email: r.email || '', phone: r.phone, role: r.role, active: r.active,
    mustChangePassword: r.must_change_password, salt: r.salt, hash: r.hash, createdAt: iso(r.created_at),
  };
}
async function userById(id) { const { rows } = await q('select * from users where id = $1', [id]); return rows[0] ? rowToUser(rows[0]) : null; }
async function userByEmail(email) { const { rows } = await q('select * from users where email = $1', [email]); return rows[0] ? rowToUser(rows[0]) : null; }
async function emailTaken(email, exceptId) {
  const { rows } = await q('select 1 from users where email = $1 and id <> $2', [email, exceptId || '']);
  return rows.length > 0;
}
async function countUsers(role) { const { rows } = await q('select count(*) as n from users where role = $1', [role]); return rows[0].n; }
async function insertUser(u) {
  await q(`insert into users (id, name, email, phone, role, active, must_change_password, salt, hash, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10::timestamptz, now())) on conflict (id) do nothing`,
  [u.id, u.name, u.email || null, u.phone || '', u.role, u.active !== false, !!u.mustChangePassword, u.salt, u.hash, u.createdAt || null]);
}
const USER_FIELDS = { name: 'name', email: 'email', active: 'active', mustChangePassword: 'must_change_password', salt: 'salt', hash: 'hash' };
async function updateUser(id, patch) {
  const sets = [], params = [id];
  for (const [k, col] of Object.entries(USER_FIELDS)) if (patch[k] !== undefined) { params.push(patch[k]); sets.push(`${col} = $${params.length}`); }
  if (!sets.length) return userById(id);
  const { rows } = await q(`update users set ${sets.join(', ')} where id = $1 returning *`, params);
  return rows[0] ? rowToUser(rows[0]) : null;
}
async function listUsers() {
  const { rows } = await q(`select u.*, (select count(*) from listings l where l.owner_id = u.id) as listing_count from users u order by u.role, u.created_at`);
  return rows.map((r) => ({ ...rowToUser(r), listings: r.listing_count }));
}
/** Give ownerless (seed/imported) listings to the agent with the same contact phone. */
async function linkListingsToAgents() {
  await q(`update listings l set owner_id = u.id from users u
           where l.owner_id is null and u.role = 'agent' and u.phone <> '' and u.phone = l.owner_phone`);
}
async function hasDemoAgencyListings() {
  const { rows } = await q(`select 1 from listings where owner_phone = '99000004' and details->>'demo' = 'true' limit 1`);
  return rows.length > 0;
}

async function createSession(tokenHash, userId, days) {
  await q(`insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + $3::int * interval '1 day')`, [tokenHash, userId, days]);
  await q('delete from sessions where expires_at < now()');
}
async function sessionUser(tokenHash) {
  const { rows } = await q(`select u.* from sessions s join users u on u.id = s.user_id
                            where s.token_hash = $1 and s.expires_at > now() and u.active`, [tokenHash]);
  return rows[0] ? rowToUser(rows[0]) : null;
}
async function deleteSession(tokenHash) { await q('delete from sessions where token_hash = $1', [tokenHash]); }
async function deleteUserSessions(userId, exceptHash) {
  await q('delete from sessions where user_id = $1 and token_hash <> $2', [userId, exceptHash || '']);
}

module.exports = {
  pool, q, migrate,
  insertListing, nextListingId, syncListingSequence, searchListings, getListing, addView, stats, expireOld,
  listingsByOwner, setListingStatus, renewListing, bumpListing, deleteListing, adminListings,
  addReport, recentReports, clearReports,
  userById, userByEmail, emailTaken, countUsers, insertUser, updateUser, listUsers, linkListingsToAgents, hasDemoAgencyListings,
  createSession, sessionUser, deleteSession, deleteUserSessions,
};
