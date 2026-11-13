// Зар (post / listing) CRUD.
//   GET    /api/posts              нийтийн жагсаалт — шүүлт + хуудаслалт (зөвхөн `active`)
//                                  `?mine=1` (нэвтэрсэн) — өөрийн бүх зар, төлөвөөс үл хамаарна
//   GET    /api/posts/stats        идэвхтэй зарын тоо `dealType:category`-аар
//   GET    /api/posts/:id          нийтийн дэлгэрэнгүй (`active`; бусад төлөв — зөвхөн эзэн/админ)
//                                  `?view=0` — үзсэн тоог нэмэгдүүлэхгүй
//   POST   /api/posts              (нэвтэрсэн) зар үүсгэх — агентынх `pending`, админых `active`
//   PATCH  /api/posts/:id          (эзэн эсвэл админ) засах
//   DELETE /api/posts/:id          (эзэн эсвэл админ) устгах (зураг нь cascade)
import { Hono } from "hono";
import {
  and, asc, count, desc, eq, getTableColumns, gt, gte, inArray, isNotNull, like, lt, ne, or, sql,
  type SQL, type SQLWrapper,
} from "drizzle-orm";
import { agents } from "../db/schema.ts";
import {
  CATEGORIES,
  DEAL_TYPES,
  PLACEMENTS,
  POST_STATUSES,
  SELLER_TYPES,
  postImages,
  posts,
  type Post,
  type PostStatus,
  type Tour,
} from "../db/posts.schema.ts";
import { requireAuth } from "../auth.ts";
import { IMAGE_KEY_PREFIX } from "./uploads.ts";
import type { Db } from "../db/index.ts";
import type { PublicAgent } from "../db/schema.ts";
import type { AppEnv } from "../types.ts";

export const postRoutes = new Hono<AppEnv>();

const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 60; // нэг хуудсанд; газрын зураг GET /pins-ээр (хөнгөн, 1000 хүртэл) авна
const MAX_IMAGES = 24;
const PROMO_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const UPLOAD_URL_PREFIX = `/api/uploads/${IMAGE_KEY_PREFIX}`;

// ---- хариу угсрах (зар + агент + зураг) ----
const postColumns = getTableColumns(posts);
const agentSel = { id: agents.id, name: agents.name, phone: agents.phone, avatarKey: agents.avatarKey };
type Row = Post & { agent: { id: number | null; name: string | null; phone: string | null; avatarKey: string | null } };
type ImageOut = { key: string; url: string; width: number | null; height: number | null; sortOrder: number };

const imagesByPost = async (db: Db, ids: number[]) => {
  const map = new Map<number, ImageOut[]>();
  if (ids.length === 0) return map;
  const rows = await db
    .select()
    .from(postImages)
    .where(inArray(postImages.postId, ids))
    .orderBy(asc(postImages.postId), asc(postImages.sortOrder), asc(postImages.id));
  for (const im of rows) {
    const arr = map.get(im.postId) ?? [];
    arr.push({ key: im.key, url: `/api/uploads/${im.key}`, width: im.width, height: im.height, sortOrder: im.sortOrder });
    map.set(im.postId, arr);
  }
  return map;
};

const serialize = (row: Row, images: ImageOut[]) => {
  const { agent, ...post } = row;
  return { ...post, agent: agent.id == null ? null : agent, images };
};

const withRelations = async (db: Db, rows: Row[]) => {
  const map = await imagesByPost(db, rows.map((r) => r.id));
  return rows.map((r) => serialize(r, map.get(r.id) ?? []));
};

// ---- баталгаажуулалт ----
const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

type Patch = Partial<typeof posts.$inferInsert>;
type ImageIn = { key: string; width: number | null; height: number | null };
type Parsed = { values: Patch; images?: ImageIn[] } | { error: string };

// 360° аялал: зөвхөн энэ серверт байршуулсан панорам, хэмжээ хязгаартай
function parseTour(t: unknown): Tour | null | { error: string } {
  if (t === null) return null;
  const bad = { error: "360° аяллын өгөгдөл буруу" };
  if (!isObj(t) || !Array.isArray(t.rooms) || t.rooms.length > 30) return bad;
  const rooms: Tour["rooms"] = [];
  for (const r of t.rooms) {
    if (!isObj(r) || !isObj(r.panorama)) return bad;
    const id = str(r.id), name = str(r.name) || "Өрөө", src = str(r.panorama.src);
    if (!id || id.length > 40 || name.length > 60) return bad;
    if (!src || !src.startsWith(UPLOAD_URL_PREFIX) || src.length > 300) return bad;
    const source = ["upload360", "stitched", "ai", "splat"].includes(r.source as string)
      ? (r.source as Tour["rooms"][number]["source"])
      : "upload360";
    const hotspots = Array.isArray(r.hotspots) ? r.hotspots.slice(0, 20) : [];
    // partial panorama: both angles or neither (absent = full sphere)
    const partial = isNum(r.haov) && isNum(r.vaov) && r.haov >= 30 && r.haov <= 360 && r.vaov >= 10 && r.vaov < 180;
    rooms.push({
      ...(partial ? { haov: r.haov as number, vaov: r.vaov as number } : {}),
      id, name, source, status: "ready",
      panorama: { src, width: isInt(r.panorama.width) ? r.panorama.width : 0, height: isInt(r.panorama.height) ? r.panorama.height : 0 },
      startYaw: isNum(r.startYaw) ? Math.max(-360, Math.min(360, r.startYaw)) : 0,
      hotspots: hotspots.flatMap((h) =>
        isObj(h) && isNum(h.yaw) && isNum(h.pitch) && typeof h.targetRoomId === "string"
          ? [{ yaw: h.yaw, pitch: Math.max(-90, Math.min(90, h.pitch)), targetRoomId: h.targetRoomId.slice(0, 40), label: (str(h.label) ?? "").slice(0, 60) }]
          : [],
      ),
    });
  }
  if (rooms.length === 0) return null;
  const ids = new Set(rooms.map((r) => r.id));
  for (const r of rooms) r.hotspots = r.hotspots.filter((h) => ids.has(h.targetRoomId) && h.targetRoomId !== r.id);
  const start = typeof t.startRoomId === "string" && ids.has(t.startRoomId) ? t.startRoomId : rooms[0]!.id;
  return { startRoomId: start, rooms };
}

// create: бүх шаардлагатай талбарыг шалгана; patch=true: зөвхөн ирсэн талбарыг
function parseBody(body: Record<string, unknown>, patch: boolean): Parsed {
  const v: Patch = {};
  const req = (k: string) => !patch || has(body, k); // create-д заавал, patch-д зөвхөн байвал

  if (req("title")) {
    const title = str(body.title);
    if (!title || title.length > 200) return { error: "Гарчиг 1–200 тэмдэгт" };
    v.title = title;
  }
  if (has(body, "description")) {
    const d = typeof body.description === "string" ? body.description : "";
    if (d.length > 5000) return { error: "Тайлбар 5000 тэмдэгтээс хэтрэхгүй" };
    v.description = d;
  }
  if (req("dealType")) {
    if (!DEAL_TYPES.includes(body.dealType as never))
      return { error: `dealType: ${DEAL_TYPES.join(" | ")}` };
    v.dealType = body.dealType as Post["dealType"];
  }
  if (req("category")) {
    if (!CATEGORIES.includes(body.category as never))
      return { error: `category: ${CATEGORIES.join(" | ")}` };
    v.category = body.category as Post["category"];
  }
  if (req("district")) {
    const district = str(body.district);
    if (!district || district.length > 100) return { error: "Дүүрэг/байршил 1–100 тэмдэгт" };
    v.district = district;
  }
  for (const [k, max, label] of [
    ["khoroo", 40, "Хороо"],
    ["address", 200, "Хаяг"],
    ["sellerName", 60, "Нэр"],
  ] as const) {
    if (!has(body, k)) continue;
    const s = str(body[k]) ?? "";
    if (s.length > max) return { error: `${label} ${max} тэмдэгтээс хэтрэхгүй` };
    v[k] = s;
  }
  if (req("price")) {
    if (!isInt(body.price) || body.price < 0 || body.price > 1e12)
      return { error: "Үнэ 0–1,000,000,000,000 бүхэл тоо" };
    v.price = body.price;
  }
  if (req("area")) {
    if (!isNum(body.area) || body.area <= 0 || body.area > 1e7)
      return { error: "Талбай 0-ээс их, 10,000,000 м²-аас бага" };
    v.area = body.area;
  }
  // nullable тоонууд: утга өгвөл шалгана, null бол цэвэрлэнэ
  for (const [k, min, max, int] of [
    ["rooms", 0, 100, true],
    ["floor", -10, 300, true],
    ["totalFloors", 0, 300, true],
    ["yearInUse", 1900, 2100, true],
    ["balconies", 0, 20, true],
    ["windowCount", 0, 200, true],
    ["lat", 41, 52.5, false], // Монголын хил орчим
    ["lng", 87, 120, false],
  ] as const) {
    if (!has(body, k)) continue;
    const val = body[k];
    if (val === null) {
      v[k] = null;
    } else if ((int ? isInt(val) : isNum(val)) && (val as number) >= min && (val as number) <= max) {
      v[k] = val as number;
    } else {
      return { error: `${k}: ${min}–${max} ${int ? "бүхэл " : ""}тоо эсвэл null` };
    }
  }
  // nullable богино текстүүд (сонголтууд)
  for (const k of ["floorMaterial", "windowType", "doorType"] as const) {
    if (!has(body, k)) continue;
    const s = str(body[k]);
    if (body[k] !== null && (s === undefined || s.length > 40)) return { error: `${k}: 40 хүртэл тэмдэгт эсвэл null` };
    v[k] = s || null;
  }
  for (const k of ["garage", "leasing"] as const) {
    if (!has(body, k)) continue;
    if (typeof body[k] !== "boolean") return { error: `${k}: true | false` };
    v[k] = body[k] as boolean;
  }
  if (has(body, "paymentTerms")) {
    const arr = body.paymentTerms;
    if (!Array.isArray(arr) || arr.length > 10 || arr.some((x) => typeof x !== "string" || !x.trim() || x.length > 40))
      return { error: "paymentTerms: 10 хүртэл текстийн жагсаалт" };
    v.paymentTerms = [...new Set((arr as string[]).map((x) => x.trim()))];
  }
  if (has(body, "sellerType")) {
    if (!SELLER_TYPES.includes(body.sellerType as never)) return { error: `sellerType: ${SELLER_TYPES.join(" | ")}` };
    v.sellerType = body.sellerType as Post["sellerType"];
  }
  if (has(body, "placement")) {
    if (!PLACEMENTS.includes(body.placement as never)) return { error: `placement: ${PLACEMENTS.join(" | ")}` };
    v.placement = body.placement as Post["placement"];
    v.placementUntil = v.placement === "free" ? null : new Date(Date.now() + PROMO_DAYS * DAY_MS);
  }
  if (has(body, "tour")) {
    const t = parseTour(body.tour);
    if (t && "error" in t) return t;
    v.tour = t;
  }
  if (has(body, "contactPhone")) {
    const p = str(body.contactPhone) ?? "";
    if (p.length > 30) return { error: "Утас 30 тэмдэгтээс хэтрэхгүй" };
    v.contactPhone = p;
  }
  if (has(body, "status")) {
    if (!POST_STATUSES.includes(body.status as never))
      return { error: `status: ${POST_STATUSES.join(" | ")}` };
    v.status = body.status as Post["status"];
  }

  // зураг: R2 түлхүүрүүд (зөвхөн энэ сервер үүсгэсэн `listings/…`). Түлхүүр эсвэл { key, width, height }.
  let images: ImageIn[] | undefined;
  if (has(body, "images")) {
    const arr = body.images;
    if (!Array.isArray(arr) || arr.length > MAX_IMAGES)
      return { error: `Зураг хамгийн ихдээ ${MAX_IMAGES}` };
    images = [];
    for (const item of arr) {
      const key = typeof item === "string" ? item : isObj(item) ? item.key : undefined;
      if (typeof key !== "string" || !key.startsWith(IMAGE_KEY_PREFIX) || key.length > 200)
        return { error: "Зургийн түлхүүр буруу (эхлээд /api/uploads-руу байршуулна)" };
      const dim = (n: unknown) => (isInt(n) && n > 0 && n <= 20000 ? n : null);
      images.push({ key, width: isObj(item) ? dim(item.width) : null, height: isObj(item) ? dim(item.height) : null });
    }
  }

  return { values: v, images };
}

// Төлөв солих эрх: агент зөвхөн ноорог/хянуулах/зарагдсан/архив; батлах, татгалзах — зөвхөн админ
const AGENT_STATUSES: PostStatus[] = ["draft", "pending", "sold", "archived"];
const statusAllowed = (agent: PublicAgent, status: PostStatus | undefined) =>
  status === undefined || agent.role === "admin" || AGENT_STATUSES.includes(status);

// зураг синк: бүгдийг устгаад дарааллаар нь дахин оруулна
const syncImages = (db: Db, postId: number, imgs: ImageIn[]) => [
  db.delete(postImages).where(eq(postImages.postId, postId)),
  ...(imgs.length
    ? [db.insert(postImages).values(imgs.map((im, i) => ({ postId, key: im.key, width: im.width, height: im.height, sortOrder: i })))]
    : []),
];

// vip/top хугацаа дуусаагүй бол дээр нь (top=2, vip=1)
const promoRank = sql<number>`(case when ${posts.placementUntil} > unixepoch() then (case ${posts.placement} when 'top' then 2 when 'vip' then 1 else 0 end) else 0 end)`;
const pricePerM2 = sql`(${posts.price} / ${posts.area})`;

// Жагсаалт (GET /) болон газрын зургийн тэмдэг (GET /pins)-ийн нийтлэг шүүлтүүр.
// `mine=1` нэвтрээгүй бол null (→ 401). deal-ийг тусад нь буцаана (`facets=deal`-д).
function buildFilter(q: Record<string, string>, agent: PublicAgent | null): { conds: (SQL | undefined)[]; dealCond: SQL | undefined } | null {
  const numQ = (k: string) => (q[k] !== undefined && q[k] !== "" && Number.isFinite(Number(q[k])) ? Number(q[k]) : null);

  const conds: (SQL | undefined)[] = [];
  if (q.mine === "1") {
    // өөрийн зар — бүх төлөв
    if (!agent) return null;
    conds.push(eq(posts.agentId, agent.id));
  } else if (agent?.role === "admin") {
    // Админ `?status=`-аар шүүнэ, өгөхгүй бол бүгдийг хардаг.
    if (q.status && POST_STATUSES.includes(q.status as never)) conds.push(eq(posts.status, q.status as PostStatus));
  } else {
    conds.push(eq(posts.status, "active"));
  }
  // deal-ийг тусад нь: `facets=deal` үед бусад шүүлтүүрээр deal бүрийн тоог гаргана
  const dealCond =
    q.dealType && DEAL_TYPES.includes(q.dealType as never) ? eq(posts.dealType, q.dealType as Post["dealType"]) : undefined;
  if (q.category && CATEGORIES.includes(q.category as never)) conds.push(eq(posts.category, q.category as Post["category"]));
  if (q.district) conds.push(eq(posts.district, q.district));
  if (q.placement && PLACEMENTS.includes(q.placement as never))
    conds.push(eq(posts.placement, q.placement as Post["placement"]), sql`${promoRank} > 0`);

  // мужууд: min*/max*
  const range = (lo: string, hi: string, col: SQLWrapper) => {
    const a = numQ(lo), b = numQ(hi);
    if (a !== null) conds.push(sql`${col} >= ${a}`);
    if (b !== null) conds.push(sql`${col} <= ${b}`);
  };
  range("minPrice", "maxPrice", posts.price);
  range("minPpm", "maxPpm", pricePerM2);
  range("minArea", "maxArea", posts.area);
  range("minFloor", "maxFloor", posts.floor);
  range("minTotalFloors", "maxTotalFloors", posts.totalFloors);
  range("minYear", "maxYear", posts.yearInUse);

  // rooms=1,2,5 — 5 нь "5 ба түүнээс дээш"
  if (q.rooms) {
    const set = q.rooms.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (set.length) conds.push(or(...set.map((r) => (r >= 5 ? gte(posts.rooms, 5) : eq(posts.rooms, r)))));
  }
  if (q.notFirst === "1") conds.push(gt(posts.floor, 1));
  if (q.notLast === "1") conds.push(lt(posts.floor, posts.totalFloors));
  if (q.leasing === "1") conds.push(eq(posts.leasing, true));
  if (q.garage === "1") conds.push(eq(posts.garage, true));
  if (q.hasTour === "1") conds.push(isNotNull(posts.tour));
  if (q.sellerType === "owner") conds.push(eq(posts.sellerType, "owner"));
  if (q.sellerType === "agent") conds.push(ne(posts.sellerType, "owner"));
  const days = numQ("postedDays");
  if (days && days > 0) conds.push(gte(posts.createdAt, new Date(Date.now() - days * DAY_MS)));
  // үг бүр гарчиг, тайлбар, дүүрэг, хаягийн аль нэгэнд байх ёстой
  for (const w of (q.q ?? "").replaceAll("%", "").replaceAll("_", "").split(/\s+/).filter(Boolean).slice(0, 8)) {
    const pat = `%${w}%`;
    conds.push(or(like(posts.title, pat), like(posts.description, pat), like(posts.district, pat), like(posts.address, pat)));
  }
  return { conds, dealCond };
}

// ---- GET /api/posts (нийтийн жагсаалт) ----
postRoutes.get("/", async (c) => {
  const q = c.req.query();
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const limit = Math.min(LIMIT_MAX, Math.max(1, Math.floor(Number(q.limit)) || LIMIT_DEFAULT));
  const offset = (page - 1) * limit;
  const agent = c.var.agent;
  const filter = buildFilter(q, agent);
  if (!filter) return c.json({ error: "Нэвтрээгүй байна" }, 401);
  const { conds, dealCond } = filter;
  const where = and(...conds, dealCond);

  // sort: newest (default) | price_asc | price_desc | area_desc | ppm_asc. vip/top эхэнд (`plain=1` бол үгүй)
  const sorts: Record<string, SQL[]> = {
    price_asc: [asc(posts.price)],
    price_desc: [desc(posts.price)],
    area_desc: [desc(posts.area)],
    ppm_asc: [asc(pricePerM2)],
  };
  const order = [
    ...(q.plain === "1" || q.mine === "1" ? [] : [desc(promoRank)]),
    ...(sorts[q.sort ?? ""] ?? []),
    desc(posts.createdAt),
    desc(posts.id),
  ];

  const [rows, [{ total }], dealCounts] = await Promise.all([
    c.var.db
      .select({ ...postColumns, agent: agentSel })
      .from(posts)
      .leftJoin(agents, eq(posts.agentId, agents.id))
      .where(where)
      .orderBy(...order)
      .limit(limit)
      .offset(offset),
    c.var.db.select({ total: count() }).from(posts).where(where),
    q.facets === "deal" ? dealCountsFor(c.var.db, conds) : null,
  ]);

  return c.json({
    posts: await withRelations(c.var.db, rows as Row[]),
    total,
    page,
    limit,
    pages: Math.ceil(total / limit) || 1,
    // `facets=deal`: { sale, rent } — хайлтын табуудын тоо (нэг хүсэлтээр)
    ...(dealCounts && { dealCounts }),
  });
});

// ---- GET /api/posts/stats (нүүр хуудасны тоо) ----
postRoutes.get("/stats", async (c) => {
  const rows = await c.var.db
    .select({ dealType: posts.dealType, category: posts.category, n: count() })
    .from(posts)
    .where(eq(posts.status, "active"))
    .groupBy(posts.dealType, posts.category);
  const counts: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    counts[`${r.dealType}:${r.category}`] = r.n;
    total += r.n;
  }
  return c.json({ counts, total }, 200, { "cache-control": "no-store" }); // шинэ зар шууд тоонд орно
});

// ---- GET /api/posts/:id (дэлгэрэнгүй) ----
// `facets=deal`: deal-ийн шүүлтүүргүйгээр, бусад шүүлтүүрээр deal бүрийн тоо → { sale, rent }
const dealCountsFor = async (db: Db, conds: (SQL | undefined)[]) => {
  const rows = await db.select({ dealType: posts.dealType, n: count() }).from(posts).where(and(...conds)).groupBy(posts.dealType);
  return Object.fromEntries(DEAL_TYPES.map((d) => [d, rows.find((r) => r.dealType === d)?.n ?? 0])) as Record<(typeof DEAL_TYPES)[number], number>;
};

// ---- GET /api/posts/pins (газрын зургийн тэмдэг) ----
// Жагсаалттай ижил шүүлтүүр, гэхдээ зар бүрийн зөвхөн тэмдэг, popup-д хэрэгтэй талбарууд (зураг 1, агентгүй)
// тул нэг хүсэлтээр PINS_MAX хүртэл зар. → { pins, total, truncated, dealCounts? }; truncated = нийт нь PINS_MAX-аас их.
const PINS_MAX = 1000;
postRoutes.get("/pins", async (c) => {
  const q = c.req.query();
  const filter = buildFilter(q, c.var.agent);
  if (!filter) return c.json({ error: "Нэвтрээгүй байна" }, 401);
  const where = and(...filter.conds, filter.dealCond);
  const cover = sql<string | null>`(select ${postImages.key} from ${postImages} where ${postImages.postId} = ${posts.id} order by ${postImages.sortOrder}, ${postImages.id} limit 1)`;
  const [rows, [{ total }], dealCounts] = await Promise.all([
    c.var.db
      .select({
        id: posts.id, title: posts.title, price: posts.price, dealType: posts.dealType, category: posts.category,
        district: posts.district, lat: posts.lat, lng: posts.lng, rooms: posts.rooms, area: posts.area,
        promo: promoRank, coverKey: cover,
      })
      .from(posts)
      .where(where)
      .orderBy(desc(promoRank), desc(posts.createdAt), desc(posts.id))
      .limit(PINS_MAX),
    c.var.db.select({ total: count() }).from(posts).where(where),
    q.facets === "deal" ? dealCountsFor(c.var.db, filter.conds) : null,
  ]);
  const pins = rows.map(({ coverKey, ...p }) => ({ ...p, cover: coverKey ? `/api/uploads/${coverKey}` : null }));
  return c.json({ pins, total, truncated: total > rows.length, ...(dealCounts && { dealCounts }) });
});

postRoutes.get("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await c.var.db
    .select({ ...postColumns, agent: agentSel })
    .from(posts)
    .leftJoin(agents, eq(posts.agentId, agents.id))
    .where(eq(posts.id, id))
    .limit(1);
  if (!row) return c.json({ error: "Зар олдсонгүй" }, 404);

  const agent = c.var.agent;
  const owner = agent && (agent.role === "admin" || row.agentId === agent.id);
  if (row.status !== "active" && !owner) return c.json({ error: "Зар олдсонгүй" }, 404);

  // active зарын үзсэн тоог нэмэгдүүлнэ (`?view=0` бол үгүй — хадгалсан зар, урьдчилан харах г.м.)
  if (row.status === "active" && c.req.query("view") !== "0") {
    c.executionCtx.waitUntil(
      c.var.db.update(posts).set({ views: sql`${posts.views} + 1` }).where(eq(posts.id, id)).then(() => {}),
    );
    row.views += 1;
  }

  const [full] = await withRelations(c.var.db, [row as Row]);
  return c.json({ post: full });
});

// ---- POST /api/posts (үүсгэх) ----
postRoutes.post("/", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!isObj(body)) return c.json({ error: "JSON body оруулна уу" }, 400);

  const parsed = parseBody(body, false);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

  // Төлөв: ноорог хүсвэл ноорог; бусад нь агентынх админ хянана, админых шууд нийтлэгдэнэ
  const agent = c.var.agent!;
  const status: PostStatus = parsed.values.status === "draft" ? "draft" : agent.role === "admin" ? "active" : "pending";

  const [created] = await c.var.db
    .insert(posts)
    .values({ ...parsed.values, status, agentId: agent.id } as typeof posts.$inferInsert)
    .returning({ id: posts.id });

  if (parsed.images?.length) await c.var.db.batch(syncImages(c.var.db, created!.id, parsed.images) as never);

  return c.json({ post: await getOne(c.var.db, created!.id) }, 201);
});

// ---- PATCH /api/posts/:id (засах) ----
// Агуулгыг (гарчиг, үнэ, зураг, 360°, байршил…) зөвхөн админ засна.
// Эзэмшигч агент зөвхөн төлөвөө солино (зарагдсан, архив, дахин хянуулах): body нь зөвхөн { status }.
postRoutes.patch("/:id{[0-9]+}", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  const [existing] = await c.var.db
    .select({ agentId: posts.agentId, placement: posts.placement })
    .from(posts)
    .where(eq(posts.id, id))
    .limit(1);
  if (!existing) return c.json({ error: "Зар олдсонгүй" }, 404);
  const agent = c.var.agent!;
  const isAdmin = agent.role === "admin";
  if (!isAdmin && existing.agentId !== agent.id)
    return c.json({ error: "Энэ зарыг засах эрхгүй" }, 403);

  const body = await c.req.json().catch(() => null);
  if (!isObj(body)) return c.json({ error: "JSON body оруулна уу" }, 400);
  if (!isAdmin && Object.keys(body).some((k) => k !== "status"))
    return c.json({ error: "Зарын мэдээллийг зөвхөн админ засах боломжтой" }, 403);
  const parsed = parseBody(body, true);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  if (!statusAllowed(agent, parsed.values.status))
    return c.json({ error: "Зарыг зөвхөн админ батлах/татгалзах боломжтой" }, 403);
  // same placement again (e.g. an admin edit re-sending the form) must not restart the paid VIP/Top period
  if (parsed.values.placement === existing.placement) {
    delete parsed.values.placement;
    delete parsed.values.placementUntil;
  }

  if (Object.keys(parsed.values).length)
    await c.var.db.update(posts).set(parsed.values).where(eq(posts.id, id));
  if (parsed.images) await c.var.db.batch(syncImages(c.var.db, id, parsed.images) as never);

  return c.json({ post: await getOne(c.var.db, id) });
});

// ---- DELETE /api/posts/:id (устгах) ----
postRoutes.delete("/:id{[0-9]+}", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  const [existing] = await c.var.db
    .select({ agentId: posts.agentId })
    .from(posts)
    .where(eq(posts.id, id))
    .limit(1);
  if (!existing) return c.json({ error: "Зар олдсонгүй" }, 404);
  const agent = c.var.agent!;
  if (agent.role !== "admin" && existing.agentId !== agent.id)
    return c.json({ error: "Энэ зарыг устгах эрхгүй" }, 403);

  await c.var.db.delete(posts).where(eq(posts.id, id)); // post_images нь cascade
  return c.json({ ok: true });
});

// нэг зарыг агент, зурагтай нь буцаах туслах
async function getOne(db: Db, id: number) {
  const [row] = await db
    .select({ ...postColumns, agent: agentSel })
    .from(posts)
    .leftJoin(agents, eq(posts.agentId, agents.id))
    .where(eq(posts.id, id))
    .limit(1);
  const [full] = await withRelations(db, [row as Row]);
  return full;
}
