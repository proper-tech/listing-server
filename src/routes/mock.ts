// Mock схемийг шалгах API — зөвхөн testing / локал (production-д 404).
// Өгөгдөл: seeds/mock.sql (`npm run db:seed:local` | `npm run db:seed:testing`)
//
//   GET /api/mock/agents          агентууд + идэвхтэй зарын тоо
//   GET /api/mock/listings        шүүлтүүр, эрэмбэ, хуудаслалт
//       ?dealType=sale|rent &category= &district= &status=active|sold|expired|all
//       &minPrice= &maxPrice= &rooms=(хамгийн бага) &q=(гарчигт хайх)
//       &sort=newest|price_asc|price_desc|views &page=1 &limit=20 (≤50)
//   GET /api/mock/listings/:id    дэлгэрэнгүй + агент + зургууд (relational query)
//   GET /api/mock/stats           төлөв, ангилал, дүүргээр нэгтгэсэн тоо
import { Hono } from "hono";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import { mockAgents, mockListings } from "../db/schema.ts";
import { testingOnly } from "../middleware.ts";
import type { AppEnv } from "../types.ts";

export const mockRoutes = new Hono<AppEnv>();
mockRoutes.use("*", testingOnly);

const DEAL_TYPES = mockListings.dealType.enumValues;
const CATEGORIES = mockListings.category.enumValues;
const STATUSES = mockListings.status.enumValues;
const SORTS = {
  newest: desc(mockListings.createdAt),
  price_asc: asc(mockListings.price),
  price_desc: desc(mockListings.price),
  views: desc(mockListings.views),
} as const;

const oneOf = <T extends string>(list: readonly T[], v: string | undefined) =>
  list.includes(v as T) ? (v as T) : undefined;
const int = (v: string | undefined, min: number, max: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isInteger(n) && n >= min && n <= max
    ? n
    : undefined;
};

mockRoutes.get("/agents", async (c) => {
  const items = await c.var.db
    .select({
      ...getTableColumns(mockAgents),
      activeListings: sql<number>`count(${mockListings.id})`,
    })
    .from(mockAgents)
    .leftJoin(
      mockListings,
      and(eq(mockListings.agentId, mockAgents.id), eq(mockListings.status, "active")),
    )
    .groupBy(mockAgents.id)
    .orderBy(asc(mockAgents.id));
  return c.json({ items });
});

mockRoutes.get("/listings", async (c) => {
  const q = c.req.query();
  const page = int(q.page, 1, 1e6) ?? 1;
  const limit = int(q.limit, 1, 50) ?? 20;
  const status = q.status === "all" ? undefined : (oneOf(STATUSES, q.status) ?? "active");
  const dealType = oneOf(DEAL_TYPES, q.dealType);
  const category = oneOf(CATEGORIES, q.category);
  const minPrice = int(q.minPrice, 0, Number.MAX_SAFE_INTEGER);
  const maxPrice = int(q.maxPrice, 0, Number.MAX_SAFE_INTEGER);
  const rooms = int(q.rooms, 0, 100);
  const search = q.q?.trim().slice(0, 100);

  const filters: (SQL | undefined)[] = [
    status && eq(mockListings.status, status),
    dealType && eq(mockListings.dealType, dealType),
    category && eq(mockListings.category, category),
    q.district ? eq(mockListings.district, q.district) : undefined,
    minPrice !== undefined ? gte(mockListings.price, minPrice) : undefined,
    maxPrice !== undefined ? lte(mockListings.price, maxPrice) : undefined,
    rooms !== undefined ? gte(mockListings.rooms, rooms) : undefined,
    // LIKE-ийн тусгай тэмдэгтүүдийг escape хийнэ
    search ? sql`${mockListings.title} like ${`%${search.replace(/[\\%_]/g, "\\$&")}%`} escape '\\'` : undefined,
  ];
  const where = and(...filters);
  const sort = SORTS[q.sort as keyof typeof SORTS] ?? SORTS.newest;

  const [items, [{ total }]] = await Promise.all([
    c.var.db
      .select({
        ...getTableColumns(mockListings),
        agentName: mockAgents.name,
        agentPhone: mockAgents.phone,
      })
      .from(mockListings)
      .leftJoin(mockAgents, eq(mockAgents.id, mockListings.agentId))
      .where(where)
      .orderBy(sort, desc(mockListings.id))
      .limit(limit)
      .offset((page - 1) * limit),
    c.var.db.select({ total: count() }).from(mockListings).where(where),
  ]);

  return c.json({ items, total, page, limit, pages: Math.ceil(total / limit) });
});

mockRoutes.get("/listings/:id", async (c) => {
  const id = int(c.req.param("id"), 1, Number.MAX_SAFE_INTEGER);
  if (id === undefined) return c.json({ error: "Буруу id" }, 400);

  const item = await c.var.db.query.mockListings.findFirst({
    where: eq(mockListings.id, id),
    with: {
      agent: { columns: { id: true, name: true, phone: true, email: true } },
      images: { orderBy: (img, { asc }) => [asc(img.sortOrder)] },
    },
  });
  if (!item) return c.json({ error: "Not found" }, 404);
  return c.json({ item });
});

mockRoutes.get("/stats", async (c) => {
  const db = c.var.db;
  const avgPricePerM2 = sql<number>`round(avg(${mockListings.price} / ${mockListings.area}))`;
  const [byStatus, byCategory, byDistrict] = await Promise.all([
    db
      .select({ status: mockListings.status, count: count() })
      .from(mockListings)
      .groupBy(mockListings.status),
    db
      .select({ category: mockListings.category, count: count() })
      .from(mockListings)
      .where(eq(mockListings.status, "active"))
      .groupBy(mockListings.category)
      .orderBy(desc(count())),
    // Худалдах орон сууцны дундаж м² үнэ, дүүргээр
    db
      .select({
        district: mockListings.district,
        count: count(),
        avgPricePerM2,
      })
      .from(mockListings)
      .where(and(eq(mockListings.dealType, "sale"), eq(mockListings.category, "apartment")))
      .groupBy(mockListings.district)
      .orderBy(desc(avgPricePerM2)),
  ]);
  return c.json({ byStatus, byCategory, apartmentSaleByDistrict: byDistrict });
});
