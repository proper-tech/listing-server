// Зарын талаар холбогдох хүсэлт (inquiry).
//   POST   /api/posts/:id/inquiries   (нийтийн)  { name, phone, email?, message } → 201 { inquiry }
//                                     зөвхөн `active` зарт; IP-ээр 10 минутад 5, цагт 20 хүсэлт
//   GET    /api/inquiries             (нэвтэрсэн) өөрийн зарууд руу ирсэн хүсэлтүүд (админ — бүгд)
//                                     ?unread=1  ?postId=  ?page=  ?limit= → { inquiries, total, unread, page, limit, pages }
//   PATCH  /api/inquiries/:id         (зарын эзэн эсвэл админ) { read: boolean }
//   DELETE /api/inquiries/:id         (зарын эзэн эсвэл админ)
import { Hono } from "hono";
import { and, count, desc, eq, gt, isNull, type SQL } from "drizzle-orm";
import { inquiries, posts } from "../db/schema.ts";
import { requireAuth } from "../auth.ts";
import type { Db } from "../db/index.ts";
import type { PublicAgent } from "../db/schema.ts";
import type { AppEnv } from "../types.ts";

export const inquiryRoutes = new Hono<AppEnv>();

const LIMIT_DEFAULT = 30;
const LIMIT_MAX = 100;
const RATE = [
  { windowMs: 10 * 60 * 1000, max: 5 }, // 10 минутад 5
  { windowMs: 60 * 60 * 1000, max: 20 }, // цагт 20
] as const;

// ---- баталгаажуулалт (вэбийн InquiryForm-той ижил дүрэм) ----
const NAME_RE = /^[\p{L}][\p{L}\s.'-]*$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const clean = (v: unknown) => (typeof v === "string" ? v.trim().replace(/[ \t]{2,}/g, " ") : "");

/** 8 оронтой дугаар: +976, зай, зураас зэргийг хасна. Буруу бол "". */
export function normPhone(v: unknown): string {
  let d = typeof v === "string" ? v.replace(/\D/g, "") : "";
  if (d.length === 11 && d.startsWith("976")) d = d.slice(3);
  return /^[5-9]\d{7}$/.test(d) ? d : "";
}

type InquiryIn = { name: string; phone: string; email: string | null; message: string };
function parseInquiry(b: Record<string, unknown>): InquiryIn | { error: string } {
  const name = clean(b.name);
  if (name.length < 2 || name.length > 60) return { error: "Нэр 2–60 тэмдэгт байна" };
  if (!NAME_RE.test(name)) return { error: "Нэрэнд зөвхөн үсэг бичнэ үү" };
  const phone = normPhone(b.phone);
  if (!phone) return { error: "Утасны дугаар 8 оронтой, 5–9-өөр эхэлнэ" };
  const email = clean(b.email).toLowerCase();
  if (email && (email.length > 254 || !EMAIL_RE.test(email))) return { error: "Имэйл хаяг буруу байна" };
  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (message.length < 5) return { error: "Мессежээ бичнэ үү (5-аас дээш тэмдэгт)" };
  if (message.length > 1000) return { error: "Мессеж 1000 тэмдэгтээс хэтрэхгүй" };
  return { name, phone, email: email || null, message };
}

// хариунд ip-г хэзээ ч бүү оруул
const out = {
  id: inquiries.id,
  postId: inquiries.postId,
  postTitle: posts.title,
  name: inquiries.name,
  phone: inquiries.phone,
  email: inquiries.email,
  message: inquiries.message,
  readAt: inquiries.readAt,
  createdAt: inquiries.createdAt,
};

// админ бүгдийг, агент зөвхөн өөрийн зарынхыг
const ownerCond = (agent: PublicAgent): SQL | undefined =>
  agent.role === "admin" ? undefined : eq(posts.agentId, agent.id);

const intQ = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : d;
};

// ---- POST /api/posts/:id/inquiries (нийтийн) ----
inquiryRoutes.post("/posts/:id{[0-9]+}/inquiries", async (c) => {
  const postId = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => null);
  if (!isObj(body)) return c.json({ error: "JSON body оруулна уу" }, 400);
  const parsed = parseInquiry(body);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

  const db = c.var.db;
  const ip = c.req.header("cf-connecting-ip") ?? null;
  const now = Date.now();
  const [[post], ...recent] = await Promise.all([
    db.select({ status: posts.status }).from(posts).where(eq(posts.id, postId)).limit(1),
    ...(ip
      ? RATE.map((r) =>
          db
            .select({ n: count() })
            .from(inquiries)
            .where(and(eq(inquiries.ip, ip), gt(inquiries.createdAt, new Date(now - r.windowMs))))
            .then(([row]) => row?.n ?? 0),
        )
      : []),
  ]);
  if (!post || post.status !== "active") return c.json({ error: "Зар олдсонгүй" }, 404);
  if (RATE.some((r, i) => ((recent[i] as number | undefined) ?? 0) >= r.max))
    return c.json({ error: "Хэт олон хүсэлт илгээлээ. Түр хүлээгээд дахин оролдоно уу" }, 429);

  const [created] = await db
    .insert(inquiries)
    .values({ ...parsed, postId, ip })
    .returning({ id: inquiries.id, createdAt: inquiries.createdAt });
  return c.json({ inquiry: { id: created!.id, postId, createdAt: created!.createdAt } }, 201);
});

// ---- GET /api/inquiries (нэвтэрсэн) ----
inquiryRoutes.get("/inquiries", requireAuth, async (c) => {
  const agent = c.var.agent!;
  const q = c.req.query();
  const limit = intQ(q.limit, LIMIT_DEFAULT, 1, LIMIT_MAX);
  const page = intQ(q.page, 1, 1, 10_000);
  const own = ownerCond(agent);
  const postId = q.postId ? Number(q.postId) : NaN;
  const base = and(own, Number.isInteger(postId) ? eq(inquiries.postId, postId) : undefined);
  const where = and(base, q.unread === "1" ? isNull(inquiries.readAt) : undefined);

  const db = c.var.db;
  const [rows, [{ total }], [{ unread }]] = await Promise.all([
    db
      .select(out)
      .from(inquiries)
      .innerJoin(posts, eq(inquiries.postId, posts.id))
      .where(where)
      .orderBy(desc(inquiries.createdAt), desc(inquiries.id))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ total: count() }).from(inquiries).innerJoin(posts, eq(inquiries.postId, posts.id)).where(where),
    db
      .select({ unread: count() })
      .from(inquiries)
      .innerJoin(posts, eq(inquiries.postId, posts.id))
      .where(and(base, isNull(inquiries.readAt))),
  ]);

  return c.json(
    { inquiries: rows, total, unread, page, limit, pages: Math.ceil(total / limit) || 1 },
    200,
    { "cache-control": "no-store" },
  );
});

// эзэн/админ шалгаад хүсэлтийг буцаана (байхгүй эсвэл эрхгүй бол null — 404)
async function findOwned(db: Db, agent: PublicAgent, id: number) {
  const [row] = await db
    .select({ id: inquiries.id })
    .from(inquiries)
    .innerJoin(posts, eq(inquiries.postId, posts.id))
    .where(and(eq(inquiries.id, id), ownerCond(agent)))
    .limit(1);
  return row ?? null;
}

// ---- PATCH /api/inquiries/:id { read } ----
inquiryRoutes.patch("/inquiries/:id{[0-9]+}", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => null);
  if (!isObj(body) || typeof body.read !== "boolean") return c.json({ error: "{ read: boolean } оруулна уу" }, 400);
  const db = c.var.db;
  if (!(await findOwned(db, c.var.agent!, id))) return c.json({ error: "Хүсэлт олдсонгүй" }, 404);

  await db.update(inquiries).set({ readAt: body.read ? new Date() : null }).where(eq(inquiries.id, id));
  const [row] = await db
    .select(out)
    .from(inquiries)
    .innerJoin(posts, eq(inquiries.postId, posts.id))
    .where(eq(inquiries.id, id))
    .limit(1);
  return c.json({ inquiry: row });
});

// ---- DELETE /api/inquiries/:id ----
inquiryRoutes.delete("/inquiries/:id{[0-9]+}", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.var.db;
  if (!(await findOwned(db, c.var.agent!, id))) return c.json({ error: "Хүсэлт олдсонгүй" }, 404);
  await db.delete(inquiries).where(eq(inquiries.id, id));
  return c.json({ ok: true });
});
