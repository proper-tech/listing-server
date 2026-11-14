// Төлбөр — агентын зар байршуулах (BASE_FEE) + VIP/Онцгой. Админы зар төлбөргүй.
//   POST /api/posts/:id/payment          (зарын эзэн агент) нэхэмжлэх үүсгэх / байгааг нь буцаах
//                                        → { paid: true } эсвэл { payment: { id, amount, items, status, qrImage, qrText, shortUrl, links, provider } }
//   GET  /api/payments/:id               (эзэн эсвэл админ) төлөв; pending бол QPay-ээс шалгаад шинэчилнэ
//   GET|POST /api/payments/qpay/callback/:secret/:id   QPay дуудна; QPay-ээс дахин шалгаж баталгаажуулна → "SUCCESS"
//   POST /api/payments/:id/mock-pay      (эзэн) зөвхөн QPAY_MODE=mock үед: туршилтын төлбөр
//   GET  /api/payments                   (админ) сүүлийн төлбөрүүд + нийт орлого
// Төлөгдмөгц: payments.status=paid, posts.paid_at тавигдаж, unpaid зар → pending (админ хянана).
import { Hono, type Context } from "hono";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { agents, payments, posts, type Payment } from "../db/schema.ts";
import { requireAdmin, requireAuth } from "../auth.ts";
import { priceFor } from "../pricing.ts";
import { cancelInvoice, checkPaid, createInvoice, qpayMode, QpayConfigError } from "../qpay.ts";
import type { Db } from "../db/index.ts";
import type { AppEnv } from "../types.ts";

export const paymentRoutes = new Hono<AppEnv>();

const INVOICE_REUSE_MS = 24 * 60 * 60 * 1000; // нэг өдрийн дотор ижил дүнтэй нэхэмжлэхийг дахин ашиглана

const view = (p: Payment) => ({
  id: p.id, postId: p.postId, amount: p.amount, items: p.items, status: p.status, provider: p.provider,
  qrText: p.qrText, qrImage: p.qrImage, shortUrl: p.shortUrl, links: p.links ?? [], paidAt: p.paidAt, createdAt: p.createdAt,
});

/** Нэг удаа л хэрэгжинэ (status=pending нөхцөлтэй update) — callback ба шалгалт зэрэг ирсэн ч давхардахгүй. */
async function markPaid(db: Db, p: Payment, providerPaymentId: string): Promise<Payment> {
  const now = new Date();
  const [updated] = await db
    .update(payments)
    .set({ status: "paid", paidAt: now, providerPaymentId })
    .where(and(eq(payments.id, p.id), eq(payments.status, "pending")))
    .returning();
  if (updated && p.postId != null) {
    await db
      .update(posts)
      .set({ paidAt: now, status: sql`case when ${posts.status} = 'unpaid' then 'pending' else ${posts.status} end` })
      .where(eq(posts.id, p.postId));
  }
  if (updated) return updated;
  const [current] = await db.select().from(payments).where(eq(payments.id, p.id)).limit(1);
  return current!;
}

/** pending бол QPay-ээс шалгаж, төлөгдсөн бол тэмдэглэнэ. QPay түр алдаа гарвал хэвээр нь буцаана. */
async function refresh(c: Context<AppEnv>, p: Payment): Promise<Payment> {
  if (p.status !== "pending" || !p.invoiceId || p.provider === "mock") return p;
  const paymentId = await checkPaid(c.env, p.invoiceId, p.amount).catch((e) => (console.error("QPay check:", e), null));
  return paymentId ? markPaid(c.var.db, p, paymentId) : p;
}

const callbackSecret = (c: Context<AppEnv>) => (c.env as unknown as { QPAY_CALLBACK_SECRET?: string }).QPAY_CALLBACK_SECRET ?? "";
const publicApiUrl = (c: Context<AppEnv>) =>
  ((c.env as unknown as { PUBLIC_API_URL?: string }).PUBLIC_API_URL || new URL(c.req.url).origin).replace(/\/+$/, "");

// ---- POST /api/posts/:id/payment ----
paymentRoutes.post("/posts/:id{[0-9]+}/payment", requireAuth, async (c) => {
  const postId = Number(c.req.param("id"));
  const agent = c.var.agent!;
  const db = c.var.db;
  const [post] = await db
    .select({ id: posts.id, agentId: posts.agentId, title: posts.title, placement: posts.placement, status: posts.status, paidAt: posts.paidAt })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  if (!post || post.agentId !== agent.id) return c.json({ error: "Зар олдсонгүй" }, 404);
  if (post.paidAt) return c.json({ paid: true });
  if (agent.role === "admin") return c.json({ paid: true }); // админы зар төлбөргүй (paid_at үүсгэхэд тавигдана)

  const mode = qpayMode(c.env);
  if (!mode) return c.json({ error: "Төлбөрийн систем түр ажиллахгүй байна. Дараа дахин оролдоно уу" }, 503);
  const provider = mode === "mock" ? "mock" : "qpay";
  const { items, total } = priceFor(post.placement);

  // ижил дүнтэй, саяхны, мөн горимын нэхэмжлэх байвал түүнийгээ (QR нь хэвээр)
  const open = await db
    .select()
    .from(payments)
    .where(and(eq(payments.postId, postId), eq(payments.status, "pending")))
    .orderBy(desc(payments.createdAt));
  const reusable = open.find((p) => p.amount === total && p.provider === provider && p.invoiceId && Date.now() - +p.createdAt < INVOICE_REUSE_MS);
  if (reusable) {
    const fresh = await refresh(c, reusable);
    if (fresh.status === "paid") return c.json({ paid: true, payment: view(fresh) });
    return c.json({ payment: view(fresh) });
  }
  // хуучин нэхэмжлэхүүдийг хаана (дүн өөрчлөгдсөн, хугацаа дууссан)
  for (const p of open) {
    const fresh = await refresh(c, p); // хаахаас өмнө төлөгдсөн эсэхийг шалгана
    if (fresh.status === "paid") return c.json({ paid: true, payment: view(fresh) });
    if (p.invoiceId) await cancelInvoice(c.env, p.invoiceId);
    await db.update(payments).set({ status: "cancelled" }).where(and(eq(payments.id, p.id), eq(payments.status, "pending")));
  }

  const senderInvoiceNo = `P${postId}-${crypto.randomUUID().slice(0, 12)}`;
  const [row] = await db
    .insert(payments)
    .values({ postId, agentId: agent.id, amount: total, items, provider, senderInvoiceNo })
    .returning();
  try {
    const inv = await createInvoice(c.env, {
      senderInvoiceNo,
      amount: total,
      description: `ProperTech зар #${postId}: ${post.title}`,
      callbackUrl: `${publicApiUrl(c)}/api/payments/qpay/callback/${encodeURIComponent(callbackSecret(c))}/${row!.id}`,
    });
    const [saved] = await db
      .update(payments)
      .set({ invoiceId: inv.invoiceId, qrText: inv.qrText, qrImage: inv.qrImage, shortUrl: inv.shortUrl, links: inv.links })
      .where(eq(payments.id, row!.id))
      .returning();
    return c.json({ payment: view(saved!) }, 201);
  } catch (e) {
    await db.update(payments).set({ status: "cancelled" }).where(eq(payments.id, row!.id));
    console.error("QPay invoice:", e);
    if (e instanceof QpayConfigError) return c.json({ error: "Төлбөрийн систем түр ажиллахгүй байна. Дараа дахин оролдоно уу" }, 503);
    return c.json({ error: "QPay нэхэмжлэх үүсгэж чадсангүй. Түр хүлээгээд дахин оролдоно уу" }, 502);
  }
});

// ---- GET /api/payments (админ): сүүлийн төлбөрүүд + орлого ----
paymentRoutes.get("/payments", requireAdmin, async (c) => {
  const db = c.var.db;
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const [rows, [totals], [month]] = await Promise.all([
    db
      .select({
        id: payments.id, postId: payments.postId, postTitle: posts.title, agentName: agents.name, amount: payments.amount,
        items: payments.items, status: payments.status, provider: payments.provider, paidAt: payments.paidAt, createdAt: payments.createdAt,
      })
      .from(payments)
      .leftJoin(posts, eq(payments.postId, posts.id))
      .leftJoin(agents, eq(payments.agentId, agents.id))
      .orderBy(desc(payments.createdAt))
      .limit(200),
    db
      .select({ total: sql<number>`coalesce(sum(${payments.amount}), 0)`, count: sql<number>`count(*)` })
      .from(payments)
      .where(and(eq(payments.status, "paid"), eq(payments.provider, "qpay"))),
    db
      .select({ total: sql<number>`coalesce(sum(${payments.amount}), 0)` })
      .from(payments)
      .where(and(eq(payments.status, "paid"), eq(payments.provider, "qpay"), gte(payments.paidAt, monthStart))),
  ]);
  return c.json(
    { payments: rows, summary: { paidTotal: totals!.total, paidCount: totals!.count, paidThisMonth: month!.total, mode: qpayMode(c.env) } },
    200,
    { "cache-control": "no-store" },
  );
});

// эзэн агент эсвэл админ
async function findVisible(c: Context<AppEnv>, id: number) {
  const [p] = await c.var.db.select().from(payments).where(eq(payments.id, id)).limit(1);
  const agent = c.var.agent!;
  return p && (agent.role === "admin" || p.agentId === agent.id) ? p : null;
}

// ---- GET /api/payments/:id ----
paymentRoutes.get("/payments/:id{[0-9]+}", requireAuth, async (c) => {
  const p = await findVisible(c, Number(c.req.param("id")));
  if (!p) return c.json({ error: "Төлбөр олдсонгүй" }, 404);
  return c.json({ payment: view(await refresh(c, p)) }, 200, { "cache-control": "no-store" });
});

// ---- POST /api/payments/:id/mock-pay (зөвхөн mock горимд) ----
paymentRoutes.post("/payments/:id{[0-9]+}/mock-pay", requireAuth, async (c) => {
  if (qpayMode(c.env) !== "mock") return c.json({ error: "Not found" }, 404);
  const p = await findVisible(c, Number(c.req.param("id")));
  if (!p || p.provider !== "mock") return c.json({ error: "Төлбөр олдсонгүй" }, 404);
  if (p.status === "cancelled") return c.json({ error: "Энэ нэхэмжлэх хаагдсан" }, 409);
  return c.json({ payment: view(await markPaid(c.var.db, p, `MOCK-${Date.now()}`)) });
});

// ---- QPay callback ----
// QPay энэ URL-ийг төлбөр орсны дараа дууддаг. Агуулгад нь итгэхгүй: нууц үгийг шалгаад QPay-ээс өөрөө дахин шалгана.
const callback = async (c: Context<AppEnv>) => {
  const secret = callbackSecret(c);
  if (!secret || c.req.param("secret") !== secret) return c.text("FORBIDDEN", 403);
  const [p] = await c.var.db.select().from(payments).where(eq(payments.id, Number(c.req.param("id")))).limit(1);
  if (p) await refresh(c, p);
  return c.text("SUCCESS");
};
paymentRoutes.get("/payments/qpay/callback/:secret/:id{[0-9]+}", callback);
paymentRoutes.post("/payments/qpay/callback/:secret/:id{[0-9]+}", callback);
